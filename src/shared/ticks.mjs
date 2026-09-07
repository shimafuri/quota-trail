/**
 * 時間軸の目盛り計算（純粋関数）。
 * renderer（ブラウザ ES module）と node:test の両方から import されるため、
 * DOM / Node 固有 API には一切依存しない。
 *
 * @module shared/ticks
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 目盛り候補（設計 §7.4）。昇順。
 * @type {ReadonlyArray<number>}
 */
export const TIME_STEPS = Object.freeze([
  1 * MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  1 * HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  1 * DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
]);

/**
 * 目盛り間隔が `minPx` 以上になる最小のステップを返す。
 *
 * @param {number} rangeMs 表示範囲の長さ（ms）
 * @param {number} plotWidthPx プロット領域の幅（CSS px）
 * @param {number} [minPx=50] 目盛りの最小間隔（px）
 * @returns {number} ステップ（ms）
 */
export function pickTimeStep(rangeMs, plotWidthPx, minPx = 50) {
  const last = TIME_STEPS[TIME_STEPS.length - 1];
  if (!Number.isFinite(rangeMs) || rangeMs <= 0) return TIME_STEPS[0];
  if (!Number.isFinite(plotWidthPx) || plotWidthPx <= 0) return last;
  // 1 目盛りあたり最低 minPx 必要 → step / range * width >= minPx
  const minStep = (minPx / plotWidthPx) * rangeMs;
  for (const step of TIME_STEPS) {
    if (step >= minStep) return step;
  }
  return last;
}

/**
 * ローカル時刻でその日の 0:00 を返す。
 * @param {number} t epoch ms
 * @returns {number}
 */
function startOfLocalDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * ローカル時刻の日付を n 日進めた 0:00 を返す（DST 安全）。
 * @param {number} t epoch ms（ローカル 0:00 想定）
 * @param {number} n
 * @returns {number}
 */
function addLocalDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * ローカルカレンダー上の通し日番号（1970-01-01 ローカル = 0）。
 * 複数日ステップのアライメントを平行移動しても安定させるために使う。
 * @param {number} t epoch ms
 * @returns {number}
 */
function localDayIndex(t) {
  const d = new Date(t);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/**
 * `localDayIndex` の逆変換（ローカル 0:00 の epoch ms）。
 * @param {number} idx
 * @returns {number}
 */
function timeFromLocalDayIndex(idx) {
  const u = new Date(idx * DAY);
  const d = new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 0, 0, 0, 0);
  return d.getTime();
}

const MAX_TICKS = 20000;

/**
 * `[from, to]` に含まれる目盛り時刻の配列を返す。
 * 目盛りはローカル時刻基準でステップの倍数に揃える。
 * ステップが 1 日以上のときはローカル 0:00 に揃える。
 *
 * @param {number} from epoch ms
 * @param {number} to epoch ms
 * @param {number} stepMs ステップ（ms）
 * @returns {number[]} 昇順の目盛り時刻
 */
export function timeTicks(from, to, stepMs) {
  /** @type {number[]} */
  const out = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(stepMs)) return out;
  if (stepMs <= 0 || to < from) return out;

  if (stepMs >= DAY) {
    const days = Math.max(1, Math.round(stepMs / DAY));
    let idx = Math.floor(localDayIndex(from) / days) * days;
    for (let i = 0; i < MAX_TICKS; i++) {
      const t = timeFromLocalDayIndex(idx);
      if (t > to) break;
      if (t >= from) out.push(t);
      idx += days;
    }
    return out;
  }

  // 1 日未満: 候補ステップはすべて 1 日を割り切るので、ローカル 0:00 から刻む。
  // 日ごとに再アンカーすることで DST の 23h/25h 日でもズレない。
  let dayStart = startOfLocalDay(from);
  for (let d = 0; d < MAX_TICKS; d++) {
    const next = addLocalDays(dayStart, 1);
    for (let t = dayStart; t < next; t += stepMs) {
      if (t > to) return out;
      if (t >= from) {
        out.push(t);
        if (out.length >= MAX_TICKS) return out;
      }
    }
    if (next > to) break;
    dayStart = next;
  }
  return out;
}

/** @param {number} n */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 目盛りラベルの文字列。
 * - ステップ < 1d: `HH:mm`（日付が変わる最初の目盛りは `M/D HH:mm`）
 * - ステップ >= 1d: `M/D`
 *
 * @param {number} t epoch ms
 * @param {number} stepMs
 * @param {number|null} [prevTick] 直前の目盛り（無ければ null）
 * @returns {string}
 */
export function formatTickLabel(t, stepMs, prevTick = null) {
  const d = new Date(t);
  if (stepMs >= DAY) return `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const newDay =
    prevTick == null || startOfLocalDay(prevTick) !== startOfLocalDay(t);
  return newDay ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}

/**
 * ツールチップ等で使う短い日時（`9/7 03:24`）。
 * @param {number} t epoch ms
 * @returns {string}
 */
export function formatDateTime(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * `ref` と同じローカル日付なら `HH:mm`、そうでなければ `M/D HH:mm`。
 * リセットマーカー・ヘッダのチップ表示に使う。
 *
 * @param {number} t epoch ms
 * @param {number} ref 基準時刻（epoch ms）。通常は現在時刻
 * @returns {string}
 */
export function formatClockLabel(t, ref) {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = startOfLocalDay(t) === startOfLocalDay(ref);
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 残り時間の短い表示。
 * - 1 分未満: `1m未満`
 * - 1 時間未満: `12m`
 * - 1 日未満: `3h12m`
 * - それ以上: `2d5h`
 * - 0 以下（不正入力含む）: `0m`
 *
 * @param {number} ms 残り時間（ms）
 * @returns {string}
 */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms < MIN) return '1m未満';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return `${h}h${m}m`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return `${d}d${h}h`;
}
