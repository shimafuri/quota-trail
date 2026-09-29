import test from 'node:test';
import assert from 'node:assert/strict';

import { computeGaps } from '../src/shared/gaps.mjs';

const MIN = 60_000;
const T0 = new Date(2026, 8, 7, 0, 0, 0, 0).getTime();

/**
 * @param {number} offsetMin
 * @param {Partial<import('../src/shared/gaps.mjs').Sample>} [over]
 * @returns {import('../src/shared/gaps.mjs').Sample}
 */
function ok(offsetMin, over = {}) {
  return {
    observedAt: T0 + offsetMin * MIN,
    provider: 'claude',
    window: '5h',
    usedPercent: 42,
    resetsAt: null,
    status: 'ok',
    errorCode: null,
    intervalSec: 180,
    ...over,
  };
}

/**
 * @param {number} offsetMin
 * @param {Partial<import('../src/shared/gaps.mjs').Sample>} [over]
 */
function err(offsetMin, over = {}) {
  return ok(offsetMin, { status: 'error', usedPercent: null, errorCode: 'network', ...over });
}

test('連続した正常サンプルでは欠測なし', () => {
  const samples = [ok(0), ok(3), ok(6), ok(9)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 9 * MIN,
    now: T0 + 9 * MIN,
    factor: 2.5,
  });
  assert.deepEqual(gaps, []);
});

test('(a) 閾値（intervalSec × 2.5）を超える間隔が欠測になる', () => {
  // 180s * 2.5 = 450s = 7.5min。9分空くので欠測
  const samples = [ok(0), ok(3), ok(12), ok(15)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 15 * MIN,
    now: T0 + 15 * MIN,
    factor: 2.5,
  });
  assert.deepEqual(gaps, [{ from: T0 + 3 * MIN, to: T0 + 12 * MIN }]);
});

test('(a) 閾値ちょうどは欠測にしない（超えたときだけ）', () => {
  const samples = [ok(0), ok(7.5)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 7.5 * MIN,
    now: T0 + 7.5 * MIN,
  });
  assert.deepEqual(gaps, []);
});

test('(a) 判定には「前の点の」intervalSec を使う（途中で間隔が変わるケース）', () => {
  // 60秒間隔の区間 → 閾値 150s = 2.5min。3分空くので欠測になる
  const dense = [
    ok(0, { intervalSec: 60 }),
    ok(1, { intervalSec: 60 }),
    ok(4, { intervalSec: 60 }), // 3分空き > 2.5min → 欠測
  ];
  const g1 = computeGaps(dense, { from: T0, to: T0 + 4 * MIN, now: T0 + 4 * MIN });
  assert.deepEqual(g1, [{ from: T0 + 1 * MIN, to: T0 + 4 * MIN }]);

  // 前の点が 180s なら同じ 3 分空きでも欠測にならない
  const mixed = [ok(0, { intervalSec: 180 }), ok(3, { intervalSec: 60 }), ok(4, { intervalSec: 60 })];
  const g2 = computeGaps(mixed, { from: T0, to: T0 + 4 * MIN, now: T0 + 4 * MIN });
  assert.deepEqual(g2, []);

  // 逆向き: 前の点が 60s、次が 180s → 前の点の閾値（2.5min）で判定して欠測
  const mixed2 = [ok(0, { intervalSec: 60 }), ok(3, { intervalSec: 180 })];
  const g3 = computeGaps(mixed2, { from: T0, to: T0 + 3 * MIN, now: T0 + 3 * MIN });
  assert.deepEqual(g3, [{ from: T0, to: T0 + 3 * MIN }]);
});

test('(b) error 行の区間が欠測になる（前後の ok 点まで伸びる）', () => {
  const samples = [ok(0), ok(3), err(6), err(9), ok(12), ok(15)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 15 * MIN,
    now: T0 + 15 * MIN,
  });
  assert.deepEqual(gaps, [{ from: T0 + 3 * MIN, to: T0 + 12 * MIN }]);
});

test('(b) 単独の error 行も幅を持った欠測になる', () => {
  const samples = [ok(0), err(3), ok(6)];
  const gaps = computeGaps(samples, { from: T0, to: T0 + 6 * MIN, now: T0 + 6 * MIN });
  assert.deepEqual(gaps, [{ from: T0, to: T0 + 6 * MIN }]);
});

test('(b) 先頭・末尾が error のときは intervalSec 分だけ外側へ伸ばす（範囲でクリップ）', () => {
  const samples = [err(5), ok(8)];
  const gaps = computeGaps(samples, { from: T0, to: T0 + 8 * MIN, now: T0 + 8 * MIN });
  // (c) 先頭 0..5min と、error 区間 (5-3=2min).. 8min が重なってマージされる
  assert.deepEqual(gaps, [{ from: T0, to: T0 + 8 * MIN }]);

  const trailing = [ok(0), err(3)];
  const g2 = computeGaps(trailing, { from: T0, to: T0 + 30 * MIN, now: T0 + 30 * MIN });
  assert.equal(g2.length, 1);
  assert.equal(g2[0].from, T0);
  assert.equal(g2[0].to, T0 + 30 * MIN); // (d) により now まで伸びる
});

