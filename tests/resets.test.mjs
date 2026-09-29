import test from 'node:test';
import assert from 'node:assert/strict';

import { pastResets } from '../src/shared/resets.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = new Date(2026, 8, 7, 0, 0, 0, 0).getTime();

/**
 * @param {number} offsetMs
 * @param {Partial<import('../src/shared/gaps.mjs').Sample>} [over]
 * @returns {import('../src/shared/gaps.mjs').Sample}
 */
function ok(offsetMs, over = {}) {
  return {
    observedAt: T0 + offsetMs,
    provider: 'codex',
    window: '5h',
    usedPercent: 0,
    resetsAt: null,
    status: 'ok',
    errorCode: null,
    intervalSec: 180,
    ...over,
  };
}

test('Codex アイドルパターン: usedPercent 0 で resetsAt が常に observedAt+5h → リセット無し', () => {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const t = i * 180 * SEC;
    samples.push(ok(t, { usedPercent: 0, resetsAt: T0 + t + 5 * HOUR }));
  }
  assert.deepEqual(pastResets(samples), []);
});

test('resetsAt が固定値の周りで秒未満〜数秒ゆらぐだけ → リセット無し', () => {
  const T = T0 + 3 * HOUR;
  const samples = [
    ok(0, { usedPercent: 40, resetsAt: T }),
    ok(180 * SEC, { usedPercent: 41, resetsAt: T + 2 * SEC }),
    ok(360 * SEC, { usedPercent: 42, resetsAt: T - 1 * SEC }),
    ok(540 * SEC, { usedPercent: 43, resetsAt: T + 3 * SEC }),
  ];
  assert.deepEqual(pastResets(samples), []);
});

test('実際のリセット: resetsAt が固定の T をまたぎ、使用率が 65 → 0 に落ちる', () => {
  const T = T0 + 90 * MIN;
  const samples = [
    ok(0, { usedPercent: 60, resetsAt: T }),
    ok(80 * MIN, { usedPercent: 65, resetsAt: T }),
    // T をまたいだ最初のサンプル（新しいウィンドウ）
    ok(100 * MIN, { usedPercent: 0, resetsAt: T + 5 * HOUR }),
    ok(103 * MIN, { usedPercent: 1, resetsAt: T + 5 * HOUR }),
  ];
  assert.deepEqual(pastResets(samples), [T]);
});

test('使用率の低下はあるが予告時刻がまだ経過していない → b.observedAt に 1 本', () => {
  const a = ok(0, { usedPercent: 70, resetsAt: T0 + 4 * HOUR });
  // まだ a.resetsAt を過ぎていないのに、次のサンプルの resetsAt が大きく前進 & 使用率が下がった
  const b = ok(90 * MIN, { usedPercent: 2, resetsAt: T0 + 90 * MIN + 5 * HOUR });
  assert.deepEqual(pastResets([a, b]), [b.observedAt]);
});

test('ウィンドウ開始直後: アイドルのスライドから resetsAt が固定されるが使用率は上昇 → リセット無し', () => {
  // a はまだアイドル（resetsAt が observedAt+5h をスライド）、b で resetsAt が固定値に
  // 前進する（60s 超のジャンプ）が、使用率は 0 → 3 と上昇しているため低下条件を満たさない
  const a = ok(0, { usedPercent: 0, resetsAt: T0 + 5 * HOUR });
  const b = ok(180 * SEC, { usedPercent: 3, resetsAt: T0 + 5 * HOUR + 10 * MIN });
  assert.deepEqual(pastResets([a, b]), []);
});

test('Fable の window_absent をまたいでも既存規則でリセットを検出する', () => {
  const resetAt = T0 + 5 * MIN;
  const samples = [
    ok(0, { provider: 'claude', window: 'weekly-fable', usedPercent: 80, resetsAt: resetAt }),
    ok(3 * MIN, { provider: 'claude', window: 'weekly-fable', status: 'error', errorCode: 'window_absent', usedPercent: null, resetsAt: null }),
    ok(6 * MIN, { provider: 'claude', window: 'weekly-fable', usedPercent: 0, resetsAt: resetAt + 7 * 24 * HOUR }),
  ];
  assert.deepEqual(pastResets(samples), [resetAt]);
});
