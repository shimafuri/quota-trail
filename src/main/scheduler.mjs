// 周期実行（設計書 §4.5）
// - setTimeout の再帰。各 tick で config.pollIntervalSec を読み直す
// - Claude と Codex を並行取得し、4 行を 1 トランザクションで insert
// - single-flight。起動直後に 1 回即時実行
// - 失敗してもバックオフしない。HTTP 429 のときだけ次回まで 2 倍
import { fetchClaudeSamples } from './providers/claude.mjs';
import { fetchCodexSamples } from './providers/codex.mjs';
import { errorSamples } from './lib/normalize.mjs';
import * as logger from './logger.mjs';

export const MIN_INTERVAL_SEC = 30;

/**
 * @param {Object} deps
 * @param {{insertSamples: (s:any[])=>number}} deps.db
 * @param {() => {pollIntervalSec:number}} deps.readConfig
 * @param {(samples:any[]) => void} [deps.onSamples]  insert 後のフック（トレイ更新など）
 */
export function createScheduler({ db, readConfig, onSamples }) {
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  let inFlight = false;
  let stopped = false;
  let doubleNextInterval = false;
  /** @type {number|null} */
  let lastTickAt = null;

  async function tick() {
    if (inFlight) return null;
    inFlight = true;
    const observedAt = Date.now();
    const cfg = readConfig();
    const intervalSec = Math.max(MIN_INTERVAL_SEC, cfg.pollIntervalSec);
    try {
      const [claudeR, codexR] = await Promise.allSettled([
        fetchClaudeSamples({ observedAt, intervalSec }),
        fetchCodexSamples({ observedAt, intervalSec }),
      ]);
      const claude = claudeR.status === 'fulfilled'
        ? claudeR.value
        : errorSamples('claude', { observedAt, intervalSec, errorCode: 'network' });
      const codex = codexR.status === 'fulfilled'
        ? codexR.value
        : errorSamples('codex', { observedAt, intervalSec, errorCode: 'network' });
      const samples = [...claude, ...codex];

      if (samples.some((s) => s.errorCode === 'http_429')) doubleNextInterval = true;

      try {
        db.insertSamples(samples);
      } catch (e) {
        logger.error('サンプルの保存に失敗', { error: String(e && e.message ? e.message : e) });
      }
      lastTickAt = observedAt;
      logger.info('tick', {
        observedAt,
        intervalSec,
        results: samples.map((s) => `${s.provider}/${s.window}=${s.status === 'ok' ? `${s.usedPercent}%` : s.errorCode}`).join(' '),
      });
      try { onSamples?.(samples); } catch { /* noop */ }
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, ms);
  }

  async function loop() {
    try {
      await tick();
    } catch (e) {
      logger.error('tick で例外', { error: String(e && e.message ? e.message : e) });
    }
    scheduleNext();
  }

  return {
    /** 起動。即時に 1 回 tick する */
    start() {
      stopped = false;
      void loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
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
  };
}
