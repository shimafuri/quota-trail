// 各プロバイダーの API 応答 → 共通 Sample への正規化（純粋関数のみ。I/O 禁止）
// 設計書 §4.1 / §4.2 / §4.4

/**
 * @typedef {'claude'|'codex'} Provider
 * @typedef {'5h'|'weekly'} WindowKey
 * @typedef {Object} Sample
 * @property {number} observedAt   epoch ms
 * @property {Provider} provider
 * @property {WindowKey} window
 * @property {number|null} usedPercent  0..100（使用済み %）
 * @property {number|null} resetsAt     epoch ms
 * @property {'ok'|'error'} status
 * @property {string|null} errorCode
 * @property {number} intervalSec
 */

/** @type {WindowKey[]} */
export const WINDOWS = ['5h', 'weekly'];
/** @type {Provider[]} */
export const PROVIDERS = ['claude', 'codex'];

/** 系列キー（API / DB / UI 共通） */
export function seriesKey(provider, window) {
  return `${provider}/${window}`;
}

/** すべての系列キーを設計書の順で返す */
export function allSeriesKeys() {
  return PROVIDERS.flatMap((p) => WINDOWS.map((w) => seriesKey(p, w)));
}

/**
 * 使用率を 0..100 に clamp。数値でなければ null。
 * @param {unknown} v
 * @returns {number|null}
 */
