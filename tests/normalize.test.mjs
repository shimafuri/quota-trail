import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCodexAppServer,
  errorSamples,
  clampPercent,
  isoToMs,
  secondsToMs,
  httpErrorCode,
  allSeriesKeys,
  allFailed,
} from '../src/main/lib/normalize.mjs';

const ctx = { observedAt: 1_757_200_000_000, intervalSec: 180 };

test('clampPercent は 0..100 に丸め、非数は null', () => {
  assert.equal(clampPercent(42.5), 42.5);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(140), 100);
  assert.equal(clampPercent('37'), 37);
  assert.equal(clampPercent(null), null);
  assert.equal(clampPercent(undefined), null);
  assert.equal(clampPercent(NaN), null);
  assert.equal(clampPercent('abc'), null);
});

test('isoToMs / secondsToMs', () => {
  assert.equal(isoToMs('2026-09-07T08:37:00.000Z'), Date.parse('2026-09-07T08:37:00.000Z'));
  assert.equal(isoToMs('nonsense'), null);
  assert.equal(isoToMs(null), null);
  assert.equal(secondsToMs(1_757_200_000), 1_757_200_000_000);
  assert.equal(secondsToMs(null), null);
});

test('normalizeClaude: utilization をそのまま使用率として返し、Fable 欠落を記録する', () => {
  const rows = normalizeClaude({
    five_hour: { utilization: 40, resets_at: '2026-09-07T08:37:00Z' },
    seven_day: { utilization: 36.25, resets_at: '2026-09-12T00:00:00Z' },
  }, ctx);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.window), ['5h', 'weekly', 'weekly-fable']);
  assert.equal(rows[0].provider, 'claude');
  assert.equal(rows[0].usedPercent, 40);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].errorCode, null);
  assert.equal(rows[0].observedAt, ctx.observedAt);
  assert.equal(rows[0].intervalSec, 180);
  assert.equal(rows[0].resetsAt, Date.parse('2026-09-07T08:37:00Z'));
  assert.equal(rows[1].usedPercent, 36.25);
  assert.equal(rows[2].errorCode, 'window_absent');
});

test('normalizeClaude: clamp と欠落した窓', () => {
  const rows = normalizeClaude({ five_hour: { utilization: 130 } }, ctx);
  assert.equal(rows[0].usedPercent, 100);
  assert.equal(rows[0].resetsAt, null);
  assert.equal(rows[1].status, 'error');
  assert.equal(rows[1].errorCode, 'window_absent');
  assert.equal(rows[1].usedPercent, null);
});

test('normalizeClaude: 非オブジェクトは 3 行とも parse エラー', () => {
  const rows = normalizeClaude(null, ctx);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'error' && r.errorCode === 'parse'));
  assert.ok(allFailed(rows));
  assert.ok(normalizeClaude([], ctx).every((r) => r.errorCode === 'parse'));
});

test('normalizeCodex: used_percent と epoch 秒の reset_at', () => {
  const rows = normalizeCodex({
    rate_limit: {
      primary_window: { used_percent: 52.4, reset_at: 1_757_210_000 },
      secondary_window: { used_percent: 59, reset_at: 1_757_600_000 },
    },
  }, ctx);
  assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[0].window, '5h');
  assert.equal(rows[0].usedPercent, 52.4);
  assert.equal(rows[0].resetsAt, 1_757_210_000_000);
  assert.equal(rows[1].window, 'weekly');
  assert.equal(rows[1].usedPercent, 59);
  assert.equal(rows[1].resetsAt, 1_757_600_000_000);
});

test('normalizeCodex: secondary_window が null なら weekly は window_absent', () => {
  const rows = normalizeCodex({
    rate_limit: { primary_window: { used_percent: 10, reset_at: 1_757_210_000 }, secondary_window: null },
  }, ctx);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'error');
  assert.equal(rows[1].errorCode, 'window_absent');
  assert.equal(allFailed(rows), false);
});

test('normalizeCodex: rate_limits 綴りとトップレベル直置きも受ける', () => {
  const a = normalizeCodex({ rate_limits: { primary_window: { used_percent: 5, reset_at: 1 } } }, ctx);
  assert.equal(a[0].usedPercent, 5);
  const b = normalizeCodex({ primary_window: { used_percent: 7, reset_at: 1 } }, ctx);
  assert.equal(b[0].usedPercent, 7);
});

