import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAuthMonitor, MONITOR_INTERVAL_MS } from '../src/main/claude-auth-monitor.mjs';
import { createClaudeProvider, readCredentialSnapshot } from '../src/main/providers/claude.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAKE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * 一時 config dir・時計・タイマー・通知・ログをすべて注入した monitor を作る。
 * HTTP は fetch モックで数え、monitor からは 1 回も呼ばれないことを確認する。
 * @param {import('node:test').TestContext} t
 * @param {{config?:Record<string, unknown>, fetch?:(url:string) => Promise<any>, probe?:boolean}} [options]
 *   fetch: scheduler と同じ provider の HTTP（monitor 自身は呼ばない）。省略時は呼ばれたら失敗する
 *   probe: provider の期限超過後の確認送信を once にする（§15.12。経過時計は壁時計と同じだけ進める）
 */
function setup(t, { config = {}, fetch, probe = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-auth-monitor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 9, 2, 0, 0, 0) };
  const httpCalls = [];
  const logs = [];
  const provider = createClaudeProvider({
    readSnapshot: () => readCredentialSnapshot({ configDir: dir }),
    fetch: fetch ?? (async (url) => { httpCalls.push(String(url)); throw new Error('monitor must not fetch'); }),
    now: () => clock.now,
    readLocalFallback: () => null,
    readConfig: () => ({ claudeExpiredUsageProbe: probe ? 'once' : 'off', pollIntervalSec: 180 }),
    elapsedNow: () => clock.now - Date.UTC(2026, 9, 1),
    logger: {
      info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    },
    saveProbeOff: () => true,
  });
  /** @type {{fn:() => void, ms:number}|null} */
  let interval = null;
  const notices = [];
  let opened = 0;
  let immediateTicks = 0;
  const cfg = { claudeAuthNotifications: true, claudeAuthNoticeLeadSec: 600, ...config };
  const monitor = createClaudeAuthMonitor({
    readSnapshot: () => readCredentialSnapshot({ configDir: dir }),
    provider,
    readConfig: () => cfg,
    notifier: { show: (notice) => notices.push(notice) },
    openDashboard: () => { opened += 1; },
    requestImmediateTick: () => { immediateTicks += 1; },
    now: () => clock.now,
    setIntervalFn: (fn, ms) => { interval = { fn, ms }; return 1; },
    clearIntervalFn: () => { interval = null; },
    logger: {
      info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    },
  });
  const write = (oauth) => fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  /** 30 秒周期を n 回進める */
  const advance = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.now += MONITOR_INTERVAL_MS;
      interval?.fn();
    }
  };
  const events = (msg) => logs.filter((entry) => entry.msg === msg);
  return {
    dir, clock, provider, monitor, notices, logs, httpCalls, cfg, write, advance, events,
    interval: () => interval, opened: () => opened, immediateTicks: () => immediateTicks,
  };
}

