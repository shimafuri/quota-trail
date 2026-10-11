// 周期実行（設計書 §4.5 / §15.4）
// - setTimeout の再帰。各 tick で config.pollIntervalSec を読み直す
// - Claude と Codex を並行取得し、5 行を 1 トランザクションで insert
// - single-flight。起動直後に 1 回即時実行
// - 失敗してもバックオフしない。実際の usage HTTP 429 のときだけ次回まで 2 倍
//   （ローカル期限判定・401 抑止の error 行は http_429 ではないので倍間隔にしない）
import { defaultClaudeProvider } from './providers/claude.mjs';
import { fetchCodexSamples } from './providers/codex.mjs';
import { errorSamples } from './lib/normalize.mjs';
import * as defaultLogger from './logger.mjs';

export const MIN_INTERVAL_SEC = 30;

/**
 * @param {Object} deps
 * @param {{insertSamples: (s:any[])=>number, recordPoll?: (batches:any[])=>number}} deps.db
 * @param {() => {pollIntervalSec:number}} deps.readConfig
 * @param {(samples:any[], batches:any[]) => void} [deps.onSamples]  insert 後のフック（トレイ更新など）
 * @param {{fetchSamples:(ctx:{observedAt:number, intervalSec:number}) => Promise<any>}} [deps.claudeProvider]
 *   起動 probe と同じ Claude provider インスタンス（profile 要求と 401 latch を共有する）
 * @param {(ctx:{observedAt:number, intervalSec:number}) => Promise<any>} [deps.fetchCodex]
 * @param {{observeClaudeBatch?:(batch:any) => void}} [deps.authObserver]  Claude 認証監視（monitor）
 * @param {() => number} [deps.now]
 * @param {(fn:() => any, ms:number) => any} [deps.setTimer]
 * @param {(handle:any) => void} [deps.clearTimer]
 * @param {{info:Function, warn:Function, error:Function}} [deps.logger]
 */
export function createScheduler({
  db,
  readConfig,
  onSamples,
  claudeProvider = defaultClaudeProvider,
  fetchCodex = fetchCodexSamples,
  authObserver,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  logger = defaultLogger,
}) {
  /** @type {any} */
  let timer = null;
  let inFlight = false;
  let stopped = false;
  let doubleNextInterval = false;
  /** @type {number|null} */
  let lastTickAt = null;
  /** setTimeout で予定していた発火時刻（PC スリープ復帰などの遅延検出用） */
  let nextTickPlannedAt = null;
  let nextTickIntervalMs = null;

  async function tick() {
    if (inFlight) return null;
    inFlight = true;
    const observedAt = now();
    const cfg = readConfig();
    const intervalSec = Math.max(MIN_INTERVAL_SEC, cfg.pollIntervalSec);
    try {
      const [claudeR, codexR] = await Promise.allSettled([
        claudeProvider.fetchSamples({ observedAt, intervalSec }),
        fetchCodex({ observedAt, intervalSec }),
      ]);
      const claude = claudeR.status === 'fulfilled'
        ? claudeR.value
        : {
          provider: 'claude',
          samples: errorSamples('claude', { observedAt, intervalSec, errorCode: 'network' }),
          identity: null,
        };
      const codex = codexR.status === 'fulfilled'
        ? codexR.value
        : {
          provider: 'codex',
          samples: errorSamples('codex', { observedAt, intervalSec, errorCode: 'network' }),
          identity: null,
        };
      const batches = [claude, codex];
      const samples = batches.flatMap((b) => b.samples);

      // 実際の HTTP 429 だけを倍間隔の契機にする（auth_expired_local / auth_expiring / 401 抑止は対象外）
      if (samples.some((s) => s.errorCode === 'http_429')) doubleNextInterval = true;

      try {
        if (typeof db.recordPoll === 'function') db.recordPoll(batches);
        else db.insertSamples(samples);
      } catch (e) {
        logger.error('サンプルの保存に失敗', { error: String(e && e.message ? e.message : e) });
      }
      lastTickAt = observedAt;
      logger.info('tick', {
        observedAt,
        intervalSec,
        results: samples.map((s) => `${s.provider}/${s.window}=${s.status === 'ok' ? `${s.usedPercent}%` : s.errorCode}`).join(' '),
      });
      try { authObserver?.observeClaudeBatch?.(claude); } catch { /* 監視の例外で tick を止めない */ }
      try { onSamples?.(samples, batches); } catch { /* noop */ }
      return samples;
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    const cfg = readConfig();
    let ms = Math.max(MIN_INTERVAL_SEC, cfg.pollIntervalSec) * 1000;
    if (doubleNextInterval) {
      ms *= 2;
      doubleNextInterval = false;
      logger.warn('429 を受けたため次回だけ間隔を 2 倍にする', { ms });
    }
    if (timer) clearTimer(timer);
    nextTickPlannedAt = now() + ms;
    nextTickIntervalMs = ms;
    timer = setTimer(loop, ms);
  }

  async function loop() {
    if (nextTickPlannedAt !== null && nextTickIntervalMs !== null) {
      const delayMs = now() - nextTickPlannedAt;
      if (delayMs > nextTickIntervalMs * 2) {
        logger.warn('tick が遅延', { delaySec: Math.round(delayMs / 1000) });
      }
    }
    nextTickPlannedAt = null;
    nextTickIntervalMs = null;
    try {
      await tick();
    } catch (e) {
      logger.error('tick で例外', { error: String(e && e.message ? e.message : e) });
    }
    scheduleNext();
  }

  return {
    /** 起動。即時に 1 回 tick する。完了を待ちたい場合は返り値の Promise を使う */
    start() {
      stopped = false;
      return loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** 手動実行（進行中なら無視）。実行後にタイマーを張り直す */
    async runNow() {
      if (inFlight) return null;
      const r = await tick().catch((e) => {
        logger.error('手動 tick で例外', { error: String(e && e.message ? e.message : e) });
        return null;
      });
      scheduleNext();
      return r;
    },
    isRunning: () => inFlight,
    lastTick: () => lastTickAt,
    /** 次回予定の発火時刻（未予定なら null） */
    nextTickAt: () => nextTickPlannedAt,
  };
}