test('(c) 範囲先頭から最初の点までが欠測', () => {
  const samples = [ok(20), ok(23), ok(26)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 26 * MIN,
    now: T0 + 26 * MIN,
  });
  assert.deepEqual(gaps, [{ from: T0, to: T0 + 20 * MIN }]);
});

test('(d) 最後の点が古いとき now まで欠測、新しいときは欠測なし', () => {
  const samples = [ok(0), ok(3), ok(6)];
  const stale = computeGaps(samples, {
    from: T0,
    to: T0 + 60 * MIN,
    now: T0 + 60 * MIN,
  });
  assert.deepEqual(stale, [{ from: T0 + 6 * MIN, to: T0 + 60 * MIN }]);

  const fresh = computeGaps(samples, {
    from: T0,
    to: T0 + 10 * MIN,
    now: T0 + 10 * MIN,
  });
  assert.deepEqual(fresh, []);
});

test('(d) to が now より先でも欠測は now までで止まる', () => {
  const samples = [ok(0), ok(3)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 120 * MIN,
    now: T0 + 40 * MIN,
  });
  assert.deepEqual(gaps, [{ from: T0 + 3 * MIN, to: T0 + 40 * MIN }]);
});

test('(d) to が now より先でも、最後の点が新しければ未来側に欠測は出ない（無制限パン対応）', () => {
  // 発注者指示 2026-09-08: パン/ズームの範囲上限を撤廃したため、to が now よりずっと
  // 先（未来）になりうる。最後の点が新しければ、now より先の未来部分は灰色にならない。
  const samples = [ok(0), ok(3), ok(6)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 365 * 24 * 60 * MIN, // 1年先まで表示
    now: T0 + 6 * MIN, // 最後の点と同時刻 = 新しい
  });
  assert.deepEqual(gaps, []);
});

test('サンプルが 0 件なら範囲全体（now まで）が欠測', () => {
  const gaps = computeGaps([], { from: T0, to: T0 + 60 * MIN, now: T0 + 45 * MIN });
  assert.deepEqual(gaps, [{ from: T0, to: T0 + 45 * MIN }]);
});

test('範囲外のサンプルは欠測区間としてクリップされる', () => {
  const samples = [ok(-20), ok(-17), ok(30), ok(33)];
  const gaps = computeGaps(samples, {
    from: T0,
    to: T0 + 45 * MIN,
    now: T0 + 45 * MIN,
  });
  // -17min と 30min の間が閾値超 → クリップして 0..30min。末尾は 33min..45min
  assert.deepEqual(gaps, [
    { from: T0, to: T0 + 30 * MIN },
    { from: T0 + 33 * MIN, to: T0 + 45 * MIN },
  ]);
});

test('入力順が乱れていてもソートして扱う / 元配列を壊さない', () => {
  const samples = [ok(12), ok(0), ok(3)];
  const copy = samples.slice();
  const gaps = computeGaps(samples, { from: T0, to: T0 + 12 * MIN, now: T0 + 12 * MIN });
  assert.deepEqual(gaps, [{ from: T0 + 3 * MIN, to: T0 + 12 * MIN }]);
  assert.deepEqual(samples, copy);
});

test('重なる欠測はマージされる', () => {
  const samples = [ok(0), err(20), err(23), ok(60)];
  const gaps = computeGaps(samples, { from: T0, to: T0 + 60 * MIN, now: T0 + 60 * MIN });
  assert.deepEqual(gaps, [{ from: T0, to: T0 + 60 * MIN }]);
});

test('factor を変えると閾値が変わる', () => {
  const samples = [ok(0), ok(9)];
  assert.deepEqual(computeGaps(samples, { from: T0, to: T0 + 9 * MIN, now: T0 + 9 * MIN, factor: 2.5 }), [
    { from: T0, to: T0 + 9 * MIN },
  ]);
  assert.deepEqual(
    computeGaps(samples, { from: T0, to: T0 + 9 * MIN, now: T0 + 9 * MIN, factor: 5 }),
    [],
  );
});

test('Fable の ok → window_absent → ok は欠測帯を残す', () => {
  const samples = [
    ok(0, { window: 'weekly-fable', usedPercent: 80 }),
    err(3, { window: 'weekly-fable', errorCode: 'window_absent' }),
    ok(6, { window: 'weekly-fable', usedPercent: 81 }),
  ];
  assert.deepEqual(computeGaps(samples, { from: T0, to: T0 + 6 * MIN, now: T0 + 6 * MIN }), [
    { from: T0, to: T0 + 6 * MIN },
  ]);
});
