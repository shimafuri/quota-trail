// Claude 認証の監視（設計書 §15.4 / §15.6）
// - 30 秒ごとに資格情報ファイルをローカルで読み直す。HTTP も DB insert も行わない
// - idle / ロック中も止めない（H-002）。ロック中は OS 通知だけを保留し、unlock 時に再評価して一度案内する
// - token 世代（config dir + access token の内部キー）ごとに状態遷移ログと案内を一度だけ出す
// - 内部キー・token・config dir はログ・通知・公開 DTO へ出さない
// - 期限超過後の確認送信（§15.12, requestKind:'expiry_probe'）の 200 は回復として扱わない。
//   state・blockedAt・通知済み状態を解除せず、claude_auth_recovered は新 token の通常 usage 成功だけ
import { shouldNotifyClaudeAuth } from './lib/claude-auth-state.mjs';
import * as defaultLogger from './logger.mjs';

export const MONITOR_INTERVAL_MS = 30_000;
const STILL_BLOCKED_LOG_INTERVAL_MS = 60 * 60_000;
const UNLOCK_NOTICE_MIN_INTERVAL_MS = 60 * 60_000;
const DEFAULT_LEAD_SEC = 600;

const GUIDANCE = 'Claude Code を通常起動して認証を更新してください。回復しない場合は再ログインしてください。';

/**
 * @typedef {Object} ClaudeAuthPublicStatus
 * @property {import('./lib/claude-auth-state.mjs').ClaudeAuthState|'pending'} state
 * @property {number|null} checkedAt
 * @property {number|null} expiresAt
 * @property {boolean} notificationsEnabled
 * @property {boolean} withinLead     期限前の案内時間帯に入っているか
 */

/**
 * @typedef {Object} Notifier
 * @property {(notice:{title:string, body:string, onClick?:() => void}) => void} show
 */

/**
 * @param {Object} deps
 * @param {() => import('./providers/claude.mjs').CredentialSnapshot} deps.readSnapshot
 * @param {{classify:(snap:any, at?:number) => import('./lib/claude-auth-state.mjs').ClaudeAuthClassification}} deps.provider
 *   scheduler と同じ Claude provider（401 / 期限切れ latch を共有する）
 * @param {() => {claudeAuthNotifications?:boolean, claudeAuthNoticeLeadSec?:number}} deps.readConfig
 * @param {Notifier} [deps.notifier]
 * @param {() => void} [deps.openDashboard]
 * @param {() => void} [deps.onStatusChange]  状態が変わったとき（トレイ更新など）
 * @param {() => void} [deps.requestImmediateTick]
 *   blocked（auth_expired_local / auth_expiring / latched 401 の auth_expired）だった token が
 *   新 token に切り替わったときに 1 回だけ呼ぶ。scheduler の `runNow()` を single-flight のまま
 *   呼ぶのは呼び出し側（index.mjs）の責務で、monitor は scheduler を直接 import しない（テストを純粋に保つ）
 * @param {() => number} [deps.now]
 * @param {(fn:() => void, ms:number) => any} [deps.setIntervalFn]
 * @param {(handle:any) => void} [deps.clearIntervalFn]
 * @param {{info:Function, warn:Function}} [deps.logger]
 * @param {number} [deps.intervalMs]
 */
