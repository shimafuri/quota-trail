import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduler } from '../src/main/scheduler.mjs';
import { createClaudeProvider, readCredentialSnapshot } from '../src/main/providers/claude.mjs';
import { createClaudeAuthMonitor } from '../src/main/claude-auth-monitor.mjs';
import { makeSample } from '../src/main/lib/normalize.mjs';
import { handleClaudePowerEvent } from '../src/main/lib/power-events.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAKE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Claude usage の正常応答（偽データ） */
function usageOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      five_hour: { utilization: 10, resets_at: '2026-10-02T05:00:00.000Z' },
      seven_day: { utilization: 20, resets_at: '2026-10-08T00:00:00.000Z' },
      limits: [],
    }),
    text: async () => '',
  };
}

/**
 * 一時 config dir・時計・タイマー・HTTP・DB をすべて注入した scheduler 環境。
 * @param {import('node:test').TestContext} t
 * @param {{usage?:() => any, codexErrorCode?:() => string|null, probeMode?:'off'|'once', pollIntervalSec?:number}} [options]
 *   probeMode: 期限超過後の確認送信の設定（§15.12）。既定 off
 */
function setup(t, { usage = usageOk, codexErrorCode = () => null, probeMode = 'off', pollIntervalSec = 180 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 9, 2, 0, 0, 0) };
  const calls = { usage: 0, profile: 0, codex: 0, usageAt: /** @type {number[]} */ ([]), profileAt: /** @type {number[]} */ ([]) };
  const cfg = { pollIntervalSec, claudeExpiredUsageProbe: probeMode };
  const probeLogs = [];
  const provider = createClaudeProvider({
    readSnapshot: () => readCredentialSnapshot({ configDir: dir }),
    fetch: async (url) => {
      if (String(url).includes('/profile')) {
        calls.profile += 1;
        calls.profileAt.push(clock.now);
        return { ok: true, json: async () => ({ account: { uuid: FAKE_UUID } }) };
      }
      calls.usage += 1;
      calls.usageAt.push(clock.now);
      return usage();
    },
    now: () => clock.now,
    readLocalFallback: () => null,
    readConfig: () => ({ ...cfg }),
    // 睡眠を含む経過時計（テストでは壁時計と同じだけ進む）
    elapsedNow: () => clock.now - Date.UTC(2026, 9, 1),
    logger: { info: (msg, fields) => probeLogs.push({ msg, fields }), warn: (msg, fields) => probeLogs.push({ msg, fields }) },
    saveProbeOff: () => { cfg.claudeExpiredUsageProbe = 'off'; return true; },
  });
  const fetchCodex = async ({ observedAt, intervalSec }) => {
    calls.codex += 1;
    const errorCode = codexErrorCode();
    return {
      provider: 'codex',
      identity: null,
      samples: ['5h', 'weekly'].map((window) => makeSample({
        observedAt, provider: 'codex', window, intervalSec,
        usedPercent: errorCode ? null : 30, resetsAt: errorCode ? null : observedAt + HOUR, errorCode,
      })),
    };
  };
  /** recordPoll 1 回 = 1 トランザクション */
  const transactions = [];
  const db = { recordPoll: (batches) => { transactions.push(batches.flatMap((b) => b.samples)); return 0; }, insertSamples: () => 0 };
  /** @type {{fn:() => Promise<void>, ms:number, at:number}|null} */
  let pending = null;
  const scheduledMs = [];
  const scheduler = createScheduler({
    db,
    readConfig: () => ({ ...cfg }),
    claudeProvider: provider,
    fetchCodex,
    now: () => clock.now,
    setTimer: (fn, ms) => { pending = { fn, ms, at: clock.now + ms }; scheduledMs.push(ms); return pending; },
    clearTimer: () => { pending = null; },
    logger: silentLogger,
  });
  /** 予定 tick を until まで順に発火する */
  const runUntil = async (until) => {
    while (pending && pending.at <= until) {
      const next = pending;
      pending = null;
      clock.now = next.at;
      await next.fn();
    }
    clock.now = Math.max(clock.now, until);
  };
  const write = (oauth) => fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  return { dir, clock, calls, cfg, probeLogs, provider, scheduler, transactions, scheduledMs, runUntil, write, pending: () => pending };
}

