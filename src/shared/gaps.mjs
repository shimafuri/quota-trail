/**
 * 欠測（データが無い / error）区間の算出（純粋関数）。
 * renderer と node:test の両方から import されるため DOM / Node 固有 API に依存しない。
 *
 * @module shared/gaps
 */

/**
 * @typedef {Object} Sample
 * @property {number} observedAt epoch ms
 * @property {'claude'|'codex'} [provider]
 * @property {'5h'|'weekly'} [window]
 * @property {number|null} usedPercent
 * @property {number|null} resetsAt
 * @property {'ok'|'error'} status
 * @property {string|null} [errorCode]
 * @property {number} intervalSec
 */

/**
 * @typedef {Object} Gap
 * @property {number} from epoch ms
 * @property {number} to epoch ms
 */

const DEFAULT_INTERVAL_SEC = 180;

/**
 * @param {Sample} s
 * @returns {number} その行の想定間隔（ms）
 */
function intervalMs(s) {
  const sec = Number(s && s.intervalSec);
  return (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_INTERVAL_SEC) * 1000;
}

/**
 * 欠測区間を求める。
 *
 * 判定（設計 §7.4）:
 * - (a) 隣接する ok 点の間隔が `前の点の intervalSec × factor` を超える
 * - (b) `error` 行が覆う区間（連続する error はまとめ、前後の点まで伸ばす）
 * - (c) 表示範囲の先頭から最初の点まで
 * - (d) 最後の点から `now` まで（最後の点が閾値より古いとき）
 *
 * 返す区間は `[from, to]` にクリップし、重なりをマージした昇順の配列。
 *
 * @param {Sample[]} samples observedAt 昇順（順不同でも内部でソートする）
 * @param {{from:number,to:number,now?:number,factor?:number}} opts
 * @returns {Gap[]}
 */
export function computeGaps(samples, opts) {
  const from = opts.from;
  const to = opts.to;
  const now = Number.isFinite(opts.now) ? /** @type {number} */ (opts.now) : to;
  const factor = Number.isFinite(opts.factor) ? /** @type {number} */ (opts.factor) : 2.5;
  /** @type {Gap[]} */
  const gaps = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return gaps;

  const rows = (Array.isArray(samples) ? samples.slice() : []).filter(
    (s) => s && Number.isFinite(s.observedAt),
  );
  rows.sort((a, b) => a.observedAt - b.observedAt);

  // 表示範囲の終端は now を超えない（未来は「欠測」ではない）
  const rangeEnd = Math.min(to, Math.max(from, now));

  if (rows.length === 0) {
    return clipMerge([{ from, to: rangeEnd }], from, rangeEnd);
  }

  // (c) 先頭
  if (rows[0].observedAt > from) {
    gaps.push({ from, to: rows[0].observedAt });
  }

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];

    if (cur.status === 'error') {
      // (b) 連続する error 行をひとまとめにする
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].status === 'error') j++;
      const first = rows[i];
      const last = rows[j];
      const prev = i > 0 ? rows[i - 1] : null;
      const next = j + 1 < rows.length ? rows[j + 1] : null;
      const gFrom = prev ? prev.observedAt : first.observedAt - intervalMs(first);
      const gTo = next ? next.observedAt : last.observedAt + intervalMs(last);
      gaps.push({ from: gFrom, to: gTo });
      i = j;
      continue;
    }

    // (a) 隣接 ok 点の間隔が閾値超
    const nxt = rows[i + 1];
    if (nxt && nxt.status === 'ok') {
      const threshold = intervalMs(cur) * factor;
      if (nxt.observedAt - cur.observedAt > threshold) {
        gaps.push({ from: cur.observedAt, to: nxt.observedAt });
      }
    }
  }

  // (d) 末尾
  const last = rows[rows.length - 1];
  if (now - last.observedAt > intervalMs(last) * factor) {
    gaps.push({ from: last.observedAt, to: rangeEnd });
  }

  return clipMerge(gaps, from, rangeEnd);
}

/**
 * `[lo, hi]` にクリップし、重なり・隣接をマージする。
 * @param {Gap[]} gaps
 * @param {number} lo
 * @param {number} hi
 * @returns {Gap[]}
 */
function clipMerge(gaps, lo, hi) {
  /** @type {Gap[]} */
  const clipped = [];
  for (const g of gaps) {
    const a = Math.max(lo, Math.min(g.from, g.to));
    const b = Math.min(hi, Math.max(g.from, g.to));
    if (b > a) clipped.push({ from: a, to: b });
  }
  clipped.sort((x, y) => x.from - y.from);
  /** @type {Gap[]} */
  const out = [];
  for (const g of clipped) {
    const tail = out[out.length - 1];
    if (tail && g.from <= tail.to) {
      if (g.to > tail.to) tail.to = g.to;
    } else {
      out.push({ from: g.from, to: g.to });
    }
  }
  return out;
}

/**
 * 認証更新待ちの区間（設計 §15.6）。
 * @typedef {Object} AuthGap
 * @property {number} from epoch ms
 * @property {number} to epoch ms
 * @property {'auth_expired_local'|'auth_expiring'|'auth_expired'} reason
 */

/** 認証区間として扱う error code と hover の理由（§15.6） */
export const AUTH_GAP_REASON_LABELS = Object.freeze({
  auth_expired_local: 'ローカル期限切れ',
  auth_expiring: '期限間近',
  auth_expired: '認証エラー',
});

/**
 * 根拠のある認証区間だけを返す（`computeGaps()` の灰色帯に琥珀色の上端バーを重ねる用途）。
 *
 * - 開始は認証 error 行の `observedAt`
 * - 終了は `min(次行の observedAt, observedAt + intervalSec × factor, now, to)`。次行が無くても同じ上限
 * - 表示範囲に clip し、同じ理由で接する区間だけを merge する
 * - `http_429` や行が無い区間は含めない（灰色のまま）。error 後の長い停止へ理由を延ばさない
 *
 * @param {Sample[]} samples observedAt 昇順（順不同でも内部でソートする）
 * @param {{from:number,to:number,now?:number,factor?:number}} opts
 * @returns {AuthGap[]}
 */
export function computeAuthGaps(samples, opts) {
  const from = opts.from;
  const to = opts.to;
  const now = Number.isFinite(opts.now) ? /** @type {number} */ (opts.now) : to;
  const factor = Number.isFinite(opts.factor) ? /** @type {number} */ (opts.factor) : 2.5;
  /** @type {AuthGap[]} */
  const out = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;
  const hi = Math.min(to, now);
  if (!(hi > from)) return out;

  const rows = (Array.isArray(samples) ? samples.slice() : []).filter(
    (s) => s && Number.isFinite(s.observedAt),
  );
  rows.sort((a, b) => a.observedAt - b.observedAt);

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const reason = cur.status === 'error' ? cur.errorCode : null;
    if (!reason || !Object.prototype.hasOwnProperty.call(AUTH_GAP_REASON_LABELS, reason)) continue;
    const next = rows[i + 1];
    let end = cur.observedAt + intervalMs(cur) * factor;
    if (next && next.observedAt < end) end = next.observedAt;
    const a = Math.max(from, cur.observedAt);
    const b = Math.min(hi, end);
    if (!(b > a)) continue;
    const tail = out[out.length - 1];
    if (tail && tail.reason === reason && a <= tail.to) {
      if (b > tail.to) tail.to = b;
    } else {
      out.push({ from: a, to: b, reason: /** @type {AuthGap['reason']} */ (reason) });
    }
  }
  return out;
}