export function createClaudeAuthMonitor({
  readSnapshot,
  provider,
  readConfig,
  notifier,
  openDashboard,
  onStatusChange,
  requestImmediateTick,
  now = () => Date.now(),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (handle) => clearInterval(handle),
  logger = defaultLogger,
  intervalMs = MONITOR_INTERVAL_MS,
}) {
  /** @type {any} */
  let timer = null;
  let locked = false;
  /** @type {number|null} */
  let lastUnlockNoticeAt = null;
  /** 1 つ前の世代が blocked のまま新 token へ切り替わったときの記録（recovered ログ用） */
  /** @type {{blockedAt:number}|null} */
  let recoveryPending = null;
  /** @type {ClaudeAuthPublicStatus} */
  let status = { state: 'pending', checkedAt: null, expiresAt: null, notificationsEnabled: true, withinLead: false };

  /**
   * 現在の token 世代。key は内部キーで、外へは出さない。
   * @type {null|{
   *   key:string, expiresAt:number|null, noticeKey:string,
   *   notified:{lead:boolean, blocked:boolean},
   *   metadataLogged:boolean, expiringLogged:boolean,
   *   blockedAt:number|null, lastStillBlockedLogAt:number|null,
   *   blockSourceHint:null|'http_401',
   * }}
   */
  let gen = null;

  function settings() {
    let cfg = {};
    try { cfg = readConfig() ?? {}; } catch { cfg = {}; }
    const leadSec = Number.isFinite(cfg.claudeAuthNoticeLeadSec) ? Number(cfg.claudeAuthNoticeLeadSec) : DEFAULT_LEAD_SEC;
    return { notificationsEnabled: cfg.claudeAuthNotifications !== false, leadSec };
  }

  function newGeneration(key, expiresAt) {
    return {
      key,
      expiresAt,
      noticeKey: `${expiresAt ?? 'unknown'}`,
      notified: { lead: false, blocked: false },
      metadataLogged: false,
      expiringLogged: false,
      blockedAt: null,
      lastStillBlockedLogAt: null,
      blockSourceHint: null,
    };
  }

  /**
   * 案内通知を組み立てる。UUID・メール・認証ファイルのパスは含めない。
   * @param {'lead'|'blocked'} kind
   * @param {string} state
   * @param {number|null} expiresAt
   * @param {number} at
   */
  function buildNotice(kind, state, expiresAt, at) {
    if (kind === 'lead') {
      const minutes = expiresAt !== null ? Math.max(0, Math.ceil((expiresAt - at) / 60_000)) : null;
      return {
        title: 'quota-trail: Claude の認証期限が近づいています',
        body: `${minutes !== null ? `あと約 ${minutes} 分で` : 'まもなく'}認証期限に達します。継続して使用率を記録するため、${GUIDANCE}`,
      };
    }
    // 期限後の一度の受付を否定する断言（「一切記録できません」等）は避ける（§15.12）
    const lead = state === 'rejected' ? 'Claude の認証エラーを受けました。' : 'Claude の認証期限に達しました。';
    return {
      title: 'quota-trail: Claude の認証更新待ち',
      body: `${lead}継続して使用率を記録するため、${GUIDANCE}`,
    };
  }

  function deliver(kind, state, expiresAt, at) {
    if (!notifier) return;
    const notice = buildNotice(kind, state, expiresAt, at);
    try {
      notifier.show({ ...notice, onClick: () => { try { openDashboard?.(); } catch { /* noop */ } } });
    } catch (e) {
      logger.warn('claude_auth_notice_failed', { provider: 'claude', error: String(e && e.message ? e.message : e) });
    }
  }

  /**
   * 通知の判定。ロック中は保留（印を付けない）。unlock 経由は 60 分に一度まで。
   * @param {any} cls
   * @param {number} at
   * @param {{notificationsEnabled:boolean, leadSec:number}} cfg
   * @param {boolean} fromUnlock
   */
  function maybeNotify(cls, at, cfg, fromUnlock) {
    if (!gen || !cfg.notificationsEnabled) return;
    const kind = shouldNotifyClaudeAuth({ now: at, state: cls.state, expiresAt: gen.expiresAt, leadSec: cfg.leadSec, notified: gen.notified });
    if (!kind) return;
    if (locked) return; // unlock 時に最新 snapshot で再評価する
    if (fromUnlock && lastUnlockNoticeAt !== null && at - lastUnlockNoticeAt < UNLOCK_NOTICE_MIN_INTERVAL_MS) {
      // 繰り返し unlock でも案内は 60 分に一度まで。抑止した分は tooltip / dashboard で確認できる
      gen.notified[kind] = true;
      if (kind === 'blocked') gen.notified.lead = true;
      return;
    }
    gen.notified[kind] = true;
    if (kind === 'blocked') gen.notified.lead = true;
    if (fromUnlock) lastUnlockNoticeAt = at;
    deliver(kind, cls.state, gen.expiresAt, at);
  }

  /**
   * 資格情報を読み直し、状態遷移ログと案内を処理する。例外は投げない。
   * @param {{fromUnlock?:boolean, blockHint?:string|null}} [options]
   *   blockHint: usage 401 を受けた token の内部キー（claude_auth_blocked の source を http_401 にする）
   * @returns {ClaudeAuthPublicStatus}
   */
  function checkNow({ fromUnlock = false, blockHint = null } = {}) {
    try {
      const at = now();
      const cfg = settings();
      const snap = readSnapshot();
      const cls = provider.classify(snap, at);
      const previousState = status.state;

      if (!snap?.token || !snap.key) {
        // 外部の原子的置換中などの一時不在でも世代は捨てない（新 token の検知で切り替える）
        status = { state: cls.state, checkedAt: at, expiresAt: null, notificationsEnabled: cfg.notificationsEnabled, withinLead: false };
        if (previousState !== status.state) onStatusChange?.();
        return status;
      }

      if (!gen || gen.key !== snap.key) {
        if (gen) {
          logger.info('claude_auth_credentials_changed', { provider: 'claude', checkedAt: at });
          if (gen.blockedAt !== null) recoveryPending = { blockedAt: gen.blockedAt };
          // blocked（auth_expired_local / auth_expiring / latched 401 の auth_expired）だった token から
          // 新 token へ切り替わったときだけ、次の予定 tick を待たず即時 tick を 1 回行う（発注者指示 2026-10-03）。
          // 有効なままの proactive refresh ではここを通らない（previousState が 'valid'/'unknown_expiry' のため）
          if (previousState === 'expired' || previousState === 'expiring' || previousState === 'rejected') {
            try { requestImmediateTick?.(); } catch (e) {
              logger.warn('claude_auth_recovery_tick_failed', { provider: 'claude', error: String(e && e.message ? e.message : e) });
            }
          }
        }
        gen = newGeneration(snap.key, snap.expiresAt);
      } else if (gen.expiresAt !== snap.expiresAt) {
        // 同じ token の期限だけの変更は新 token とみなさない（401 latch は解除しない）。案内の重複キーだけ更新する
        gen.expiresAt = snap.expiresAt;
        const noticeKey = `${snap.expiresAt ?? 'unknown'}`;
        if (noticeKey !== gen.noticeKey) {
          gen.noticeKey = noticeKey;
          gen.notified.lead = false;
          gen.expiringLogged = false;
        }
      }

      if (blockHint !== null && blockHint === gen.key) gen.blockSourceHint = 'http_401';

      if (snap.expiryReason && !gen.metadataLogged) {
        gen.metadataLogged = true;
        logger.warn('claude_auth_metadata_unknown', { provider: 'claude', reason: snap.expiryReason });
      }

      const blocked = cls.state === 'expired' || cls.state === 'rejected';
      const withinLead = !blocked
        && gen.expiresAt !== null
        && gen.expiresAt - at <= cfg.leadSec * 1000;

      if (withinLead && !gen.expiringLogged) {
        gen.expiringLogged = true;
        logger.info('claude_auth_expiring', { provider: 'claude', checkedAt: at, expiresAt: gen.expiresAt, source: 'local' });
      }

      if (blocked) {
        if (gen.blockedAt === null) {
          gen.blockedAt = at;
          gen.lastStillBlockedLogAt = at;
          const source = cls.state === 'rejected' ? (gen.blockSourceHint ?? 'cached_401') : 'local';
          logger.warn('claude_auth_blocked', {
            provider: 'claude', checkedAt: at, expiresAt: gen.expiresAt, errorCode: cls.errorCode, source,
          });
        } else if (gen.lastStillBlockedLogAt !== null && at - gen.lastStillBlockedLogAt >= STILL_BLOCKED_LOG_INTERVAL_MS) {
          gen.lastStillBlockedLogAt = at;
          logger.warn('claude_auth_still_blocked', {
            provider: 'claude', checkedAt: at, expiresAt: gen.expiresAt, errorCode: cls.errorCode,
            source: cls.state === 'rejected' ? 'cached_401' : 'local',
            blockedForSec: Math.round((at - gen.blockedAt) / 1000),
          });
        }
      }

      maybeNotify(cls, at, cfg, fromUnlock);

      status = { state: cls.state, checkedAt: at, expiresAt: gen.expiresAt, notificationsEnabled: cfg.notificationsEnabled, withinLead };
      if (previousState !== status.state) onStatusChange?.();
      return status;
    } catch (e) {
      // 監視の例外で tick やアプリを止めない
      logger.warn('claude_auth_monitor_failed', { provider: 'claude', error: String(e && e.message ? e.message : e) });
      return status;
    }
  }

  return {
    /** 監視を開始する。初回 check は即時に行う */
    start() {
      if (timer) return;
      checkNow();
      timer = setIntervalFn(() => { checkNow(); }, intervalMs);
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
    checkNow,
    /**
     * ロック状態を伝える。ロック中は OS 通知だけを保留し、監視と tick は止めない（H-002）。
     * @param {boolean} value
     */
    setLocked(value) {
      const wasLocked = locked;
      locked = Boolean(value);
      if (wasLocked && !locked) checkNow({ fromUnlock: true });
    },
    /**
     * scheduler の Claude batch を受け取る。HTTP 401 の遷移と、新 token の usage 成功（回復）をログにする。
     * 確認送信（requestKind:'expiry_probe'）の 200 は回復に数えない。旧世代の batch で現在世代の health を更新しない。
     * @param {{auth?:{key:string|null, source:string|null, requestKind?:string}, samples?:any[]} | null} batch
     */
    observeClaudeBatch(batch) {
      const auth = batch?.auth;
      if (!auth || !auth.key) return;
      if (!gen || gen.key !== auth.key || auth.source === 'http_401') {
        // 401 は 30 秒周期を待たずに遷移として扱う（ローカル再読込のみ。HTTP はしない）
        checkNow({ blockHint: auth.source === 'http_401' ? auth.key : null });
      }
      if (auth.source === 'http_ok' && auth.requestKind !== 'expiry_probe' && recoveryPending && gen && gen.key === auth.key) {
        const at = now();
        const firstObservedAt = batch.samples?.[0]?.observedAt ?? at;
        logger.info('claude_auth_recovered', {
          provider: 'claude', observedAt: firstObservedAt, blockedForSec: Math.round((at - recoveryPending.blockedAt) / 1000),
        });
        recoveryPending = null;
      }
    },
    /** @returns {ClaudeAuthPublicStatus} */
    publicStatus: () => ({ ...status }),
    isLocked: () => locked,
  };
}