test('16 時間の期限切れ: 全 tick で Claude 3 error + Codex 2 ok を 1 トランザクション、要求 0 回、倍間隔なし', async (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-expired-16h', expiresAt: env.clock.now - 1 });
  const start = env.clock.now;
  await env.scheduler.start();
  await env.runUntil(start + 16 * HOUR);
  env.scheduler.stop();

  const expectedTicks = 16 * 20 + 1; // 起動直後 + 3 分ごと
  assert.equal(env.transactions.length, expectedTicks);
  for (const rows of env.transactions) {
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((s) => `${s.provider}/${s.window}=${s.status}:${s.errorCode}`), [
      'claude/5h=error:auth_expired_local',
      'claude/weekly=error:auth_expired_local',
      'claude/weekly-fable=error:auth_expired_local',
      'codex/5h=ok:null',
      'codex/weekly=ok:null',
    ]);
    assert.equal(new Set(rows.map((s) => s.observedAt)).size, 1);
  }
  assert.equal(env.calls.usage, 0);
  assert.equal(env.calls.profile, 0);
  assert.equal(env.calls.codex, expectedTicks);
  assert.ok(env.scheduledMs.every((ms) => ms === 180_000), 'ローカル認証 error で間隔を 2 倍にしない');
});

test('manual / resume の runNow も同じ gate を通り、single-flight を保つ', async (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-expired-manual', expiresAt: env.clock.now - 1 });
  await env.scheduler.start();
  const [a, b] = await Promise.all([env.scheduler.runNow(), env.scheduler.runNow()]);
  assert.ok(Array.isArray(a));
  assert.equal(b, null);
  assert.equal(env.transactions.length, 2);
  assert.equal(env.calls.usage + env.calls.profile, 0);
  env.scheduler.stop();
});

test('実際の usage 429 だけは既存どおり次回を 2 倍にする', async (t) => {
  let status = 429;
  const env = setup(t, { usage: () => (status === 429 ? { ok: false, status: 429, text: async () => '' } : usageOk()) });
  env.write({ accessToken: 'fake-valid-429', expiresAt: env.clock.now + 8 * HOUR });
  await env.scheduler.start();
  assert.equal(env.transactions[0][0].errorCode, 'http_429');
  assert.equal(env.scheduledMs.at(-1), 360_000);
  status = 200;
  await env.runUntil(env.clock.now + 360_000);
  assert.equal(env.transactions[1][0].status, 'ok');
  assert.equal(env.scheduledMs.at(-1), 180_000);
  env.scheduler.stop();
});

