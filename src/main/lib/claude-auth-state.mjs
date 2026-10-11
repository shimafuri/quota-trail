// Claude 認証状態の判定（設計書 §15.4 / §15.6）。純粋関数のみ。I/O・account lookup は持たない。
// - expiresAt は有限の正の数値（epoch ms、2000-01-01 以降）だけを有効とする。文字列・秒らしい値は暗黙変換しない
// - 判定順序: 資格情報なし/破損 → 同一 token の usage 401 → ローカル期限切れ → 30 秒以内の期限 → 通常取得
// - 一度 expired と判定した同じ token は、時計が戻っても送信を再開しない（呼び出し側が latch を渡す）

/** 期限直前の安全余裕（通信途中での失効を避ける）。設定で変えない */
export const EXPIRY_SAFETY_MS = 30_000;

/** 有効な epoch ms の下限（2000-01-01T00:00:00Z）。それ未満は秒値などの不正メタデータ */
export const MIN_VALID_EXPIRES_AT_MS = Date.UTC(2000, 0, 1);

/** DB に保存しうる認証系 error code（§15.6）。auth_expired は従来の HTTP 401/403 */
export const CLAUDE_AUTH_ERROR_CODES = Object.freeze(['auth_expired_local', 'auth_expiring', 'auth_expired']);

/**
 * @typedef {'valid'|'expiring'|'expired'|'rejected'|'missing'|'invalid'|'unknown_expiry'} ClaudeAuthState
 */

/**
 * @typedef {Object} ClaudeAuthClassification
 * @property {ClaudeAuthState} state
 * @property {boolean} blocked       true なら usage/profile とも要求しない
 * @property {string|null} errorCode Claude 3 行に書く error code（通常取得なら null）
 * @property {'local'|'cached_401'|null} source 抑止の根拠
 */

/**
 * `claudeAiOauth.expiresAt` の値を検証する。
 * @param {unknown} value
 * @returns {{expiresAt:number|null, reason:null|'missing_expiry'|'invalid_expiry'}}
 */
export function parseExpiresAt(value) {
  if (value === undefined || value === null) {
    return { expiresAt: null, reason: 'missing_expiry' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_VALID_EXPIRES_AT_MS) {
    return { expiresAt: null, reason: 'invalid_expiry' };
  }
  return { expiresAt: value, reason: null };
}

/**
 * 資格情報スナップショットのメタデータと既知の 401/expiry から、HTTP を送ってよいかを決める。
 * @param {Object} p
 * @param {number} p.now                 判定時刻（HTTP 開始直前の時刻）
 * @param {boolean} p.hasToken           access token があるか
 * @param {string|null} [p.credentialError]  読込失敗時の error code（'no_credentials' | 'parse'）
 * @param {number|null} [p.expiresAt]    parseExpiresAt 済みの値
 * @param {boolean} [p.rejected]         同一 token がこのプロセス中に usage 401 を受けたか
 * @param {boolean} [p.expiredLatched]   同一 token を以前 expired と判定したか
 * @returns {ClaudeAuthClassification}
 */
export function classifyClaudeAuth({ now, hasToken, credentialError = null, expiresAt = null, rejected = false, expiredLatched = false }) {
  if (!hasToken) {
    const code = credentialError === 'parse' ? 'parse' : 'no_credentials';
    return { state: code === 'parse' ? 'invalid' : 'missing', blocked: true, errorCode: code, source: 'local' };
  }
  if (rejected) {
    return { state: 'rejected', blocked: true, errorCode: 'auth_expired', source: 'cached_401' };
  }
  if (expiredLatched) {
    return { state: 'expired', blocked: true, errorCode: 'auth_expired_local', source: 'local' };
  }
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    if (expiresAt <= now) {
      return { state: 'expired', blocked: true, errorCode: 'auth_expired_local', source: 'local' };
    }
    if (expiresAt <= now + EXPIRY_SAFETY_MS) {
      return { state: 'expiring', blocked: true, errorCode: 'auth_expiring', source: 'local' };
    }
    return { state: 'valid', blocked: false, errorCode: null, source: null };
  }
  return { state: 'unknown_expiry', blocked: false, errorCode: null, source: null };
}

// ---------------------------------------------------------------- §15.12 期限超過後の確認送信（純粋な適格判定）
// 通常 gate（classifyClaudeAuth）とは分離する。ここでは「送ってよい窓か」「対照として使えるか」
// 「時計を信用できるか」「どの段を割り当てるか」だけを決め、予算・台帳・I/O は provider 側が持つ。

/** token ごとの確認送信の最大回数（設定で増やせない） */
export const MAX_EXPIRY_PROBES_PER_TOKEN = 1;

/** 予定遅延からの許容遅れ（秒）。早送りはしない */
export const EXPIRY_PROBE_WINDOW_SEC = 300;

/** 各段の送信予算消費上限（異なる token の件数） */
export const EXPIRY_PROBES_PER_STAGE = 4;

/** 実測セッションの最大観測期間（睡眠を含む経過時計で 7 日） */
export const EXPIRY_PROBE_SESSION_MAX_SEC = 7 * 24 * 60 * 60;

/** 壁時計と睡眠を含む経過時計の累積差の上限（これ以上なら時計補正疑い） */
export const EXPIRY_PROBE_CLOCK_DRIFT_LIMIT_MS = 60_000;

/**
 * 段の固定ラダー（割当順）。
 * @type {ReadonlyArray<{stage:'3m'|'30m'|'2h'|'6h'|'8h', targetDelaySec:number}>}
 */
