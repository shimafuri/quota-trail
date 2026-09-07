/**
 * 過去に発生したリセット（quota window の切り替わり）の検出（純粋関数）。
 * renderer と node:test の両方から import されるため DOM / Node 固有 API には依存しない。
 *
 * @module shared/resets
 */

/** @typedef {import('./gaps.mjs').Sample} Sample */

/** `resetsAt` の秒未満〜数秒のゆらぎを許容する幅（ms） */
const JITTER_MS = 60_000;
/** 「使用率が目に見えて下がった」とみなす最小の低下幅（percentage points） */
const USAGE_DROP_PCT = 5;

/**
 * 隣接する ok サンプル間で「実際にリセットが起きた」時刻を検出する。
 *
 * `resetsAt` は API が返す「次のリセット予定時刻」であり、ウィンドウが未使用
 * （`usedPercent` が 0 に近い）だと `now + 窓の長さ` のような値をポーリングの
 * たびに返し続けるため、単に `resetsAt` が前と違う、というだけでは誤検出になる
 * （Codex の 5h ウィンドウが典型）。そこで:
 *
 * 1. 前の点 a の予告した `resetsAt` が a と b の間に実際に経過していれば
 *    （`a.resetsAt > a.observedAt && a.resetsAt <= b.observedAt`）、そこでリセットが
 *    起きたとみなし `a.resetsAt` を返す。
 * 2. (1) に当てはまらなくても、`b.resetsAt` が `a.resetsAt` よりジッター許容幅
 *    （`JITTER_MS`）を超えて前進しており、かつ使用率が目に見えて下がっている
 *    （`b.usedPercent < a.usedPercent - USAGE_DROP_PCT`）なら、予告時刻が多少ずれていた
 *    リセットとみなし `b.observedAt` を返す。
 * 3. それ以外（未使用ウィンドウの `resetsAt` が単に前進し続けているだけ、など）は
 *    リセットとみなさない。
 *
 * @param {Sample[]} samples 順不同でも内部でソートする
 * @returns {number[]} 検出したリセット時刻（epoch ms）。昇順
 */
export function pastResets(samples) {
  const oks = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.status === 'ok' && Number.isFinite(s.observedAt))
    .slice()
    .sort((a, b) => a.observedAt - b.observedAt);

  /** @type {number[]} */
  const out = [];
  for (let i = 1; i < oks.length; i++) {
    const a = oks[i - 1];
    const b = oks[i];
    if (!Number.isFinite(a.resetsAt) || !Number.isFinite(b.resetsAt)) continue;

    if (a.resetsAt > a.observedAt && a.resetsAt <= b.observedAt) {
      out.push(a.resetsAt);
      continue;
    }

    const jumpedForward = b.resetsAt - a.resetsAt > JITTER_MS;
    const usageDropped =
      Number.isFinite(a.usedPercent) &&
      Number.isFinite(b.usedPercent) &&
      b.usedPercent < a.usedPercent - USAGE_DROP_PCT;
    if (jumpedForward && usageDropped) {
      out.push(b.observedAt);
    }
  }
  return out;
}