test('30 秒周期で読み直し、期限前に一度だけ案内し、期限切れでも一度だけ案内する。HTTP は呼ばない', (t) => {
  const env = setup(t);
  const expiresAt = env.clock.now + 20 * MIN;
  env.write({ accessToken: 'fake-monitor-token', expiresAt });
  env.monitor.start();
  assert.equal(env.interval()?.ms, 30_000);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  assert.equal(env.notices.length, 0);

  // 残り 10 分を跨ぐまで進める
  env.advance(20);
  assert.equal(env.notices.length, 1);
  assert.match(env.notices[0].title, /期限が近づいています/);
  assert.equal(env.events('claude_auth_expiring').length, 1);
  env.advance(5);
  assert.equal(env.notices.length, 1);

  // 期限切れへ
  env.advance(20);
  assert.equal(env.monitor.publicStatus().state, 'expired');
  assert.equal(env.notices.length, 2);
  assert.match(env.notices[1].title, /認証更新待ち/);
  assert.equal(env.events('claude_auth_blocked').length, 1);
  assert.equal(env.events('claude_auth_blocked')[0].fields.source, 'local');
  assert.equal(env.events('claude_auth_blocked')[0].fields.errorCode, 'auth_expired_local');
  env.advance(10);
  assert.equal(env.notices.length, 2);

  // 通知 click は dashboard を開く
  env.notices[1].onClick();
  assert.equal(env.opened(), 1);

  // 継続中は 60 分に一度だけ still_blocked
  env.advance(2 * 120);
  assert.equal(env.events('claude_auth_still_blocked').length, 2);
  assert.equal(env.events('claude_auth_blocked').length, 1);
  assert.deepEqual(env.httpCalls, []);

  // 通知に UUID・メール・パス・token を含めない
  const serialized = JSON.stringify(env.notices.map(({ title, body }) => ({ title, body })));
  assert.equal(serialized.includes(env.dir), false);
  assert.equal(serialized.includes('fake-monitor-token'), false);
  assert.equal(/@|[0-9a-f]{8}-[0-9a-f]{4}/i.test(serialized), false);
  // ログにも token・内部キー・config dir を出さない
  const logText = JSON.stringify(env.logs);
  assert.equal(logText.includes('fake-monitor-token'), false);
  assert.equal(logText.includes(env.dir), false);
  assert.equal(/[0-9a-f]{64}/.test(logText), false);

  env.monitor.stop();
  assert.equal(env.interval(), null);
});

test('ロック中も読込は続け、OS 通知だけを保留して unlock 時に一度案内する。繰り返し unlock は 60 分に一度', (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-lock-token-1', expiresAt: env.clock.now + 5 * MIN });
  env.monitor.setLocked(true);
  env.monitor.start();
  assert.equal(env.monitor.publicStatus().withinLead, true);
  assert.equal(env.notices.length, 0);
  // ロック中に期限切れになっても読込は継続し、状態は更新される
  env.advance(12);
  assert.equal(env.monitor.publicStatus().state, 'expired');
  assert.equal(env.events('claude_auth_blocked').length, 1);
  assert.equal(env.notices.length, 0);

  // unlock 時に最新 snapshot で再評価して一度だけ（期限切れの案内）
  env.monitor.setLocked(false);
  assert.equal(env.notices.length, 1);
  assert.match(env.notices[0].title, /認証更新待ち/);
  env.monitor.setLocked(true);
  env.monitor.setLocked(false);
  assert.equal(env.notices.length, 1);

  // 新 token の世代でも、前回の unlock 案内から 60 分以内の unlock では案内しない
  env.write({ accessToken: 'fake-lock-token-2', expiresAt: env.clock.now + 2 * MIN });
  env.monitor.setLocked(true);
  env.advance(1);
  env.monitor.setLocked(false);
  assert.equal(env.notices.length, 1);
  // tooltip / dashboard 用の状態は読める
  assert.equal(env.monitor.publicStatus().withinLead, true);

  // 60 分以上経った unlock では次の世代の案内を出す
  env.write({ accessToken: 'fake-lock-token-3', expiresAt: env.clock.now + 61 * MIN + 5 * MIN });
  env.monitor.setLocked(true);
  env.advance(122);
  env.monitor.setLocked(false);
  assert.equal(env.notices.length, 2);
  assert.deepEqual(env.httpCalls, []);
});

test('通知 OFF でも状態とログは更新する', (t) => {
  const env = setup(t, { config: { claudeAuthNotifications: false } });
  env.write({ accessToken: 'fake-off-token', expiresAt: env.clock.now - 1 });
  env.monitor.start();
  assert.equal(env.notices.length, 0);
  assert.equal(env.monitor.publicStatus().state, 'expired');
  assert.equal(env.monitor.publicStatus().notificationsEnabled, false);
  assert.equal(env.events('claude_auth_blocked').length, 1);
});