export const EXPIRY_PROBE_STAGES = Object.freeze([
  Object.freeze({ stage: '3m', targetDelaySec: 180 }),
  Object.freeze({ stage: '30m', targetDelaySec: 1_800 }),
  Object.freeze({ stage: '2h', targetDelaySec: 7_200 }),
  Object.freeze({ stage: '6h', targetDelaySec: 21_600 }),
  Object.freeze({ stage: '8h', targetDelaySec: 28_800 }),
]);

/** 全段合計の送信予算 */
export const EXPIRY_PROBE_TOTAL_BUDGET = EXPIRY_PROBE_STAGES.length * EXPIRY_PROBES_PER_STAGE;

/**
 * 期限前の通常 usage が比較対照になり得る期限余裕か。
 * `30 秒 < expiresAt - requestStartedAt <= 2 × intervalSec + 30 秒`（両端の扱いは設計どおり）。
 * 鮮度は期限に対して評価し、probe 開始に対しては評価しない。
 * @param {{requestStartedAt:number, expiresAt:number|null, intervalSec:number}} p
 * @returns {boolean}
 */
export function isPreexpiryBaselineLead({ requestStartedAt, expiresAt, intervalSec }) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(intervalSec) || intervalSec <= 0) return false;
  const leadMs = expiresAt - requestStartedAt;
  return leadMs > EXPIRY_SAFETY_MS && leadMs <= 2 * intervalSec * 1000 + EXPIRY_SAFETY_MS;
}

/**
 * 割当段の窓に対する現在位置。`targetDelaySec <= now - expiresAt <= targetDelaySec + 300`（秒、両端を含む）。
 * @param {{now:number, expiresAt:number, targetDelaySec:number}} p
 * @returns {'before'|'open'|'late'}
 */
export function probeWindowPosition({ now, expiresAt, targetDelaySec }) {
  const expiredForMs = now - expiresAt;
  if (expiredForMs < targetDelaySec * 1000) return 'before';
  if (expiredForMs <= (targetDelaySec + EXPIRY_PROBE_WINDOW_SEC) * 1000) return 'open';
  return 'late';
}

/**
 * 時計の検査。対照の要求開始で記録した `(w0, e0)` を基準に累積差を見る（resume でも基準をリセットしない）。
 * - 睡眠を含む経過時計 E が取得不能 → `clock_unverified`
 * - 前回読取より W または E が後退、または `abs((W - W0) - (E - E0)) >= 60 秒` → `clock_suspect`
 * @param {{w0:number, e0:number, prevW:number, prevE:number, w:number, e:number|null}} p
 * @returns {null|'clock_suspect'|'clock_unverified'}
 */
export function checkProbeClock({ w0, e0, prevW, prevE, w, e }) {
  if (typeof e !== 'number' || !Number.isFinite(e)) return 'clock_unverified';
  if (!Number.isFinite(w) || w < prevW || e < prevE) return 'clock_suspect';
  if (Math.abs((w - w0) - (e - e0)) >= EXPIRY_PROBE_CLOCK_DRIFT_LIMIT_MS) return 'clock_suspect';
  return null;
}

/**
 * 次に割り当てる段。カーソル位置から順に、予算（消費済み + 予約中）が上限未満の段を選ぶ。満杯の段は飛ばす。
 * @param {{cursor:number, usedByStage:ReadonlyArray<number>}} p
 * @returns {number|null} EXPIRY_PROBE_STAGES の添字。全段満杯なら null
 */
export function pickProbeStage({ cursor, usedByStage }) {
  const n = EXPIRY_PROBE_STAGES.length;
  const start = Number.isInteger(cursor) ? ((cursor % n) + n) % n : 0;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    if ((usedByStage[idx] ?? 0) < EXPIRY_PROBES_PER_STAGE) return idx;
  }
  return null;
}

/**
 * 段別集計の評価（分析用）。受付割合は `200 / (200 + 401)` と分母を並記し、未観測は null（0% にしない）。
 * 判定済み 4 件未満の段は「観測件数不足」で、全拒否とは判定しない。429・未判定・skip は分母に入れない。
 * @param {{http200?:number, http401?:number}} stats
 * @returns {{decided:number, acceptanceRate:number|null, sufficient:boolean, allRejected:boolean}}
 */
export function summarizeProbeStage({ http200 = 0, http401 = 0 } = {}) {
  const decided = http200 + http401;
  const sufficient = decided >= EXPIRY_PROBES_PER_STAGE;
  return {
    decided,
    acceptanceRate: decided > 0 ? http200 / decided : null,
    sufficient,
    allRejected: sufficient && http200 === 0,
  };
}

/**
 * 案内通知を出すべきかを決める（token 世代ごとに期限前 1 回、期限切れ/401 で 1 回）。
 * lock 中の保留や unlock 時の 60 分制限は呼び出し側（monitor）の責務。
 * @param {Object} p
 * @param {number} p.now
 * @param {ClaudeAuthState} p.state
 * @param {number|null} p.expiresAt
 * @param {number} p.leadSec            期限の何秒前から案内するか
 * @param {{lead?:boolean, blocked?:boolean}} [p.notified]  この世代で既に案内した種類
 * @returns {'lead'|'blocked'|null}
 */
export function shouldNotifyClaudeAuth({ now, state, expiresAt, leadSec, notified = {} }) {
  if (state === 'expired' || state === 'rejected') {
    return notified.blocked ? null : 'blocked';
  }
  if (state !== 'valid' && state !== 'expiring') return null;
  if (notified.lead || notified.blocked) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const leadMs = Math.max(0, Number(leadSec) || 0) * 1000;
  return expiresAt - now <= leadMs ? 'lead' : null;
}
