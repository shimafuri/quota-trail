// 期限超過後の確認送信の予算・台帳・段割当・専用ログ（設計書 §15.12）
// - `claudeExpiredUsageProbe:'once'` のときだけ働く。'off'（既定）では台帳も作らず、旧段階 A と同じ挙動
// - 期限前の最後の通常 usage 成功を比較対照とし、token ごとに 3m → 30m → 2h → 6h → 8h → 3m… の一段を割り当てる
// - 割当段の窓（予定から 0〜300 秒）の最初の呼出しで usage を 1 回だけ送る。予算は fetch 前に同期的に消費する
// - 新 token・config dir 切替・期限改変・資格情報の読取失敗・設定変更・既知 401・時計不適格・窓超過で
//   未使用予算を永久失効させる。同じ値へ戻っても復活させない
// - 予算台帳は access token 単体の SHA-256 で記憶し、profile/cache の内部キー（config dir 込み）とは分ける。
//   128 件の非削除台帳で、上限時は既存記録を捨てずにこのプロセスの確認送信を停止して設定 off にする
// - token・fingerprint・内部キー・config dir・UUID・メール・HTTP body/headers はログへ渡さない
import { createHash } from 'node:crypto';
import {
  EXPIRY_PROBE_STAGES,
  EXPIRY_PROBE_WINDOW_SEC,
  EXPIRY_PROBE_SESSION_MAX_SEC,
  EXPIRY_PROBE_TOTAL_BUDGET,
  checkProbeClock,
  isPreexpiryBaselineLead,
  pickProbeStage,
  probeWindowPosition,
} from '../lib/claude-auth-state.mjs';

/** 非削除台帳の上限件数（A→B→A・cache 除去で予算や 401 禁止が復活しないための記録） */
export const EXPIRY_PROBE_LEDGER_MAX_ENTRIES = 128;

/** 停止理由のうち warn で記録するもの */
const WARN_DISABLE_REASONS = new Set(['probe_429', 'ledger_full']);
/** 結果のうち warn で記録するもの */
const WARN_OUTCOMES = new Set(['http_401', 'http_429', 'network', 'timeout']);