export function clampPercent(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * ISO 8601 文字列 → epoch ms。
 * @param {unknown} v
 * @returns {number|null}
 */
export function isoToMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * epoch 秒 → epoch ms。
 * @param {unknown} v
 * @returns {number|null}
 */
export function secondsToMs(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

/**
 * @param {Object} p
 * @param {number} p.observedAt
 * @param {Provider} p.provider
 * @param {WindowKey} p.window
 * @param {number} p.intervalSec
 * @param {number|null} [p.usedPercent]
 * @param {number|null} [p.resetsAt]
 * @param {string|null} [p.errorCode]
 * @returns {Sample}
 */
export function makeSample({ observedAt, provider, window, intervalSec, usedPercent = null, resetsAt = null, errorCode = null }) {
  const ok = errorCode === null && usedPercent !== null;
  return {
    observedAt,
    provider,
    window,
    usedPercent: ok ? usedPercent : null,
    resetsAt: ok ? resetsAt : null,
    status: ok ? 'ok' : 'error',
    errorCode: ok ? null : (errorCode ?? 'parse'),
    intervalSec,
  };
}

/**
 * 1 プロバイダー分の error 行（5h / weekly の 2 行）を作る。
 * @param {Provider} provider
 * @param {{observedAt:number, intervalSec:number, errorCode:string}} ctx
 * @returns {Sample[]}
 */
export function errorSamples(provider, { observedAt, intervalSec, errorCode }) {
  return WINDOWS.map((w) => makeSample({ observedAt, provider, window: w, intervalSec, errorCode }));
}

/**
 * Claude `GET /api/oauth/usage` の応答を正規化。
 * five_hour.utilization / resets_at(ISO), seven_day.utilization / resets_at
 * @param {any} json
 * @param {{observedAt:number, intervalSec:number}} ctx
 * @returns {Sample[]}
 */
export function normalizeClaude(json, { observedAt, intervalSec }) {
  if (!json || typeof json !== 'object') {
    return errorSamples('claude', { observedAt, intervalSec, errorCode: 'parse' });
  }
  /** @type {Array<[WindowKey, any]>} */
  const pairs = [
    ['5h', json.five_hour],
    ['weekly', json.seven_day],
  ];
  return pairs.map(([win, w]) => {
    if (!w || typeof w !== 'object') {
      return makeSample({ observedAt, provider: 'claude', window: win, intervalSec, errorCode: 'window_absent' });
    }
    const usedPercent = clampPercent(w.utilization);
    if (usedPercent === null) {
      return makeSample({ observedAt, provider: 'claude', window: win, intervalSec, errorCode: 'parse' });
    }
    return makeSample({
      observedAt,
      provider: 'claude',
      window: win,
      intervalSec,
      usedPercent,
      resetsAt: isoToMs(w.resets_at),
    });
  });
}

/**
 * Codex `GET /backend-api/codex/usage` の応答を正規化。
 * rate_limit.primary_window / secondary_window の {used_percent, reset_at(epoch 秒)}
 * @param {any} json
 * @param {{observedAt:number, intervalSec:number}} ctx
 * @returns {Sample[]}
 */
export function normalizeCodex(json, { observedAt, intervalSec }) {
  if (!json || typeof json !== 'object') {
    return errorSamples('codex', { observedAt, intervalSec, errorCode: 'parse' });
  }
  // rate_limit / rate_limits どちらの綴りでも受ける
  const rl = json.rate_limit ?? json.rate_limits ?? json;
  if (!rl || typeof rl !== 'object') {
    return errorSamples('codex', { observedAt, intervalSec, errorCode: 'parse' });
  }
  /** @type {Array<[WindowKey, any]>} */
  const pairs = [
    ['5h', rl.primary_window ?? rl.primary],
    ['weekly', rl.secondary_window ?? rl.secondary],
  ];
  const rows = pairs.map(([win, w]) => {
    if (!w || typeof w !== 'object') {
      return makeSample({ observedAt, provider: 'codex', window: win, intervalSec, errorCode: 'window_absent' });
    }
    const usedPercent = clampPercent(w.used_percent ?? w.usedPercent);
    if (usedPercent === null) {
      return makeSample({ observedAt, provider: 'codex', window: win, intervalSec, errorCode: 'parse' });
    }
    return makeSample({
      observedAt,
      provider: 'codex',
      window: win,
      intervalSec,
      usedPercent,
      resetsAt: secondsToMs(w.reset_at ?? w.resets_at),
    });
  });
  // 両方とも読めなければ応答形不一致とみなす（呼び出し側が app-server にフォールバックする）
  return rows;
}

/**
 * `codex app-server` の `account/rateLimits/read` 結果を正規化。
 * rateLimits.primary/secondary の {usedPercent, resetsAt(epoch 秒)}
 * @param {any} result
 * @param {{observedAt:number, intervalSec:number}} ctx
 * @returns {Sample[]}
 */
export function normalizeCodexAppServer(result, { observedAt, intervalSec }) {
  if (!result || typeof result !== 'object') {
    return errorSamples('codex', { observedAt, intervalSec, errorCode: 'parse' });
  }
  const rl = result.rateLimits ?? result.rate_limits ?? result;
  if (!rl || typeof rl !== 'object') {
    return errorSamples('codex', { observedAt, intervalSec, errorCode: 'parse' });
  }
  /** @type {Array<[WindowKey, any]>} */
  const pairs = [
    ['5h', rl.primary ?? rl.primary_window],
    ['weekly', rl.secondary ?? rl.secondary_window],
  ];
  return pairs.map(([win, w]) => {
    if (!w || typeof w !== 'object') {
      return makeSample({ observedAt, provider: 'codex', window: win, intervalSec, errorCode: 'window_absent' });
    }
    const usedPercent = clampPercent(w.usedPercent ?? w.used_percent);
    if (usedPercent === null) {
      return makeSample({ observedAt, provider: 'codex', window: win, intervalSec, errorCode: 'parse' });
    }
    // app-server の resetsAt は epoch 秒
    return makeSample({
      observedAt,
      provider: 'codex',
      window: win,
      intervalSec,
      usedPercent,
      resetsAt: secondsToMs(w.resetsAt ?? w.reset_at),
    });
  });
}

/**
 * 正規化結果が「1 系列も読めていない」か（= 応答形不一致）。
 * @param {Sample[]} samples
 */
export function allFailed(samples) {
  return samples.length > 0 && samples.every((s) => s.status === 'error');
}

/**
 * HTTP ステータス → errorCode
 * @param {number} status
 */
export function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'auth_expired';
  return `http_${status}`;
}
