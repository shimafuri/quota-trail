import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIME_STEPS,
  pickTimeStep,
  timeTicks,
  formatTickLabel,
  formatRemaining,
} from '../src/shared/ticks.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('pickTimeStep: 24h / 300px → 6h', () => {
  // 必要な最小ステップ = 50/300 * 24h = 4h → 候補の最小は 6h
  assert.equal(pickTimeStep(DAY, 300), 6 * HOUR);
});

test('pickTimeStep: 24h / 1800px → 1h', () => {
  // 50/1800 * 24h = 40min → 候補の最小は 1h
  assert.equal(pickTimeStep(DAY, 1800), HOUR);
});

test('pickTimeStep: 30d / 1000px → 2d', () => {
  // 50/1000 * 30d = 1.5d → 候補の最小は 2d
  assert.equal(pickTimeStep(30 * DAY, 1000), 2 * DAY);
});

test('pickTimeStep: 選ばれたステップは必ず >= minPx、ひとつ下の候補は < minPx', () => {
  const cases = [
    [DAY, 300],
    [DAY, 660],
    [DAY, 1024],
    [DAY, 1800],
    [7 * DAY, 400],
    [7 * DAY, 1200],
    [30 * DAY, 300],
    [30 * DAY, 1000],
    [30 * DAY, 1900],
    [30 * MIN, 300],
    [30 * MIN, 1900],
  ];
  for (const [range, width] of cases) {
    const step = pickTimeStep(range, width);
    const px = (step / range) * width;
    assert.ok(px >= 50, `${range}/${width}: ${px}px < 50px`);
    const idx = TIME_STEPS.indexOf(step);
    if (idx > 0) {
      const smallerPx = (TIME_STEPS[idx - 1] / range) * width;
      assert.ok(
        smallerPx < 50,
        `${range}/${width}: より小さい候補 ${TIME_STEPS[idx - 1]} も ${smallerPx}px で条件を満たす`,
      );
    }
  }
});

test('pickTimeStep: 最小候補・最大候補の端', () => {
  // 非常に短い範囲では最小候補（1分）
  assert.equal(pickTimeStep(5 * MIN, 1900), MIN);
  // 非常に長い範囲では最大候補（30日）で頭打ち
  assert.equal(pickTimeStep(3650 * DAY, 300), 30 * DAY);
  // 不正入力でも落ちない
  assert.equal(pickTimeStep(0, 300), MIN);
  assert.equal(pickTimeStep(DAY, 0), 30 * DAY);
});

test('timeTicks: 1時間ステップはローカルの毎時 0 分に揃う', () => {
  const from = new Date(2026, 8, 7, 3, 17, 30).getTime(); // 9/7 03:17:30 local
  const to = new Date(2026, 8, 7, 9, 5, 0).getTime();
  const ticks = timeTicks(from, to, HOUR);
  assert.deepEqual(
    ticks.map((t) => new Date(t).getHours()),
    [4, 5, 6, 7, 8, 9],
  );
  for (const t of ticks) {
    const d = new Date(t);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.ok(t >= from && t <= to);
  }
});

test('timeTicks: 15分ステップはローカルの :00 :15 :30 :45 に揃う', () => {
  const from = new Date(2026, 8, 7, 3, 1).getTime();
  const to = new Date(2026, 8, 7, 4, 0).getTime();
  const ticks = timeTicks(from, to, 15 * MIN);
  assert.deepEqual(
    ticks.map((t) => {
      const d = new Date(t);
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }),
    ['3:15', '3:30', '3:45', '4:00'],
  );
});

test('timeTicks: 1日ステップはローカル 0:00 に揃う', () => {
  const from = new Date(2026, 8, 5, 13, 40).getTime();
  const to = new Date(2026, 8, 9, 6, 0).getTime();
  const ticks = timeTicks(from, to, DAY);
  assert.equal(ticks.length, 4);
  for (const t of ticks) {
    const d = new Date(t);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  }
  assert.deepEqual(
    ticks.map((t) => new Date(t).getDate()),
    [6, 7, 8, 9],
  );
});

test('timeTicks: 2日ステップもローカル 0:00 に揃い、間隔は 2 日ちょうど', () => {
  const from = new Date(2026, 8, 1, 5, 0).getTime();
  const to = new Date(2026, 8, 11, 5, 0).getTime();
  const ticks = timeTicks(from, to, 2 * DAY);
  assert.ok(ticks.length >= 5);
  for (const t of ticks) {
    const d = new Date(t);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  }
  for (let i = 1; i < ticks.length; i++) {
    // DST の無い地域では厳密に 2 日。ある地域でも ±1h に収まる
    const diff = ticks[i] - ticks[i - 1];
    assert.ok(Math.abs(diff - 2 * DAY) <= HOUR, `interval ${diff}`);
  }
});

test('timeTicks: 範囲外・不正入力では空配列', () => {
  const t0 = Date.now();
  assert.deepEqual(timeTicks(t0, t0 - 1000, HOUR), []);
  assert.deepEqual(timeTicks(t0, t0 + DAY, 0), []);
  assert.deepEqual(timeTicks(NaN, t0, HOUR), []);
});

test('timeTicks: 目盛り数は幅/50 の目安を超えない（pickTimeStep との組み合わせ）', () => {
  const now = new Date(2026, 8, 7, 12, 0).getTime();
  for (const [range, width] of [
    [DAY, 300],
    [DAY, 1800],
    [7 * DAY, 660],
    [30 * DAY, 1000],
  ]) {
    const step = pickTimeStep(range, width);
    const ticks = timeTicks(now - range, now, step);
    assert.ok(
      ticks.length <= Math.floor(width / 50) + 1,
      `range=${range} width=${width} ticks=${ticks.length}`,
    );
  }
});

test('formatTickLabel: ステップに応じた書式', () => {
  const a = new Date(2026, 8, 7, 3, 5).getTime();
  const b = new Date(2026, 8, 7, 9, 5).getTime();
  const c = new Date(2026, 8, 8, 0, 0).getTime();
  assert.equal(formatTickLabel(a, HOUR, null), '9/7 03:05'); // 最初は日付付き
  assert.equal(formatTickLabel(b, HOUR, a), '09:05');
  assert.equal(formatTickLabel(c, HOUR, b), '9/8 00:00'); // 日付が変わる目盛り
  assert.equal(formatTickLabel(c, DAY, b), '9/8');
});

test('formatRemaining: 区間ごとの書式', () => {
  assert.equal(formatRemaining(30 * 1000), '1m未満'); // 1分未満
  assert.equal(formatRemaining(12 * MIN), '12m'); // 1時間未満
  assert.equal(formatRemaining(3 * HOUR + 12 * MIN), '3h12m'); // 1日未満
  assert.equal(formatRemaining(2 * DAY + 5 * HOUR), '2d5h'); // それ以上
  assert.equal(formatRemaining(-100), '0m'); // 負数
});