/** @param {number} value */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {any} e */
function errorText(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * @typedef {Object} ProbeStageStats
 * @property {number} assigned
 * @property {number} spent
 * @property {number} http200
 * @property {number} http401
 * @property {number} undetermined   429・status 未確認の network/timeout・その他 HTTP（受付分母に入れない）
 * @property {number} useful         正常窓を 1 つ以上含む 200
 * @property {Record<string, number>} skipped  割当後の未送信失効（理由別）
 * @property {number|null} minExpiredForSec
 * @property {number|null} maxExpiredForSec
 * @property {number} slept          suspend を挟んだ送信件数
 */

/** @returns {ProbeStageStats} */
function newStageStats() {
  return {
    assigned: 0, spent: 0, http200: 0, http401: 0, undetermined: 0, useful: 0,
    skipped: {}, minExpiredForSec: null, maxExpiredForSec: null, slept: 0,
  };
}

/**
 * @param {Object} deps
 * @param {() => number} deps.now                       壁時計 W（epoch ms）
 * @param {() => number|null} deps.elapsedNow           睡眠を含む経過時計 E（ms）。取得不能なら null
 * @param {() => any} deps.readConfig                  claudeExpiredUsageProbe / pollIntervalSec を読む
 * @param {() => string} deps.userAgent                 要求条件（UA）の比較用
 * @param {{info:Function, warn:Function}} deps.logger
 * @param {() => boolean} deps.saveProbeOff             設定を off に保存する。失敗しても停止は解除しない
 */
export function createExpiryProbeController({ now, elapsedNow, readConfig, userAgent, logger, saveProbeOff }) {
  /**
   * 非削除台帳。キーは access token 単体の SHA-256（メモリ内限定）。
   * @type {Map<string, any>}
   */
  const ledger = new Map();
  /** 現在 credential の予約（最大 1 件） @type {string|null} */
  let pendingHash = null;
  /**
   * このプロセスの実測セッション。最初に once を観測した時点で開始し、OFF の期間も含めて 7 日で閉じる。
   * @type {null|{startedAtW:number, startedAtE:number|null, closed:boolean, closeReason:string|null,
   *   cursor:number, totalSpent:number, stats:ProbeStageStats[]}}
   */
  let session = null;
  /** @type {'off'|'once'} */
  let lastMode = 'off';
  /** 直近の token → hash（毎回 SHA-256 を計算しないための 1 件メモ） */
  let memo = { token: /** @type {string|null} */ (null), hash: /** @type {string|null} */ (null) };

  /** @param {string} token */
  function hashOf(token) {
    if (memo.token !== token) {
      memo = { token, hash: createHash('sha256').update(token).digest('hex') };
    }
    return /** @type {string} */ (memo.hash);
  }

  function readSettings() {
    let cfg = {};
    try { cfg = readConfig() ?? {}; } catch { cfg = {}; }
    return {
      mode: /** @type {'off'|'once'} */ (cfg.claudeExpiredUsageProbe === 'once' ? 'once' : 'off'),
      pollIntervalSec: Number.isFinite(cfg.pollIntervalSec) ? Number(cfg.pollIntervalSec) : null,
    };
  }

  function readElapsed() {
    try {
      const value = elapsedNow();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function currentUserAgent() {
    try { return String(userAgent()); } catch { return ''; }
  }

  function isActive() {
    return session !== null && !session.closed && lastMode === 'once';
  }

  /** @param {number} at */
  function sessionElapsedSec(at) {
    if (!session) return 0;
    const e = readElapsed();
    if (session.startedAtE !== null && e !== null && e >= session.startedAtE) {
      return (e - session.startedAtE) / 1000;
    }
    return Math.max(0, (at - session.startedAtW) / 1000);
  }

  /** 停止ログ用の段別件数（集計値のみ。割合は出さない） */
  function stagesSummary() {
    /** @type {Record<string, ProbeStageStats>} */
    const out = {};
    EXPIRY_PROBE_STAGES.forEach(({ stage }, idx) => {
      const s = session?.stats[idx] ?? newStageStats();
      out[stage] = { ...s, skipped: { ...s.skipped } };
    });
    return out;
  }

  /**
   * @param {string} reason
   * @param {number} at
   * @param {'off'|'once'} mode
   */
  function logDisabled(reason, at, mode) {
    const level = WARN_DISABLE_REASONS.has(reason) ? 'warn' : 'info';
    logger[level]('claude_auth_expiry_probe_disabled', {
      provider: 'claude',
      checkedAt: at,
      mode,
      reason,
      sessionStartedAt: session?.startedAtW ?? null,
      elapsedSec: round3(sessionElapsedSec(at)),
      stages: stagesSummary(),
    });
  }

  /**
   * セッションを閉じる（期間・予算・429・台帳上限）。同プロセスでは再開しない。設定 off も保存する。
   * @param {'time_limit'|'budget_limit'|'probe_429'|'ledger_full'} reason
   * @param {number} at
   */
  function closeSession(reason, at) {
    if (!session || session.closed) return;
    session.closed = true;
    session.closeReason = reason;
    voidPending('session_ended', at);
    logDisabled(reason, at, 'off');
    let saved = false;
    try { saved = saveProbeOff() === true; } catch { saved = false; }
    if (!saved) {
      // 保存に失敗してもメモリ上の停止は解除しない
      logger.warn('claude_auth_expiry_probe_config_save_failed', { provider: 'claude', reason });
    }
  }

  /**
   * once / off の切替と 7 日上限を処理する。
   * @param {number} at
   * @param {{mode:'off'|'once'}} settings
   */
  function syncSession(at, settings) {
    if (!session) {
      if (settings.mode !== 'once') return;
      session = {
        startedAtW: at, startedAtE: readElapsed(), closed: false, closeReason: null,
        cursor: 0, totalSpent: 0, stats: EXPIRY_PROBE_STAGES.map(newStageStats),
      };
      lastMode = 'once';
      logDisabled('configured_once', at, 'once');
      return;
    }
    if (session.closed) return;
    if (settings.mode !== lastMode) {
      lastMode = settings.mode;
      if (settings.mode === 'off') voidPending('configured_off', at);
      logDisabled(settings.mode === 'once' ? 'configured_once' : 'configured_off', at, settings.mode);
    }
    // 7 日境界ちょうどから新要求を禁止する（OFF の期間・睡眠も含む）
    if (sessionElapsedSec(at) >= EXPIRY_PROBE_SESSION_MAX_SEC) closeSession('time_limit', at);
  }

  /**
   * 台帳の entry を得る（無ければ作る）。上限なら既存記録を捨てずにセッションを閉じる。
   * @param {string} hash
   * @param {any} snap
   * @param {number} at
   */
  function ensureEntry(hash, snap, at) {
    let entry = ledger.get(hash);
    if (entry) return entry;
    if (ledger.size >= EXPIRY_PROBE_LEDGER_MAX_ENTRIES) {
      closeSession('ledger_full', at);
      return null;
    }
    entry = {
      configDir: snap.configDir,
      /** 'tracking' | 'pending' | 'spent' | 'void' */
      phase: 'tracking',
      reason: null,
      rejected: false,
      baseline: null,
      stageIndex: null,
      clock: null,
      skipLogged: false,
    };
    ledger.set(hash, entry);
    return entry;
  }

  /**
   * 未送信のまま失効させる（永久）。割当済みなら段別の skip 理由として数える。
   * @param {any} entry
   * @param {string} reason
   * @param {number} at
   * @param {any} [snap]
   */
  function voidEntry(entry, reason, at, snap) {
    const assigned = entry.phase === 'pending' && entry.stageIndex !== null;
    entry.phase = 'void';
    entry.reason = reason;
    if (assigned && session) {
      const skipped = session.stats[entry.stageIndex].skipped;
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
    if (entry.skipLogged) return;
    entry.skipLogged = true;
    const expiresAt = entry.baseline?.expiresAt ?? (Number.isFinite(snap?.expiresAt) ? snap.expiresAt : null);
    const stage = entry.stageIndex !== null ? EXPIRY_PROBE_STAGES[entry.stageIndex] : null;
    logger.info('claude_auth_expiry_probe_skipped', {
      provider: 'claude',
      mode: lastMode,
      checkedAt: at,
      expiresAt,
      expiredForSec: expiresAt !== null && at >= expiresAt ? round3((at - expiresAt) / 1000) : null,
      stage: stage?.stage ?? null,
      targetDelaySec: stage?.targetDelaySec ?? null,
      reason,
    });
  }

  /**
   * @param {string} reason
   * @param {number} at
   * @param {any} [snap]
   */
  function voidPending(reason, at, snap) {
    const hash = pendingHash;
    pendingHash = null;
    if (hash === null) return;
    const entry = ledger.get(hash);
    if (entry && entry.phase === 'pending') voidEntry(entry, reason, at, snap);
  }

  /**
   * 時計の検査（基準は対照の要求開始。resume でもリセットしない）。合格なら前回値を更新する。
   * @param {any} entry
   * @param {number} at
   */
  function checkClock(entry, at) {
    const c = entry.clock;
    const e = readElapsed();
    const problem = checkProbeClock({ w0: c.w0, e0: c.e0, prevW: c.prevW, prevE: c.prevE, w: at, e });
    if (!problem) {
      c.prevW = at;
      c.prevE = /** @type {number} */ (e);
      c.lastDeltaMs = (at - c.w0) - (/** @type {number} */ (e) - c.e0);
    }
    return problem;
  }

  /**
   * 予約中の token が送信条件を保っているか。問題があれば失効理由を返す。
   * @param {any} entry
   * @param {any} snap
   * @param {number} at
   * @param {{pollIntervalSec:number|null}} settings
   */
  function pendingProblem(entry, snap, at, settings) {
    if (entry.rejected) return 'cached_401';
    if (snap.configDir !== entry.configDir) return 'token_replaced';
    const b = entry.baseline;
    if (snap.expiresAt !== b.expiresAt) return 'expiry_changed';
    if (settings.pollIntervalSec !== b.pollIntervalSec || currentUserAgent() !== b.userAgent) return 'config_changed';
    const clockProblem = checkClock(entry, at);
    if (clockProblem) return clockProblem;
    const { targetDelaySec } = EXPIRY_PROBE_STAGES[entry.stageIndex];
    if (probeWindowPosition({ now: at, expiresAt: b.expiresAt, targetDelaySec }) === 'late') return 'late_probe';
    return null;
  }

  /**
   * スナップショットを観測する（monitor の 30 秒再読込・全取得経路・suspend/resume から）。
   * HTTP は送らず、予算も消費しない。不適格を確定したら未使用予算を失効させる。例外は投げない。
   * @param {any} snap
   * @param {number} at
   * @param {{state:string}|null} cls  通常 gate の判定
   */
  function observe(snap, at, cls) {
    try {
      const settings = readSettings();
      syncSession(at, settings);
      const token = snap?.token && snap.key ? snap.token : null;
      const hash = token ? hashOf(token) : null;
      if (pendingHash !== null) {
        if (hash === null) {
          voidPending('credential_unavailable', at, snap);
        } else if (hash !== pendingHash) {
          voidPending('token_replaced', at, snap);
        } else {
          const problem = pendingProblem(ledger.get(hash), snap, at, settings);
          if (problem) voidPending(problem, at, snap);
        }
      }
      if (!isActive() || hash === null) return;
      const entry = ensureEntry(hash, snap, at);
      if (!entry) return;
      if (entry.phase === 'tracking' && cls && (cls.state === 'expired' || cls.state === 'rejected')) {
        // 起動時/ON 時から expired、期限前の対照なし、既知 401 は要求ゼロ
        voidEntry(entry, cls.state === 'rejected' || entry.rejected ? 'cached_401' : 'no_preexpiry_success', at, snap);
      }
    } catch (e) {
      logger.warn('claude_auth_expiry_probe_failed', { provider: 'claude', error: errorText(e) });
    }
  }

  /**
   * 通常 usage の開始（有効 token の HTTP 直前）。対照候補の要求開始時刻と経過時計を控える。
   * once がこの要求開始時から有効なときだけ ticket を返す。
   * @param {any} snap
   * @param {number} at
   * @param {number} intervalSec
   */
  function beginNormalUsage(snap, at, intervalSec) {
    try {
      if (!isActive() || !snap?.token) return null;
      const hash = hashOf(snap.token);
      const entry = ensureEntry(hash, snap, at);
      if (!entry || (entry.phase !== 'tracking' && entry.phase !== 'pending')) return null;
      return {
        hash,
        requestStartedAt: at,
        e: readElapsed(),
        expiresAt: snap.expiresAt,
        intervalSec,
        userAgent: currentUserAgent(),
        pollIntervalSec: readSettings().pollIntervalSec,
      };
    } catch {
      return null;
    }
  }

  /**
   * 通常 usage の結果。期限前の最後の結果で対照を更新し、失敗なら不適格にする。初回の適格な成功で一段を割り当てる。
   * @param {any} ticket
   * @param {{status:number|null, httpOk:boolean, okWindowCount:number}} result
   */
  function finishNormalUsage(ticket, { status, httpOk, okWindowCount }) {
    try {
      if (!ticket) return;
      const entry = ledger.get(ticket.hash);
      if (!entry) return;
      if (status === 401) entry.rejected = true;
      if (!isActive() || (entry.phase !== 'tracking' && entry.phase !== 'pending')) return;
      const at = now();
      const eligible = httpOk && okWindowCount >= 1 && isPreexpiryBaselineLead({
        requestStartedAt: ticket.requestStartedAt, expiresAt: ticket.expiresAt, intervalSec: ticket.intervalSec,
      });
      if (!eligible) {
        if (entry.phase === 'pending') {
          if (pendingHash === ticket.hash) voidPending(status === 401 ? 'cached_401' : 'no_preexpiry_success', at);
        } else {
          entry.baseline = null;
        }
        return;
      }
      if (entry.phase === 'pending') {
        // 対照を最後の成功へ更新する。段・時計基準・assigned は再発行しない
        if (entry.baseline.expiresAt !== ticket.expiresAt) {
          if (pendingHash === ticket.hash) voidPending('expiry_changed', at);
          return;
        }
        entry.baseline.requestStartedAt = ticket.requestStartedAt;
        return;
      }
      if (ticket.e === null) {
        // 睡眠を含む経過時計が使えない環境では送信ゼロ（段割当前の不適格）
        voidEntry(entry, 'clock_unverified', at);
        return;
      }
      if (pendingHash !== null && pendingHash !== ticket.hash) voidPending('token_replaced', at);
      const s = /** @type {NonNullable<typeof session>} */ (session);
      const idx = pickProbeStage({ cursor: s.cursor, usedByStage: s.stats.map((st) => st.spent) });
      if (idx === null) {
        closeSession('budget_limit', at);
        return;
      }
      s.cursor = (idx + 1) % EXPIRY_PROBE_STAGES.length;
      s.stats[idx].assigned += 1;
      entry.phase = 'pending';
      entry.stageIndex = idx;
      entry.baseline = {
        requestStartedAt: ticket.requestStartedAt,
        expiresAt: ticket.expiresAt,
        userAgent: ticket.userAgent,
        pollIntervalSec: ticket.pollIntervalSec,
      };
      entry.clock = {
        w0: ticket.requestStartedAt, e0: ticket.e, prevW: ticket.requestStartedAt, prevE: ticket.e,
        lastDeltaMs: 0, suspendCount: 0, suspendedMs: /** @type {number|null} */ (0), suspendE: /** @type {number|null} */ (null),
      };
      pendingHash = ticket.hash;
      const { stage, targetDelaySec } = EXPIRY_PROBE_STAGES[idx];
      logger.info('claude_auth_expiry_probe_assigned', {
        provider: 'claude',
        mode: 'once',
        checkedAt: at,
        expiresAt: ticket.expiresAt,
        stage,
        targetDelaySec,
        windowEndDelaySec: targetDelaySec + EXPIRY_PROBE_WINDOW_SEC,
        lastUsageOkAt: ticket.requestStartedAt,
      });
      // 要求中の時計補正も検査する
      const problem = checkClock(entry, at);
      if (problem) voidPending(problem, at);
    } catch (e) {
      logger.warn('claude_auth_expiry_probe_failed', { provider: 'claude', error: errorText(e) });
    }
  }

  /**
   * 期限切れ token について、割当段の窓内なら予算を同期的に消費して送信 ticket を返す。
   * 下限前・不適格・予約なしは null（呼び出し側は auth_expired_local のまま）。
   * @param {any} snap
   * @param {number} at  HTTP 開始直前の壁時計
   * @param {number} intervalSec
   */
  function reserve(snap, at, intervalSec) {
    try {
      if (!snap?.token) return null;
      syncSession(at, readSettings());
      if (!isActive()) return null;
      const hash = hashOf(snap.token);
      if (hash !== pendingHash) return null;
      const entry = ledger.get(hash);
      if (!entry || entry.phase !== 'pending') return null;
      const problem = pendingProblem(entry, snap, at, readSettings());
      if (problem) {
        voidPending(problem, at, snap);
        return null;
      }
      const idx = entry.stageIndex;
      const { stage, targetDelaySec } = EXPIRY_PROBE_STAGES[idx];
      const b = entry.baseline;
      if (probeWindowPosition({ now: at, expiresAt: b.expiresAt, targetDelaySec }) !== 'open') return null;

      // 予算を fetch 前に同期的に消費する（失敗・送信成否不明・OFF→ON でも返さない）
      entry.phase = 'spent';
      pendingHash = null;
      const s = /** @type {NonNullable<typeof session>} */ (session);
      const stats = s.stats[idx];
      stats.spent += 1;
      s.totalSpent += 1;
      const c = entry.clock;
      const expiredForSec = round3((at - b.expiresAt) / 1000);
      stats.minExpiredForSec = stats.minExpiredForSec === null ? expiredForSec : Math.min(stats.minExpiredForSec, expiredForSec);
      stats.maxExpiredForSec = stats.maxExpiredForSec === null ? expiredForSec : Math.max(stats.maxExpiredForSec, expiredForSec);
      if (c.suspendCount > 0) stats.slept += 1;
      const fields = {
        provider: 'claude',
        mode: 'once',
        probeNo: 1,
        observedAt: null,
        requestStartedAt: at,
        expiresAt: b.expiresAt,
        stage,
        targetDelaySec,
        windowEndDelaySec: targetDelaySec + EXPIRY_PROBE_WINDOW_SEC,
        scheduleLateSec: round3(expiredForSec - targetDelaySec),
        expiredForSec,
        lastUsageOkAt: b.requestStartedAt,
        lastUsageOkAgeSec: round3((at - b.requestStartedAt) / 1000),
        preexpiryLeadSec: round3((b.expiresAt - b.requestStartedAt) / 1000),
        intervalSec,
        expiryStable: true,
        clockSuspect: false,
        clockDeltaSec: round3(c.lastDeltaMs / 1000),
        clockSource: 'sleep_inclusive',
        suspendCount: c.suspendCount,
        suspendedForSec: c.suspendedMs === null || c.suspendE !== null ? null : round3(c.suspendedMs / 1000),
      };
      return { hash, stageIndex: idx, requestStartedAt: at, fields };
    } catch (e) {
      logger.warn('claude_auth_expiry_probe_failed', { provider: 'claude', error: errorText(e) });
      return null;
    }
  }

  /**
   * 予約した確認送信の開始を記録する（observedAt は tick の値）。全段の予算を使い切ったらここで停止する。
   * @param {any} ticket
   * @param {number} observedAt
   */
  function start(ticket, observedAt) {
    ticket.fields.observedAt = observedAt;
    logger.info('claude_auth_expiry_probe_start', ticket.fields);
    if (session && session.totalSpent >= EXPIRY_PROBE_TOTAL_BUDGET) closeSession('budget_limit', ticket.requestStartedAt);
  }

  /**
   * 確認送信の結果。429 なら次の要求を許す前にセッションを止め、設定 off を保存する。
   * @param {any} ticket
   * @param {{outcome:'http_200'|'http_401'|'http_429'|'http_other'|'network'|'timeout',
   *   httpStatus:number|null, errorCode:string|null, durationMs:number, parseOk:boolean|null, okWindowCount:number}} result
   */
  function finish(ticket, result) {
    try {
      const stats = session?.stats[ticket.stageIndex];
      if (stats) {
        if (result.outcome === 'http_200') {
          stats.http200 += 1;
          if (result.okWindowCount > 0) stats.useful += 1;
        } else if (result.outcome === 'http_401') {
          stats.http401 += 1;
        } else {
          stats.undetermined += 1;
        }
      }
      if (result.outcome === 'http_401') {
        const entry = ledger.get(ticket.hash);
        if (entry) entry.rejected = true;
      }
      const level = WARN_OUTCOMES.has(result.outcome) ? 'warn' : 'info';
      logger[level]('claude_auth_expiry_probe_result', {
        ...ticket.fields,
        ...result,
        nextAction: result.outcome === 'http_401' ? 'cached_401' : 'local_gate',
      });
      if (result.outcome === 'http_429') closeSession('probe_429', now());
    } catch (e) {
      logger.warn('claude_auth_expiry_probe_failed', { provider: 'claude', error: errorText(e) });
    }
  }

  /**
   * 電源イベント。予約中の token に suspend 回数と、各対の `E_resume - E_suspend` の累積を記録する。
   * 対が欠けたら睡眠時間は null（0 と偽装しない）。gate の再評価は呼び出し側が続けて observe で行う。
   * @param {'suspend'|'resume'} kind
   */
  function notePowerEvent(kind) {
    try {
      const entry = pendingHash !== null ? ledger.get(pendingHash) : null;
      if (!entry || entry.phase !== 'pending' || !entry.clock) return;
      const c = entry.clock;
      const e = readElapsed();
      if (kind === 'suspend') {
        if (c.suspendE !== null) c.suspendedMs = null; // 前回の resume が欠けた
        c.suspendCount += 1;
        c.suspendE = e;
        if (e === null) c.suspendedMs = null;
      } else if (kind === 'resume') {
        if (c.suspendE === null) {
          // suspend を観測していない resume: 睡眠はあったが時間は不明
          c.suspendCount += 1;
          c.suspendedMs = null;
        } else if (e === null) {
          c.suspendedMs = null;
        } else if (c.suspendedMs !== null) {
          c.suspendedMs += Math.max(0, e - c.suspendE);
        }
        c.suspendE = null;
      }
    } catch (e) {
      logger.warn('claude_auth_expiry_probe_failed', { provider: 'claude', error: errorText(e) });
    }
  }

  /**
   * 台帳の既知 401（通常 gate にも cached_401 として渡す。cache/latch の除去と連動して捨てない）。
   * @param {string|null|undefined} token
   */
  function isRejected(token) {
    if (!token || ledger.size === 0) return false;
    return ledger.get(hashOf(token))?.rejected === true;
  }

  /** @param {string|null|undefined} token */
  function noteUsage401(token) {
    if (!token) return;
    const entry = ledger.get(hashOf(token));
    if (entry) entry.rejected = true;
  }

  return {
    observe,
    beginNormalUsage,
    finishNormalUsage,
    reserve,
    start,
    finish,
    notePowerEvent,
    isRejected,
    noteUsage401,
    /** テスト・診断用。秘密（token・hash・config dir）は含めない */
    status() {
      const pendingEntry = pendingHash !== null ? ledger.get(pendingHash) : null;
      return {
        mode: lastMode,
        active: isActive(),
        sessionStartedAt: session?.startedAtW ?? null,
        closedReason: session?.closeReason ?? null,
        cursor: session?.cursor ?? 0,
        totalSpent: session?.totalSpent ?? 0,
        ledgerSize: ledger.size,
        pendingStage: pendingEntry ? EXPIRY_PROBE_STAGES[pendingEntry.stageIndex].stage : null,
        stages: stagesSummary(),
      };
    },
  };
}