test('期限切れ中に外部で新 token に更新されたら、monitor は取得せず次の予定 tick で再開する', async (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-old-expired', expiresAt: env.clock.now - 1 });
  const logs = [];
  const monitor = createClaudeAuthMonitor({
    readSnapshot: () => readCredentialSnapshot({ configDir: env.dir }),
    provider: env.provider,
    readConfig: () => ({ claudeAuthNotifications: false, claudeAuthNoticeLeadSec: 600 }),
    now: () => env.clock.now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    logger: { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
  });
  monitor.start();
  await env.scheduler.start();
  assert.equal(env.transactions.length, 1);

  env.clock.now += MIN;
  env.write({ accessToken: 'fake-new-valid', expiresAt: env.clock.now + 8 * HOUR });
  monitor.checkNow();
  assert.ok(logs.includes('claude_auth_credentials_changed'));
  // monitor は HTTP も DB 書込も行わず、Codex の追加取得もしない
  assert.equal(env.transactions.length, 1);
  assert.equal(env.calls.usage + env.calls.profile, 0);
  assert.equal(env.calls.codex, 1);

  await env.runUntil(env.clock.now + 3 * MIN);
  assert.equal(env.transactions.length, 2);
  assert.deepEqual(env.transactions[1].slice(0, 2).map((s) => s.status), ['ok', 'ok']);
  assert.equal(env.calls.usage, 1);
  env.scheduler.stop();
});

test('起動 probe と scheduler は同じ provider で profile 要求と 401 latch を共有する', async (t) => {
  const env = setup(t, { usage: () => ({ ok: false, status: 401, text: async () => '' }) });
  env.write({ accessToken: 'fake-unknown-401' });
  const identity = await env.provider.resolveInitialIdentity();
  assert.equal(identity?.uuid, FAKE_UUID);
  assert.deepEqual([env.calls.usage, env.calls.profile], [0, 1]);
  await env.scheduler.start();
  assert.deepEqual([env.calls.usage, env.calls.profile], [1, 1]);
  assert.equal(env.transactions[0][0].errorCode, 'auth_expired');
  await env.runUntil(env.clock.now + HOUR);
  // 401 後は同じ token を再送しない。429 ではないので間隔も 2 倍にしない
  assert.deepEqual([env.calls.usage, env.calls.profile], [1, 1]);
  assert.ok(env.transactions.every((rows) => rows[0].errorCode === 'auth_expired'));
  assert.ok(env.scheduledMs.every((ms) => ms === 180_000));
  env.scheduler.stop();
});

// ---------------------------------------------------------------- §15.12 期限超過後の確認送信と scheduler

const STAGE_WINDOWS_SEC = [['3m', 180], ['30m', 1_800], ['2h', 7_200], ['6h', 21_600], ['8h', 28_800]];

/** Claude 3 行 + Codex 2 行を 1 トランザクションで保存していること */
function assertFiveRowTransactions(transactions) {
  for (const rows of transactions) {
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((s) => `${s.provider}/${s.window}`), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
    assert.equal(new Set(rows.map((s) => s.observedAt)).size, 1);
  }
}

test('once: 各段で期限前成功から 16 時間進め、割当窓だけ期限後 usage 最大 1・profile 0、200 後も再開しない', async (t) => {
  const env = setup(t, { probeMode: 'once' });
  await env.scheduler.start();
  for (const [stage, targetDelaySec] of STAGE_WINDOWS_SEC) {
    // 次の予定 tick から見て期限まで 640 秒（最後の通常 usage は期限 100 秒前 = 対照、180 秒 tick の位相差を含む）
    const nextAt = env.pending().at;
    const expiresAt = nextAt + 640_000;
    env.write({ accessToken: `fake-sched-${stage}`, expiresAt });
    const txBefore = env.transactions.length;
    await env.runUntil(expiresAt + 16 * HOUR);
    const afterExpiry = env.calls.usageAt.filter((at) => at > expiresAt);
    assert.equal(afterExpiry.length, 1, `${stage}: 期限後 usage は 1 回`);
    const delaySec = (afterExpiry[0] - expiresAt) / 1000;
    assert.ok(delaySec >= targetDelaySec && delaySec <= targetDelaySec + 300, `${stage}: 窓内 ${delaySec}`);
    assert.equal(env.calls.profileAt.filter((at) => at > expiresAt).length, 0, `${stage}: 期限後 profile 0`);
    // 期限後の tick は probe の 1 tick だけ ok（Fable は従来どおり window_absent）、他は auth_expired_local
    const txs = env.transactions.slice(txBefore).filter((rows) => rows[0].observedAt > expiresAt);
    const okTicks = txs.filter((rows) => rows[0].status === 'ok');
    assert.equal(okTicks.length, 1, stage);
    assert.deepEqual(okTicks[0].slice(0, 3).map((s) => `${s.status}:${s.errorCode}`), ['ok:null', 'ok:null', 'error:window_absent']);
    assert.equal(okTicks[0][0].observedAt, afterExpiry[0]);
    assert.ok(txs.filter((rows) => rows !== okTicks[0]).every((rows) => rows.slice(0, 3).every((s) => s.errorCode === 'auth_expired_local')));
  }
  env.scheduler.stop();
  assertFiveRowTransactions(env.transactions);
  assert.ok(env.scheduledMs.every((ms) => ms === 180_000), '200 / local gate で間隔を変えない');
  assert.deepEqual(env.probeLogs.filter((e) => e.msg === 'claude_auth_expiry_probe_start').map((e) => e.fields.stage), ['3m', '30m', '2h', '6h', '8h']);
});

test('once: poll 間隔が 300 秒より長いと窓を取り逃し得るが、窓を拡大せず late_probe として送らない', async (t) => {
  const env = setup(t, { probeMode: 'once', pollIntervalSec: 400 });
  // tick 0（期限余裕 700 秒 ≤ 2×400+30 → 対照）、400（余裕 300 秒）、800（期限後 100 秒 = 下限前）、1200（500 秒 = 窓超過）
  env.write({ accessToken: 'fake-long-interval', expiresAt: env.clock.now + 700_000 });
  const expiresAt = env.clock.now + 700_000;
  await env.scheduler.start();
  await env.runUntil(expiresAt + 2 * HOUR);
  env.scheduler.stop();
  assert.equal(env.calls.usageAt.filter((at) => at > expiresAt).length, 0);
  const skipped = env.probeLogs.filter((e) => e.msg === 'claude_auth_expiry_probe_skipped');
  assert.deepEqual(skipped.map((e) => e.fields.reason), ['late_probe']);
  assertFiveRowTransactions(env.transactions);
});

test('once: probe の 429 は次回だけ 2 倍、その後の local gate は倍間隔なし。設定は off に保存し以後送らない', async (t) => {
  let status = 200;
  const env = setup(t, {
    probeMode: 'once',
    usage: () => (status === 429 ? { ok: false, status: 429, text: async () => '' } : usageOk()),
  });
  // 起動 tick が期限余裕 100 秒の対照、180 秒後は下限前、360 秒後（期限後 260 秒）が 3m 窓の probe
  const expiresAt = env.clock.now + 100_000;
  env.write({ accessToken: 'fake-probe-429', expiresAt });
  await env.scheduler.start();
  status = 429;
  await env.runUntil(expiresAt + 3 * HOUR);
  env.scheduler.stop();
  const probeTick = env.transactions.findIndex((rows) => rows[0].errorCode === 'http_429');
  assert.ok(probeTick > 0);
  assert.equal(env.transactions.filter((rows) => rows[0].errorCode === 'http_429').length, 1);
  // scheduledMs[i] は i 番目の tick の後の予定
  assert.equal(env.scheduledMs[probeTick], 360_000);
  assert.ok(env.scheduledMs.every((ms, i) => (i === probeTick ? ms === 360_000 : ms === 180_000)));
  assert.equal(env.cfg.claudeExpiredUsageProbe, 'off');
  assert.equal(env.calls.usageAt.filter((at) => at > expiresAt).length, 1);
  assertFiveRowTransactions(env.transactions);
});

test('Codex の 429 は従来どおり次回だけ 2 倍（確認送信の有無に関係しない）', async (t) => {
  let codexCode = 'http_429';
  const env = setup(t, { probeMode: 'once', codexErrorCode: () => codexCode });
  env.write({ accessToken: 'fake-codex-429', expiresAt: env.clock.now + 8 * HOUR });
  await env.scheduler.start();
  assert.equal(env.scheduledMs.at(-1), 360_000);
  codexCode = null;
  await env.runUntil(env.clock.now + 360_000);
  assert.equal(env.scheduledMs.at(-1), 180_000);
  env.scheduler.stop();
});

test('once: probe 進行中の manual / resume は single-flight でスキップされ、予算は 1 回だけ', async (t) => {
  /** @type {(v:any) => void} */
  let release = () => {};
  let hold = false;
  const env = setup(t, {
    probeMode: 'once',
    usage: () => (hold ? new Promise((resolve) => { release = resolve; }) : usageOk()),
  });
  const expiresAt = env.clock.now + 300_000;
  env.write({ accessToken: 'fake-probe-manual', expiresAt });
  await env.scheduler.start();
  // 期限後 200 秒（3m 窓内）まで予定 tick を進めず、手動実行で probe を開始する
  env.clock.now = expiresAt + 200_000;
  hold = true;
  const first = env.scheduler.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  const [second, third] = await Promise.all([env.scheduler.runNow(), env.scheduler.runNow()]);
  assert.deepEqual([second, third], [null, null]);
  release(usageOk());
  const rows = await first;
  assert.equal(rows[0].status, 'ok');
  // 窓内でも次の手動実行は送らない
  const again = await env.scheduler.runNow();
  assert.equal(again[0].errorCode, 'auth_expired_local');
  assert.equal(env.calls.usageAt.filter((at) => at > expiresAt).length, 1);
  assert.equal(env.calls.profileAt.filter((at) => at > expiresAt).length, 0);
  env.scheduler.stop();
});

test('電源イベント: resume は確認送信の再評価 → monitor 再読込 → 即時 tick の順。unlock は睡眠とみなさない', () => {
  const order = [];
  const deps = {
    provider: { notePowerEvent: (kind) => order.push(`provider:${kind}`) },
    monitor: { setLocked: (v) => order.push(`locked:${v}`), checkNow: () => order.push('monitor:check') },
    runNow: () => { order.push('runNow'); return Promise.resolve(null); },
  };
  handleClaudePowerEvent('suspend', deps);
  handleClaudePowerEvent('resume', deps);
  assert.deepEqual(order, ['provider:suspend', 'provider:resume', 'monitor:check', 'runNow']);
  order.length = 0;
  handleClaudePowerEvent('lock-screen', deps);
  handleClaudePowerEvent('unlock-screen', deps);
  assert.deepEqual(order, ['locked:true', 'locked:false', 'runNow']);
  order.length = 0;
  for (const evt of ['shutdown', 'on-ac', 'on-battery']) handleClaudePowerEvent(evt, deps);
  assert.deepEqual(order, []);
});