test('normalizeCodexAppServer: usedPercent / resetsAt(epoch 秒)', () => {
  const rows = normalizeCodexAppServer({
    rateLimits: {
      primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_757_210_000 },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1_757_600_000 },
    },
  }, ctx);
  assert.equal(rows[0].usedPercent, 12.5);
  assert.equal(rows[0].resetsAt, 1_757_210_000_000);
  assert.equal(rows[1].usedPercent, 88);
  assert.equal(rows[1].window, 'weekly');
});

test('normalizeCodexAppServer: secondary 欠落', () => {
  const rows = normalizeCodexAppServer({ rateLimits: { primary: { usedPercent: 1, resetsAt: 2 } } }, ctx);
  assert.equal(rows[1].errorCode, 'window_absent');
});

test('errorSamples は Claude 3 行、Codex 2 行を error で返す', () => {
  const rows = errorSamples('claude', { ...ctx, errorCode: 'auth_expired' });
  assert.deepEqual(rows.map((r) => r.window), ['5h', 'weekly', 'weekly-fable']);
  for (const r of rows) {
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'auth_expired');
    assert.equal(r.usedPercent, null);
    assert.equal(r.resetsAt, null);
    assert.equal(r.intervalSec, 180);
  }
  assert.deepEqual(errorSamples('codex', { ...ctx, errorCode: 'network' }).map((r) => r.window), ['5h', 'weekly']);
});

test('httpErrorCode', () => {
  assert.equal(httpErrorCode(401), 'auth_expired');
  assert.equal(httpErrorCode(403), 'auth_expired');
  assert.equal(httpErrorCode(429), 'http_429');
  assert.equal(httpErrorCode(500), 'http_500');
});

test('allSeriesKeys は 5 系列', () => {
  assert.deepEqual(allSeriesKeys(), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
});

const fable = (over = {}) => ({
  kind: 'weekly_scoped', group: 'weekly', scope: { surface: null, model: { id: null, display_name: ' Fable ' } },
  percent: 80, resets_at: '2026-09-30T00:00:00Z', is_active: false, severity: 'normal', ...over,
});
const claudeUsage = (limits) => ({
  five_hour: { utilization: 40 }, seven_day: { utilization: 56 }, limits,
});

test('実観測形式: seven_day=56 と Fable=80 は独立した同時刻の系列', () => {
  const rows = normalizeClaude(claudeUsage([fable()]), ctx);
  assert.deepEqual(rows.map((r) => [r.window, r.usedPercent, r.status]), [
    ['5h', 40, 'ok'], ['weekly', 56, 'ok'], ['weekly-fable', 80, 'ok'],
  ]);
  assert.ok(rows.every((r) => r.observedAt === ctx.observedAt));
  assert.equal(rows[2].resetsAt, Date.parse('2026-09-30T00:00:00Z'));
});

test('Fable は順序に依存せず完全一致で選び、Opus と weekly_all を無視する', () => {
  const other = [
    fable({ scope: { surface: null, model: { display_name: 'Opus' } }, percent: 1 }),
    fable({ scope: { surface: 'web', model: { display_name: 'Fable' } }, percent: 2 }),
    fable({ kind: 'weekly_all', percent: 3 }),
    fable({ scope: { surface: null, model: { display_name: 'Fable Plus' } }, percent: 4 }),
  ];
  for (const limits of [[...other, fable()], [fable(), ...other]]) {
    assert.equal(normalizeClaude(claudeUsage(limits), ctx)[2].usedPercent, 80);
  }
});

test('Fable 欠落、不正な limits、候補重複は Fable だけ error', () => {
  for (const limits of [undefined, null, [], [fable({ kind: 'weekly_all' })]]) {
    const rows = normalizeClaude(claudeUsage(limits), ctx);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok', 'error']);
    assert.equal(rows[2].errorCode, 'window_absent');
  }
  for (const limits of [{}, [fable(), fable()], [fable({ percent: 'invalid' })]]) {
    const rows = normalizeClaude(claudeUsage(limits), ctx);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok', 'error']);
    assert.equal(rows[2].errorCode, 'parse');
  }
});

test('Fable 重複は active が一意なら選び、reset 不正は null とする', () => {
  const rows = normalizeClaude(claudeUsage([
    fable({ percent: 10, is_active: false }),
    fable({ percent: 120, is_active: true, resets_at: 'invalid' }),
  ]), ctx);
  assert.equal(rows[2].usedPercent, 100);
  assert.equal(rows[2].resetsAt, null);
  assert.equal(normalizeClaude(claudeUsage([fable({ is_active: true }), fable({ is_active: true })]), ctx)[2].errorCode, 'parse');
});