test('外部更新を 30 秒以内に検知し、新 token の usage 成功で recovered を一度だけ出す', (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-old-token', expiresAt: env.clock.now - 1 });
  env.monitor.start();
  assert.equal(env.monitor.publicStatus().state, 'expired');

  // mtime / 期限だけの変更は新 token とみなさない
  env.write({ accessToken: 'fake-old-token', expiresAt: env.clock.now - 1 });
  env.advance(1);
  assert.equal(env.events('claude_auth_credentials_changed').length, 0);

  env.clock.now += 10 * MIN;
  env.write({ accessToken: 'fake-refreshed-token', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.events('claude_auth_credentials_changed').length, 1);
  assert.deepEqual(Object.keys(env.events('claude_auth_credentials_changed')[0].fields).sort(), ['checkedAt', 'provider']);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  // ファイル変更だけでは recovered にしない
  assert.equal(env.events('claude_auth_recovered').length, 0);

  // scheduler から新 token の usage 成功 batch を受けたら recovered
  const key = readCredentialSnapshot({ configDir: env.dir }).key;
  env.monitor.observeClaudeBatch({ auth: { key, source: 'http_ok', state: 'valid' }, samples: [{ observedAt: env.clock.now }] });
  const recovered = env.events('claude_auth_recovered');
  assert.equal(recovered.length, 1);
  assert.ok(recovered[0].fields.blockedForSec >= 600);
  env.monitor.observeClaudeBatch({ auth: { key, source: 'http_ok', state: 'valid' }, samples: [{ observedAt: env.clock.now }] });
  assert.equal(env.events('claude_auth_recovered').length, 1);
  assert.deepEqual(env.httpCalls, []);
});

test('usage 401 の batch は即座に blocked（source http_401）として扱い、案内は一度だけ', async (t) => {
  const env = setup(t, {
    fetch: async (url) => (String(url).includes('/profile')
      ? { ok: true, json: async () => ({ account: { uuid: FAKE_UUID } }) }
      : { ok: false, status: 401, text: async () => '' }),
  });
  env.write({ accessToken: 'fake-401-token' });
  env.monitor.start();
  assert.equal(env.monitor.publicStatus().state, 'unknown_expiry');
  assert.equal(env.events('claude_auth_metadata_unknown').length, 1);
  assert.equal(env.events('claude_auth_metadata_unknown')[0].fields.reason, 'missing_expiry');
  env.advance(3);
  assert.equal(env.events('claude_auth_metadata_unknown').length, 1);
  assert.equal(env.notices.length, 0);

  // scheduler と同じ provider インスタンスで取得し、batch を monitor へ渡す
  const batch = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  assert.equal(batch.auth.source, 'http_401');
  env.monitor.observeClaudeBatch(batch);
  assert.equal(env.monitor.publicStatus().state, 'rejected');
  assert.equal(env.events('claude_auth_blocked').length, 1);
  assert.equal(env.events('claude_auth_blocked')[0].fields.source, 'http_401');
  assert.equal(env.events('claude_auth_blocked')[0].fields.errorCode, 'auth_expired');
  assert.equal(env.notices.length, 1);
  assert.match(env.notices[0].body, /認証エラー/);

  // 次の tick（cached_401）と 30 秒周期でも重複しない
  const again = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  assert.equal(again.auth.source, 'cached_401');
  env.monitor.observeClaudeBatch(again);
  env.advance(10);
  assert.equal(env.events('claude_auth_blocked').length, 1);
  assert.equal(env.notices.length, 1);
});

test('blocked（期限切れ）から新 token に切り替わったときだけ即時 tick を 1 回だけ要求する', (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-blocked-token', expiresAt: env.clock.now - 1 });
  env.monitor.start();
  assert.equal(env.monitor.publicStatus().state, 'expired');
  assert.equal(env.immediateTicks(), 0);

  // blocked のまま 30 秒周期が進んでも要求しない
  env.advance(1);
  assert.equal(env.immediateTicks(), 0);

  // blocked → 新 token で 1 回だけ要求する
  env.write({ accessToken: 'fake-recovered-token', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  assert.equal(env.immediateTicks(), 1);

  // 同じ新 token を何度確認しても再要求しない
  env.advance(5);
  assert.equal(env.immediateTicks(), 1);
});

test('有効なまま token が切り替わる（proactive refresh）だけでは即時 tick を要求しない', (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-valid-token-1', expiresAt: env.clock.now + 8 * HOUR });
  env.monitor.start();
  assert.equal(env.monitor.publicStatus().state, 'valid');

  env.write({ accessToken: 'fake-valid-token-2', expiresAt: env.clock.now + 9 * HOUR });
  env.advance(1);
  assert.equal(env.events('claude_auth_credentials_changed').length, 1);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  assert.equal(env.immediateTicks(), 0);
});

test('usage 401（rejected）latch 中に新 token を検知したときも即時 tick を 1 回要求する', async (t) => {
  const env = setup(t, {
    fetch: async (url) => (String(url).includes('/profile')
      ? { ok: true, json: async () => ({ account: { uuid: FAKE_UUID } }) }
      : { ok: false, status: 401, text: async () => '' }),
  });
  env.write({ accessToken: 'fake-401-source-token' });
  env.monitor.start();
  const batch = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  assert.equal(batch.auth.source, 'http_401');
  env.monitor.observeClaudeBatch(batch);
  assert.equal(env.monitor.publicStatus().state, 'rejected');
  assert.equal(env.immediateTicks(), 0);

  env.write({ accessToken: 'fake-401-recovered-token', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  assert.equal(env.immediateTicks(), 1);

  env.advance(3);
  assert.equal(env.immediateTicks(), 1);
});

test('資格情報の一時不在・破損では例外を投げず、世代を捨てない', (t) => {
  const env = setup(t);
  env.write({ accessToken: 'fake-atomic-token', expiresAt: env.clock.now + 8 * HOUR });
  env.monitor.start();
  fs.rmSync(path.join(env.dir, '.credentials.json'));
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'missing');
  fs.writeFileSync(path.join(env.dir, '.credentials.json'), '{ broken');
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'invalid');
  env.write({ accessToken: 'fake-atomic-token', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  // 同じ token に戻っただけなので credentials_changed は出ない
  assert.equal(env.events('claude_auth_credentials_changed').length, 0);
});

// ---------------------------------------------------------------- §15.12 期限超過後の確認送信と monitor

/** usage / profile を数える fetch（偽データ）。usage は応答を差し替えられる */
function countingFetch() {
  const calls = { usage: 0, profile: 0 };
  /** @type {() => Promise<any>} */
  let usage = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { utilization: 12, resets_at: '2026-10-02T05:00:00.000Z' }, seven_day: { utilization: 34, resets_at: '2026-10-08T00:00:00.000Z' }, limits: [] }),
    text: async () => '',
  });
  const fn = async (url) => {
    if (String(url).includes('/profile')) {
      calls.profile += 1;
      return { ok: true, json: async () => ({ account: { uuid: FAKE_UUID } }) };
    }
    calls.usage += 1;
    return usage();
  };
  return { fn, calls, setUsage: (next) => { usage = next; } };
}

test('monitor の 30 秒判定・lock/unlock は HTTP も予算消費もしない。probe 200 でも expired・blockedAt・通知済みを解除せず recovered を出さない', async (t) => {
  const http = countingFetch();
  const env = setup(t, { probe: true, fetch: http.fn });
  const expiresAt = env.clock.now + 300_000;
  env.write({ accessToken: 'fake-probe-monitor', expiresAt });
  env.monitor.start();
  const normal = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  env.monitor.observeClaudeBatch(normal);
  assert.equal(env.provider.expiryProbeStatus().pendingStage, '3m');

  // 期限到来: 30 秒周期と lock/unlock を繰り返しても HTTP なし・予算消費なし
  env.advance(11);
  assert.equal(env.monitor.publicStatus().state, 'expired');
  env.monitor.setLocked(true);
  env.advance(2);
  env.monitor.setLocked(false);
  assert.deepEqual(http.calls, { usage: 1, profile: 1 });
  assert.equal(env.provider.expiryProbeStatus().totalSpent, 0);
  assert.equal(env.provider.expiryProbeStatus().pendingStage, '3m');
  assert.equal(env.events('claude_auth_blocked').length, 1);
  const blockedNotices = env.notices.filter((n) => /認証更新待ち/.test(n.title));
  assert.equal(blockedNotices.length, 1);
  // 期限後の一度の受付を否定する断言はしない
  assert.equal(/記録できません|一切/.test(blockedNotices[0].body), false);
  assert.match(blockedNotices[0].body, /継続して使用率を記録するため/);

  // 3m 窓で確認送信 → 200
  env.clock.now = expiresAt + 200_000;
  const probed = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  assert.equal(probed.auth.requestKind, 'expiry_probe');
  assert.equal(probed.samples[0].status, 'ok');
  env.monitor.observeClaudeBatch(probed);
  assert.equal(env.monitor.publicStatus().state, 'expired');
  assert.equal(env.events('claude_auth_recovered').length, 0);
  assert.equal(env.events('claude_auth_blocked').length, 1);
  env.advance(2);
  assert.equal(env.notices.filter((n) => /認証更新待ち/.test(n.title)).length, 1, '通知済み状態を解除しない');
  // blockedAt を解除しないので、継続ログの blockedForSec は最初の blocked から数える
  env.advance(120);
  const still = env.events('claude_auth_still_blocked');
  assert.ok(still.length >= 1);
  const blockedAt = env.events('claude_auth_blocked')[0].fields.checkedAt;
  assert.ok(blockedAt < expiresAt + 200_000, 'blocked は probe より前');
  assert.equal(still.at(-1).fields.blockedForSec, Math.round((still.at(-1).fields.checkedAt - blockedAt) / 1000));
  assert.deepEqual(http.calls, { usage: 2, profile: 1 });

  // 新 token の通常成功だけが回復（1 回）。blocked → 新 token の即時 tick 要求は維持
  env.write({ accessToken: 'fake-probe-monitor-new', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.immediateTicks(), 1);
  const normalNew = await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  env.monitor.observeClaudeBatch(normalNew);
  env.monitor.observeClaudeBatch(normalNew);
  assert.equal(env.events('claude_auth_recovered').length, 1);
});

test('要求中に新 token へ切り替わった probe batch は現在世代に混入せず、回復にも数えない', async (t) => {
  const http = countingFetch();
  const env = setup(t, { probe: true, fetch: http.fn });
  const expiresAt = env.clock.now + 300_000;
  env.write({ accessToken: 'fake-stale-A', expiresAt });
  env.monitor.start();
  env.monitor.observeClaudeBatch(await env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 }));
  env.clock.now = expiresAt + 200_000;
  env.monitor.checkNow();
  assert.equal(env.monitor.publicStatus().state, 'expired');

  /** @type {(v:any) => void} */
  let release = () => {};
  http.setUsage(() => new Promise((resolve) => { release = resolve; }));
  const inFlight = env.provider.fetchSamples({ observedAt: env.clock.now, intervalSec: 180 });
  await new Promise((resolve) => setImmediate(resolve));
  // 要求中に B へ更新され、monitor が検知する
  env.write({ accessToken: 'fake-stale-B', expiresAt: env.clock.now + 8 * HOUR });
  env.advance(1);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  release({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 2, resets_at: null }, limits: [] }), text: async () => '' });
  const stale = await inFlight;
  assert.equal(stale.auth.requestKind, 'expiry_probe');
  assert.equal(stale.identity?.uuid, FAKE_UUID, '要求開始時の A の帰属');
  env.monitor.observeClaudeBatch(stale);
  assert.equal(env.monitor.publicStatus().state, 'valid');
  assert.equal(env.events('claude_auth_recovered').length, 0);
});
