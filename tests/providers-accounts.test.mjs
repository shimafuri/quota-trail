import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeProvider, fetchClaudeSamples, readAccessToken, readCredentialSnapshot } from '../src/main/providers/claude.mjs';
import { resolveAppServerIdentity } from '../src/main/providers/codex-app-server.mjs';
import { summarizeProbeStage } from '../src/main/lib/claude-auth-state.mjs';
import { createSleepInclusiveClock } from '../src/main/lib/elapsed-clock.mjs';

const uuidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uuidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** @returns {{ok:true,json:()=>Promise<any>,text:()=>Promise<string>}} */
function usageResponse() {
  return {
    ok: true,
    json: async () => ({
      five_hour: { utilization: 10, resets_at: '2026-01-01T01:00:00.000Z' },
      seven_day: { utilization: 20, resets_at: '2026-01-02T01:00:00.000Z' },
      limits: [{ kind: 'weekly_scoped', group: 'weekly', scope: { surface: null, model: { id: null, display_name: 'Fable' } }, percent: 80, resets_at: '2026-01-03T01:00:00.000Z', is_active: false }],
    }),
    text: async () => '',
  };
}

/** @param {string} token */
function writeCredentials(dir, token) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
}

test('Claude local fallback は 5 分後に再読込され、権威 cache へ昇格しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-fallback-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let currentTime = 1_000_000;
  let profileCalls = 0;
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    Date.now = () => currentTime;
    writeCredentials(dir, 'fallback-token-regression');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuidA } }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('/profile')) {
        profileCalls += 1;
        return { ok: false, text: async () => '' };
      }
      return usageResponse();
    };
    const first = await fetchClaudeSamples({ observedAt: currentTime, intervalSec: 180 });
    assert.equal(first.identity?.uuid, uuidA);
    assert.deepEqual(first.samples.map((s) => [s.window, s.usedPercent]), [['5h', 10], ['weekly', 20], ['weekly-fable', 80]]);
    currentTime += 5 * 60_000 + 1;
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuidB } }));
    const second = await fetchClaudeSamples({ observedAt: currentTime, intervalSec: 180 });
    assert.equal(second.identity?.uuid, uuidB);
    assert.equal(second.samples.length, 3);
    assert.equal(profileCalls, 2);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude usage の通信例外でも、同じ token の既知 identity を維持する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-network-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let currentTime = 2_000_000;
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    Date.now = () => currentTime;
    writeCredentials(dir, 'authoritative-token-regression');
    globalThis.fetch = async (url) => {
      if (String(url).includes('/profile')) return { ok: true, json: async () => ({ account: { uuid: uuidA } }) };
      return usageResponse();
    };
    const known = await fetchClaudeSamples({ observedAt: currentTime, intervalSec: 180 });
    assert.equal(known.identity?.uuid, uuidA);
    assert.equal(known.samples[2].usedPercent, 80);
    currentTime += 60 * 60_000 + 1;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/profile')) return { ok: false, text: async () => '' };
      throw new Error('offline');
    };
    const failed = await fetchClaudeSamples({ observedAt: currentTime, intervalSec: 180 });
    assert.equal(failed.samples[0].errorCode, 'network');
    assert.deepEqual(failed.samples.map((s) => [s.window, s.errorCode]), [['5h', 'network'], ['weekly', 'network'], ['weekly-fable', 'network']]);
    assert.equal(failed.identity?.uuid, uuidA);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex app-server は account/read が無くても前後 auth の同一 UUID へ帰属する', () => {
  const authIdentity = { provider: 'codex', uuid: uuidA, email: null, source: 'codex_auth', assurance: 'authoritative' };
  assert.deepEqual(resolveAppServerIdentity(authIdentity, authIdentity, null), authIdentity);
  assert.equal(resolveAppServerIdentity(authIdentity, { ...authIdentity, uuid: uuidB }, null), null);
});

// ---------------------------------------------------------------- §15.4 ローカル期限判定と送信抑止

const HOUR = 60 * 60_000;

/**
 * 一時 config dir に資格情報を書く（偽 token のみ）。
 * @param {string} dir
 * @param {Record<string, unknown>} oauth
 */
function writeOauth(dir, oauth) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth, organizationUuid: uuidA }));
}

/**
 * 呼び出し回数を数える fetch モック。
 * @param {{usage?:() => any, profile?:() => any}} [handlers]
 */
function mockFetch(handlers = {}) {
  const calls = { usage: 0, profile: 0 };
  const fn = async (url) => {
    if (String(url).includes('/profile')) {
      calls.profile += 1;
      return handlers.profile ? handlers.profile() : { ok: true, json: async () => ({ account: { uuid: uuidA } }) };
    }
    calls.usage += 1;
    return handlers.usage ? handlers.usage() : usageResponse();
  };
  return { fn, calls };
}

/**
 * 一時ディレクトリと時計・fetch を注入した provider を作る。
 * @param {import('node:test').TestContext} t
 * @param {{handlers?:any}} [options]
 */
function makeProvider(t, { handlers } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 9, 2, 0, 0, 0) };
  const fetchMock = mockFetch(handlers);
  const create = () => createClaudeProvider({
    readSnapshot: () => readCredentialSnapshot({ configDir: dir }),
    fetch: fetchMock.fn,
    now: () => clock.now,
    readLocalFallback: () => null,
  });
  return { dir, clock, fetchMock, provider: create(), create };
}

const ctxAt = (clock) => ({ observedAt: clock.now, intervalSec: 180 });

test('readCredentialSnapshot は refreshToken を返さず、expiresAt を検証し、互換 readAccessToken も動く', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-snap-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeOauth(dir, { accessToken: 'fake-access-token-snap', refreshToken: 'fake-refresh-token-must-not-leak', expiresAt: Date.UTC(2026, 9, 2, 8) });
  const snap = readCredentialSnapshot({ configDir: dir });
  assert.equal(snap.token, 'fake-access-token-snap');
  assert.equal(snap.expiresAt, Date.UTC(2026, 9, 2, 8));
  assert.equal(snap.expiryReason, null);
  assert.equal(snap.organizationUuid, uuidA);
  assert.equal(snap.errorCode, null);
  assert.equal(typeof snap.key, 'string');
  assert.equal(JSON.stringify(snap).includes('fake-refresh-token-must-not-leak'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'refreshToken'), false);

  writeOauth(dir, { accessToken: 'fake-access-token-snap', expiresAt: '2026-10-02T08:00:00Z' });
  assert.equal(readCredentialSnapshot({ configDir: dir }).expiryReason, 'invalid_expiry');
  writeOauth(dir, { accessToken: 'fake-access-token-snap' });
  assert.equal(readCredentialSnapshot({ configDir: dir }).expiryReason, 'missing_expiry');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{ broken');
  assert.equal(readCredentialSnapshot({ configDir: dir }).errorCode, 'parse');
  fs.rmSync(path.join(dir, '.credentials.json'));
  assert.equal(readCredentialSnapshot({ configDir: dir }).errorCode, 'no_credentials');

  process.env.CLAUDE_CONFIG_DIR = dir;
  writeOauth(dir, { accessToken: 'fake-access-token-compat', refreshToken: 'fake-refresh', expiresAt: Date.UTC(2026, 9, 2, 8) });
  assert.deepEqual(readAccessToken(), { token: 'fake-access-token-compat', organizationUuid: uuidA, errorCode: null });
});

test('期限切れ token は usage/profile とも 0 回で Claude 3 行 auth_expired_local、identity は unknown', async (t) => {
  const { dir, clock, fetchMock, provider } = makeProvider(t);
  writeOauth(dir, { accessToken: 'fake-expired-token', expiresAt: clock.now - 1 });
  const batch = await provider.fetchSamples(ctxAt(clock));
  assert.deepEqual(batch.samples.map((s) => [s.window, s.status, s.errorCode, s.usedPercent, s.resetsAt]), [
    ['5h', 'error', 'auth_expired_local', null, null],
    ['weekly', 'error', 'auth_expired_local', null, null],
    ['weekly-fable', 'error', 'auth_expired_local', null, null],
  ]);
  assert.equal(batch.identity, null);
  assert.equal(batch.auth.state, 'expired');
  assert.deepEqual(fetchMock.calls, { usage: 0, profile: 0 });
  // 起動 probe も要求しない
  assert.equal(await provider.resolveInitialIdentity(), null);
  assert.deepEqual(fetchMock.calls, { usage: 0, profile: 0 });
});

test('30 秒以内に期限が来る token は auth_expiring で要求しない', async (t) => {
  const { dir, clock, fetchMock, provider } = makeProvider(t);
  writeOauth(dir, { accessToken: 'fake-expiring-token', expiresAt: clock.now + 30_000 });
  const batch = await provider.fetchSamples(ctxAt(clock));
  assert.deepEqual(batch.samples.map((s) => s.errorCode), ['auth_expiring', 'auth_expiring', 'auth_expiring']);
  assert.deepEqual(fetchMock.calls, { usage: 0, profile: 0 });
});

test('期限不明は通常取得し、usage 401 の後は同じ token を再送しない。mtime/期限だけの変更では解除しない', async (t) => {
  let usageStatus = 401;
  const { dir, clock, fetchMock, provider } = makeProvider(t, {
    handlers: { usage: () => (usageStatus === 401 ? { ok: false, status: 401, text: async () => '' } : usageResponse()) },
  });
  writeOauth(dir, { accessToken: 'fake-unknown-expiry-token' });
  const first = await provider.fetchSamples(ctxAt(clock));
  assert.deepEqual(first.samples.map((s) => s.errorCode), ['auth_expired', 'auth_expired', 'auth_expired']);
  assert.equal(first.auth.source, 'http_401');
  assert.equal(fetchMock.calls.usage, 1);
  assert.equal(fetchMock.calls.profile, 1);

  clock.now += 3 * 60_000;
  const second = await provider.fetchSamples(ctxAt(clock));
  assert.deepEqual(second.samples.map((s) => s.errorCode), ['auth_expired', 'auth_expired', 'auth_expired']);
  assert.equal(second.auth.source, 'cached_401');
  // 同 token の identity は維持する（profile は成功していた）
  assert.equal(second.identity?.uuid, uuidA);
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  // 同じ token のまま expiresAt だけ未来へ書き換えても（mtime も変わる）送信しない
  writeOauth(dir, { accessToken: 'fake-unknown-expiry-token', expiresAt: clock.now + 8 * HOUR });
  clock.now += 3 * 60_000;
  const third = await provider.fetchSamples(ctxAt(clock));
  assert.equal(third.samples[0].errorCode, 'auth_expired');
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  // 新 token で回復する。旧 token の identity は流用せず、新 token を profile で確認する
  usageStatus = 200;
  writeOauth(dir, { accessToken: 'fake-new-token', expiresAt: clock.now + 8 * HOUR });
  clock.now += 3 * 60_000;
  const recovered = await provider.fetchSamples(ctxAt(clock));
  assert.deepEqual(recovered.samples.map((s) => s.status), ['ok', 'ok', 'ok']);
  assert.equal(recovered.auth.source, 'http_ok');
  assert.deepEqual(fetchMock.calls, { usage: 2, profile: 2 });
});

test('同 token は期限切れ後も既知 identity を維持し、新 token・再起動では unknown になる', async (t) => {
  const { dir, clock, fetchMock, provider, create } = makeProvider(t);
  const expiresAt = clock.now + 8 * HOUR;
  writeOauth(dir, { accessToken: 'fake-token-a', expiresAt });
  const valid = await provider.fetchSamples(ctxAt(clock));
  assert.equal(valid.identity?.uuid, uuidA);
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  clock.now = expiresAt + 3 * 60_000;
  const expired = await provider.fetchSamples(ctxAt(clock));
  assert.equal(expired.samples[0].errorCode, 'auth_expired_local');
  assert.equal(expired.identity?.uuid, uuidA);
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  // 時計が戻っても同じ token の送信は再開しない
  clock.now = expiresAt - HOUR;
  const rolledBack = await provider.fetchSamples(ctxAt(clock));
  assert.equal(rolledBack.samples[0].errorCode, 'auth_expired_local');
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  // 別の期限切れ token は旧 token の identity を継承しない
  clock.now = expiresAt + HOUR;
  writeOauth(dir, { accessToken: 'fake-token-b-expired', expiresAt: expiresAt + 1 });
  const otherToken = await provider.fetchSamples(ctxAt(clock));
  assert.equal(otherToken.identity, null);

  // 再起動（新インスタンス）後は cache が無いので unknown
  writeOauth(dir, { accessToken: 'fake-token-a', expiresAt });
  const restarted = create();
  const afterRestart = await restarted.fetchSamples(ctxAt(clock));
  assert.equal(afterRestart.samples[0].errorCode, 'auth_expired_local');
  assert.equal(afterRestart.identity, null);
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });

  // cache 除去（24 時間 idle）後も unknown
  clock.now += 25 * HOUR;
  const pruned = await provider.fetchSamples(ctxAt(clock));
  assert.equal(pruned.identity, null);
});

test('起動 probe は usage を取得せず、予算を超えた profile 要求を最初の tick と共有する', async (t) => {
  /** @type {() => void} */
  let releaseProfile = () => {};
  const { dir, clock, fetchMock, provider } = makeProvider(t, {
    handlers: {
      profile: () => new Promise((resolve) => {
        releaseProfile = () => resolve({ ok: true, json: async () => ({ account: { uuid: uuidB } }) });
      }),
    },
  });
  writeOauth(dir, { accessToken: 'fake-startup-token', expiresAt: clock.now + 8 * HOUR });
  const probe = provider.resolveInitialIdentity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchMock.calls, { usage: 0, profile: 1 });
  assert.equal(provider.inFlightProfileCount(), 1);
  const tick = provider.fetchSamples(ctxAt(clock));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });
  releaseProfile();
  const [identity, batch] = await Promise.all([probe, tick]);
  assert.equal(identity?.uuid, uuidB);
  assert.equal(batch.identity?.uuid, uuidB);
  assert.deepEqual(fetchMock.calls, { usage: 1, profile: 1 });
  assert.equal(provider.inFlightProfileCount(), 0);
});

// ---------------------------------------------------------------- §15.12 期限超過後の確認送信

const SEC = 1000;
const STAGE_DELAY_SEC = { '3m': 180, '30m': 1_800, '2h': 7_200, '6h': 21_600, '8h': 28_800 };

/**
 * 確認送信の試験環境。偽資格情報・注入 fetch・壁時計 W・睡眠を含む経過時計 E・logger・設定保存をすべて注入する。
 * 応答や UA などの差し替えは `p.env.*` に対して行う。
 * @param {import('node:test').TestContext} t
 * @param {{mode?:'off'|'once', withConfig?:boolean, saveResult?:boolean}} [options]
 */
function makeProbeEnv(t, { mode = 'once', withConfig = true, saveResult = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 9, 2, 0, 0, 0), e: /** @type {number|null} */ (5_000_000) };
  const cfg = { claudeExpiredUsageProbe: mode, pollIntervalSec: 180, claudeAuthNotifications: true };
  const calls = { usage: 0, profile: 0, save: 0 };
  /** @type {{level:string, msg:string, fields:any}[]} */
  const logs = [];
  const env = {
    saveResult,
    ua: 'claude-code/2.1.284',
    currentDir: dir,
    /** @type {() => any} */
    usage: () => usageResponse(),
    /** @type {() => any} */
    profile: () => ({ ok: true, json: async () => ({ account: { uuid: uuidA } }) }),
    /** @type {any} */
    localFallback: null,
  };
  const create = () => createClaudeProvider({
    readSnapshot: () => readCredentialSnapshot({ configDir: env.currentDir }),
    // 同期例外も再現できるよう async にしない
    fetch: (url) => {
      if (String(url).includes('/profile')) {
        calls.profile += 1;
        return Promise.resolve(env.profile());
      }
      calls.usage += 1;
      const response = env.usage();
      return response instanceof Promise ? response : Promise.resolve(response);
    },
    now: () => clock.now,
    readLocalFallback: () => env.localFallback,
    userAgent: () => env.ua,
    ...(withConfig ? { readConfig: () => ({ ...cfg }) } : {}),
    logger: {
      info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    },
    elapsedNow: () => clock.e,
    saveProbeOff: () => {
      calls.save += 1;
      if (env.saveResult) cfg.claudeExpiredUsageProbe = 'off';
      return env.saveResult;
    },
  });
  /** 壁時計と経過時計を同じだけ進める（睡眠中も E は進む） */
  const advance = (ms) => {
    clock.now += ms;
    if (clock.e !== null) clock.e += ms;
  };
  const setNow = (at) => advance(at - clock.now);
  const write = (token, extra = {}) => writeOauth(env.currentDir, { accessToken: token, refreshToken: `refresh-${token}`, ...extra });
  const events = (msg) => logs.filter((entry) => entry.msg === msg);
  const snapshot = () => readCredentialSnapshot({ configDir: env.currentDir });
  return { dir, clock, cfg, calls, logs, env, create, provider: create(), advance, setNow, write, events, snapshot };
}

/**
 * 期限前の通常 usage 成功（期限余裕 300 秒）で対照を作り、段を割り当てる。期限を返す。
 * @param {ReturnType<typeof makeProbeEnv>} p
 * @param {string} token
 */
async function assignBaseline(p, token) {
  const expiresAt = p.clock.now + 300 * SEC;
  p.write(token, { expiresAt });
  const batch = await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.equal(batch.auth.requestKind, 'normal');
  return expiresAt;
}

/**
 * 期限 + delaySec の時刻で tick 相当の取得を行う。
 * @param {ReturnType<typeof makeProbeEnv>} p
 * @param {number} expiresAt
 * @param {number} delaySec
 */
async function fetchAtDelay(p, expiresAt, delaySec) {
  p.setNow(expiresAt + delaySec * SEC);
  return p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
}

const SECRET_PATTERNS = ['fake-', 'refresh-', 'Bearer', uuidA, uuidB, '@', 'quota-trail-claude-probe-'];

/** 確認送信のログに秘密（token・refresh token・UUID・config dir 等）が入っていないこと */
function assertLogsSafe(logs) {
  for (const entry of logs) {
    const json = JSON.stringify(entry.fields ?? {});
    for (const secret of SECRET_PATTERNS) {
      assert.equal(json.includes(secret), false, `${entry.msg} に ${secret}`);
    }
    // 64 桁 hex（fingerprint / 内部キー）も入れない
    assert.equal(/[0-9a-f]{64}/.test(json), false, `${entry.msg} に hex`);
  }
}

test('確認送信 OFF（既定）: 期限を跨いでも全段の窓で usage/profile とも期限後 0 回、probe ログなし（旧段階 A と同じ）', async (t) => {
  for (const variant of [{ mode: /** @type {'off'} */ ('off') }, { withConfig: false }]) {
    const p = makeProbeEnv(t, variant);
    const expiresAt = await assignBaseline(p, 'fake-off-token');
    assert.deepEqual([p.calls.usage, p.calls.profile], [1, 1]);
    for (const delay of [180, 1_800, 7_200, 21_600, 28_800]) {
      const batch = await fetchAtDelay(p, expiresAt, delay + 10);
      assert.deepEqual(batch.samples.map((s) => s.errorCode), ['auth_expired_local', 'auth_expired_local', 'auth_expired_local']);
      assert.equal(batch.auth.requestKind, 'local_gate');
    }
    assert.deepEqual([p.calls.usage, p.calls.profile], [1, 1]);
    assert.equal(p.logs.filter((entry) => entry.msg.startsWith('claude_auth_expiry_probe')).length, 0);
    assert.equal(p.provider.expiryProbeStatus().ledgerSize, 0);
  }
});

test('起動時から expired・ON 時点で expired・対照が OFF 中の要求なら確認送信は 0 回、予算も消費しない', async (t) => {
  // 起動時から期限切れ（once でも対照がない）
  const p = makeProbeEnv(t);
  p.write('fake-startup-expired', { expiresAt: p.clock.now - 1 });
  assert.equal(await p.provider.resolveInitialIdentity(), null);
  for (const delay of [180, 1_800, 7_200]) {
    p.advance(delay * SEC);
    await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  }
  assert.deepEqual([p.calls.usage, p.calls.profile], [0, 0]);
  const skipped = p.events('claude_auth_expiry_probe_skipped');
  assert.equal(skipped.length, 1, 'token ごとに一度だけ');
  assert.equal(skipped[0].fields.reason, 'no_preexpiry_success');
  assert.equal(skipped[0].fields.stage, null);
  assert.equal(p.provider.expiryProbeStatus().totalSpent, 0);

  // 対照の要求時は OFF、その後 ON にしても割り当てない
  const q = makeProbeEnv(t, { mode: 'off' });
  const expiresAt = await assignBaseline(q, 'fake-baseline-while-off');
  q.cfg.claudeExpiredUsageProbe = 'once';
  await fetchAtDelay(q, expiresAt, 200);
  await fetchAtDelay(q, expiresAt, 400);
  assert.deepEqual([q.calls.usage, q.calls.profile], [1, 1]);
  assert.equal(q.events('claude_auth_expiry_probe_assigned').length, 0);
});

test('異なる token に 3m→30m→2h→6h→8h→3m を順に割り当て、各窓で usage 1 回・profile 0、200 後も通常取得を再開しない', async (t) => {
  const p = makeProbeEnv(t);
  const order = ['3m', '30m', '2h', '6h', '8h', '3m'];
  for (let i = 0; i < order.length; i++) {
    const stage = order[i];
    const before = { ...p.calls };
    const expiresAt = p.clock.now + 380 * SEC;
    p.write(`fake-ladder-${i}`, { expiresAt });
    await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
    // 期限前にもう一度通常 usage が成功しても再割当しない（対照だけ更新）
    p.advance(180 * SEC);
    await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
    assert.equal(p.events('claude_auth_expiry_probe_assigned').length, i + 1);
    assert.equal(p.events('claude_auth_expiry_probe_assigned')[i].fields.stage, stage);
    assert.equal(p.provider.expiryProbeStatus().pendingStage, stage);

    // 下限前は送信ゼロ
    const early = await fetchAtDelay(p, expiresAt, STAGE_DELAY_SEC[stage] - 1);
    assert.equal(early.samples[0].errorCode, 'auth_expired_local');
    // 窓内の最初の呼出しで usage 1 回・profile 0
    const probed = await fetchAtDelay(p, expiresAt, STAGE_DELAY_SEC[stage] + 100);
    assert.deepEqual(probed.samples.map((s) => [s.status, s.errorCode]), [['ok', null], ['ok', null], ['ok', null]]);
    assert.deepEqual(probed.auth, { key: probed.auth.key, state: 'expired', errorCode: null, source: 'http_ok', requestKind: 'expiry_probe' });
    // 同 token の権威 identity を帰属に使う（profile 再取得なし）
    assert.equal(probed.identity?.uuid, uuidA);
    // 次の tick（窓内のまま）も通常取得を再開しない
    const after = await fetchAtDelay(p, expiresAt, STAGE_DELAY_SEC[stage] + 200);
    assert.equal(after.samples[0].errorCode, 'auth_expired_local');
    assert.equal(after.auth.requestKind, 'local_gate');
    assert.equal(p.provider.classify(p.snapshot()).state, 'expired');
    assert.deepEqual([p.calls.usage - before.usage, p.calls.profile - before.profile], [3, 1], `${stage}: 通常 2 + probe 1、profile は期限前の 1 回だけ`);
    p.advance(60 * SEC);
  }
  const start = p.events('claude_auth_expiry_probe_start');
  assert.deepEqual(start.map((e) => e.fields.stage), order);
  const first = start[0].fields;
  assert.equal(first.probeNo, 1);
  assert.equal(first.expiredForSec, 280);
  assert.equal(first.scheduleLateSec, 100);
  assert.equal(first.targetDelaySec, 180);
  assert.equal(first.windowEndDelaySec, 480);
  assert.equal(first.preexpiryLeadSec, 200, '最終対照は 2 回目の通常 usage（期限 200 秒前）');
  assert.equal(first.lastUsageOkAgeSec, 480);
  assert.equal(first.intervalSec, 180);
  assert.deepEqual(
    [first.expiryStable, first.clockSuspect, first.clockSource, first.clockDeltaSec, first.suspendCount, first.suspendedForSec],
    [true, false, 'sleep_inclusive', 0, 0, 0],
  );
  const result = p.events('claude_auth_expiry_probe_result')[0].fields;
  assert.deepEqual(
    [result.outcome, result.httpStatus, result.errorCode, result.parseOk, result.okWindowCount, result.nextAction],
    ['http_200', 200, null, true, 3, 'local_gate'],
  );
  assert.equal(result.observedAt, first.observedAt);
  assert.equal(result.requestStartedAt, first.requestStartedAt);
  assert.equal(p.events('claude_auth_expiry_probe_assigned')[0].fields.windowEndDelaySec, 480);
  assert.equal(p.provider.expiryProbeStatus().stages['3m'].spent, 2);
  assertLogsSafe(p.logs);
});

test('遅延上限を超えたら late_probe で失効し、別段への振替・追い付き送信はしない', async (t) => {
  const p = makeProbeEnv(t);
  const expiresAt = await assignBaseline(p, 'fake-late-token');
  const late = await fetchAtDelay(p, expiresAt, 480.001);
  assert.equal(late.samples[0].errorCode, 'auth_expired_local');
  for (const delay of [1_800, 1_900, 7_200, 21_600, 28_800]) await fetchAtDelay(p, expiresAt, delay);
  assert.equal(p.calls.usage, 1);
  const skipped = p.events('claude_auth_expiry_probe_skipped');
  assert.equal(skipped.length, 1);
  assert.deepEqual([skipped[0].fields.reason, skipped[0].fields.stage, skipped[0].fields.targetDelaySec], ['late_probe', '3m', 180]);
  const stats = p.provider.expiryProbeStatus().stages['3m'];
  assert.deepEqual([stats.assigned, stats.spent, stats.skipped.late_probe], [1, 0, 1]);
});

test('全結果（200/401/429/network/timeout/body timeout/JSON 不正/403/500/同期 fetch 例外）で予算を消費し、2 回目はゼロ', async (t) => {
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const cases = [
    { name: '200', usage: () => usageResponse(), codes: [null, null, null], outcome: 'http_200', httpStatus: 200, parseOk: true, ok: 3 },
    { name: '401', usage: () => ({ ok: false, status: 401, text: async () => '' }), codes: ['auth_expired', 'auth_expired', 'auth_expired'], outcome: 'http_401', httpStatus: 401, parseOk: null, ok: 0 },
    { name: '429', usage: () => ({ ok: false, status: 429, text: async () => '' }), codes: ['http_429', 'http_429', 'http_429'], outcome: 'http_429', httpStatus: 429, parseOk: null, ok: 0 },
    { name: 'network', usage: () => Promise.reject(new Error('offline')), codes: ['network', 'network', 'network'], outcome: 'network', httpStatus: null, parseOk: null, ok: 0 },
    { name: 'timeout', usage: () => Promise.reject(abortError()), codes: ['timeout', 'timeout', 'timeout'], outcome: 'timeout', httpStatus: null, parseOk: null, ok: 0 },
    { name: 'body timeout', usage: () => ({ ok: true, status: 200, json: async () => { throw abortError(); }, text: async () => '' }), codes: ['timeout', 'timeout', 'timeout'], outcome: 'http_200', httpStatus: 200, parseOk: null, ok: 0 },
    { name: 'JSON 不正', usage: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); }, text: async () => '' }), codes: ['parse', 'parse', 'parse'], outcome: 'http_200', httpStatus: 200, parseOk: false, ok: 0 },
    { name: '403', usage: () => ({ ok: false, status: 403, text: async () => '' }), codes: ['auth_expired', 'auth_expired', 'auth_expired'], outcome: 'http_other', httpStatus: 403, parseOk: null, ok: 0 },
    { name: '500', usage: () => ({ ok: false, status: 500, text: async () => '' }), codes: ['http_500', 'http_500', 'http_500'], outcome: 'http_other', httpStatus: 500, parseOk: null, ok: 0 },
    { name: '同期例外', usage: () => { throw new Error('sync'); }, codes: ['network', 'network', 'network'], outcome: 'network', httpStatus: null, parseOk: null, ok: 0 },
  ];
  for (const c of cases) {
    const p = makeProbeEnv(t);
    const expiresAt = await assignBaseline(p, `fake-outcome-${c.name}`);
    p.env.usage = c.usage;
    const batch = await fetchAtDelay(p, expiresAt, 200);
    assert.deepEqual(batch.samples.map((s) => s.errorCode), c.codes, c.name);
    assert.equal(batch.auth.requestKind, 'expiry_probe', c.name);
    const result = p.events('claude_auth_expiry_probe_result');
    assert.equal(result.length, 1, c.name);
    assert.deepEqual(
      [result[0].fields.outcome, result[0].fields.httpStatus, result[0].fields.parseOk, result[0].fields.okWindowCount],
      [c.outcome, c.httpStatus, c.parseOk, c.ok],
      c.name,
    );
    assert.equal(result[0].level, ['http_401', 'http_429', 'network', 'timeout'].includes(c.outcome) ? 'warn' : 'info', c.name);
    assert.equal(result[0].fields.nextAction, c.name === '401' ? 'cached_401' : 'local_gate', c.name);
    // 2 回目は送らない（窓内でも、OFF→ON でも予算は戻らない）
    p.cfg.claudeExpiredUsageProbe = 'off';
    await fetchAtDelay(p, expiresAt, 250);
    p.cfg.claudeExpiredUsageProbe = 'once';
    const second = await fetchAtDelay(p, expiresAt, 300);
    assert.deepEqual([p.calls.usage, p.calls.profile], [2, 1], c.name);
    assert.equal(second.samples[0].errorCode, c.name === '401' ? 'auth_expired' : 'auth_expired_local', c.name);
    assert.equal(second.auth.source, c.name === '401' ? 'cached_401' : 'local', c.name);
    assert.equal(p.provider.expiryProbeStatus().totalSpent, 1, c.name);
    assertLogsSafe(p.logs);
  }
});

test('手動連打・並行呼出しでも token と段の予算は 1 回だけ', async (t) => {
  const p = makeProbeEnv(t);
  const expiresAt = await assignBaseline(p, 'fake-concurrent');
  /** @type {(v:any) => void} */
  let release = () => {};
  p.env.usage = () => new Promise((resolve) => { release = resolve; });
  p.setNow(expiresAt + 200 * SEC);
  const ctx = { observedAt: p.clock.now, intervalSec: 180 };
  const batches = [p.provider.fetchSamples(ctx), p.provider.fetchSamples(ctx), p.provider.fetchSamples(ctx)];
  await new Promise((resolve) => setImmediate(resolve));
  release(usageResponse());
  const results = await Promise.all(batches);
  assert.deepEqual(results.map((b) => b.auth.requestKind), ['expiry_probe', 'local_gate', 'local_gate']);
  assert.deepEqual([p.calls.usage, p.calls.profile], [2, 1]);
  assert.equal(p.provider.expiryProbeStatus().stages['3m'].spent, 1);
});

test('待機中の新 token・config dir 切替で旧予約は失効し、A→B→A でも復活しない', async (t) => {
  const p = makeProbeEnv(t);
  const expiresA = await assignBaseline(p, 'fake-token-A');
  // B へ更新（有効）→ A の予約は token_replaced
  p.advance(60 * SEC);
  p.write('fake-token-B', { expiresAt: p.clock.now + 8 * HOUR });
  p.provider.classify(p.snapshot());
  // A へ戻しても再予約しない
  p.write('fake-token-A', { expiresAt: expiresA });
  for (const delay of [200, 400]) await fetchAtDelay(p, expiresA, delay);
  assert.equal(p.calls.usage, 1);
  const skipped = p.events('claude_auth_expiry_probe_skipped');
  assert.deepEqual(skipped.map((e) => [e.fields.reason, e.fields.stage]), [['token_replaced', '3m']]);
  assert.equal(p.provider.expiryProbeStatus().stages['3m'].skipped.token_replaced, 1);
  // 失効でもカーソルは進む（次の token は 30m）
  p.advance(HOUR);
  await assignBaseline(p, 'fake-token-C');
  assert.equal(p.provider.expiryProbeStatus().pendingStage, '30m');

  // config dir の切替（同じ token 値でも）で失効
  const q = makeProbeEnv(t);
  const expiresQ = await assignBaseline(q, 'fake-dir-token');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-claude-probe-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  q.env.currentDir = otherDir;
  q.write('fake-dir-token', { expiresAt: expiresQ });
  await fetchAtDelay(q, expiresQ, 200);
  q.env.currentDir = q.dir;
  await fetchAtDelay(q, expiresQ, 300);
  assert.equal(q.calls.usage, 1);
  assert.equal(q.events('claude_auth_expiry_probe_skipped')[0].fields.reason, 'token_replaced');
});

test('期限改変・欠落、読取失敗、OFF→ON、poll/UA 変更で失効。mtime だけ・通知設定の変更なら維持', async (t) => {
  /** @type {[string, (p:ReturnType<typeof makeProbeEnv>, expiresAt:number) => void, string|null][]} */
  const cases = [
    ['期限改変', (p, expiresAt) => p.write('fake-mutate', { expiresAt: expiresAt + 1 }), 'expiry_changed'],
    ['期限を戻す', (p, expiresAt) => {
      p.write('fake-mutate', { expiresAt: expiresAt + 1 });
      p.provider.classify(p.snapshot());
      p.write('fake-mutate', { expiresAt });
    }, 'expiry_changed'],
    ['期限欠落', (p) => p.write('fake-mutate'), 'expiry_changed'],
    ['期限不正', (p) => p.write('fake-mutate', { expiresAt: '2026-10-02T08:00:00Z' }), 'expiry_changed'],
    ['読取失敗', (p) => fs.rmSync(path.join(p.dir, '.credentials.json')), 'credential_unavailable'],
    ['JSON 破損', (p) => fs.writeFileSync(path.join(p.dir, '.credentials.json'), '{ broken'), 'credential_unavailable'],
    ['OFF→ON', (p) => {
      p.cfg.claudeExpiredUsageProbe = 'off';
      p.provider.classify(p.snapshot());
      p.cfg.claudeExpiredUsageProbe = 'once';
    }, 'configured_off'],
    ['poll 変更', (p) => { p.cfg.pollIntervalSec = 240; }, 'config_changed'],
    ['UA 変更', (p) => { p.env.ua = 'claude-code/2.1.290'; }, 'config_changed'],
    ['mtime だけ', (p, expiresAt) => p.write('fake-mutate', { expiresAt }), null],
    ['通知設定', (p) => { p.cfg.claudeAuthNotifications = false; }, null],
  ];
  for (const [name, mutate, reason] of cases) {
    const p = makeProbeEnv(t);
    const expiresAt = await assignBaseline(p, 'fake-mutate');
    p.advance(60 * SEC);
    mutate(p, expiresAt);
    p.provider.classify(p.snapshot());
    // 元の値に戻しても復活させない
    p.write('fake-mutate', { expiresAt });
    p.cfg.pollIntervalSec = 180;
    p.env.ua = 'claude-code/2.1.284';
    const batch = await fetchAtDelay(p, expiresAt, 200);
    const skipped = p.events('claude_auth_expiry_probe_skipped');
    if (reason) {
      assert.equal(p.calls.usage, 1, name);
      assert.equal(batch.auth.requestKind, 'local_gate', name);
      assert.equal(skipped[0]?.fields.reason, reason, name);
    } else {
      assert.equal(p.calls.usage, 2, name);
      assert.equal(batch.auth.requestKind, 'expiry_probe', name);
      assert.equal(skipped.length, 0, name);
    }
  }
});

test('帰属は同 token の権威 cache だけ。local fallback のみなら unknown、要求中の A→B でも旧 snapshot に保存', async (t) => {
  // profile 失敗・local fallback のみ → 通常取得は fallback、確認送信は unknown、profile 再取得なし
  const p = makeProbeEnv(t);
  p.env.profile = () => ({ ok: false, status: 500, text: async () => '' });
  p.env.localFallback = { provider: 'claude', uuid: uuidB, email: null, source: 'claude_local', assurance: 'local' };
  const expiresAt = p.clock.now + 300 * SEC;
  p.write('fake-fallback-only', { expiresAt });
  const normal = await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.equal(normal.identity?.uuid, uuidB);
  const probed = await fetchAtDelay(p, expiresAt, 200);
  assert.equal(probed.auth.requestKind, 'expiry_probe');
  assert.equal(probed.identity, null);
  assert.deepEqual([p.calls.usage, p.calls.profile], [2, 1]);

  // 要求中に B へ切り替わっても、結果は要求開始時の A の帰属で返す
  const q = makeProbeEnv(t);
  const expiresA = await assignBaseline(q, 'fake-inflight-A');
  /** @type {(v:any) => void} */
  let release = () => {};
  q.env.usage = () => new Promise((resolve) => { release = resolve; });
  const pending = fetchAtDelay(q, expiresA, 200);
  await new Promise((resolve) => setImmediate(resolve));
  q.env.profile = () => ({ ok: true, json: async () => ({ account: { uuid: uuidB } }) });
  q.write('fake-inflight-B', { expiresAt: q.clock.now + 8 * HOUR });
  release(usageResponse());
  const batch = await pending;
  assert.equal(batch.identity?.uuid, uuidA);
  assert.notEqual(batch.auth.key, q.snapshot().key);
  assert.equal(q.calls.profile, 1);
});

test('profile 8 件 cache・401 の 16 件 latch が除去されても、消費済み予算と台帳の 401 禁止は維持する', async (t) => {
  const p = makeProbeEnv(t);
  p.env.usage = () => ({ ok: false, status: 401, text: async () => '' });
  const expiresX = await assignBaseline(p, 'fake-ledger-X'); // 通常 usage 401 → 対照なし
  assert.equal(p.events('claude_auth_expiry_probe_assigned').length, 0);
  p.env.usage = () => usageResponse();
  const expiresY = await assignBaseline(p, 'fake-ledger-Y');
  p.env.usage = () => ({ ok: false, status: 401, text: async () => '' });
  await fetchAtDelay(p, expiresY, 200); // probe 401
  assert.equal(p.calls.usage, 3);
  // 期限不明の別 token 17 件が通常 usage 401 → 16 件 latch と 8 件 profile cache から X / Y が押し出される
  for (let i = 0; i < 17; i++) {
    p.write(`fake-evict-${i}`);
    await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  }
  assert.equal(p.calls.usage, 20);
  // Y は台帳の 401 で cached_401、X も通常 401 を台帳に記録済み
  p.write('fake-ledger-Y', { expiresAt: expiresY });
  const y = await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.deepEqual([y.auth.source, y.samples[0].errorCode], ['cached_401', 'auth_expired']);
  p.write('fake-ledger-X', { expiresAt: expiresX });
  const x = await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.deepEqual([x.auth.source, x.samples[0].errorCode], ['cached_401', 'auth_expired']);
  // 期限を未来へ書き換えても送らない
  p.write('fake-ledger-Y', { expiresAt: p.clock.now + 8 * HOUR });
  await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.equal(p.calls.usage, 20);
});

test('128 件の非削除台帳が満杯なら既存記録を捨てずに確認送信を停止し、設定を off に保存する。再起動で expired を再 probe しない', async (t) => {
  const p = makeProbeEnv(t);
  const expiresY = await assignBaseline(p, 'fake-full-Y');
  p.env.usage = () => ({ ok: false, status: 401, text: async () => '' });
  await fetchAtDelay(p, expiresY, 200);
  p.env.usage = () => usageResponse();
  const synthetic = (token) => ({ token, key: `key-${token}`, expiresAt: p.clock.now + HOUR, expiryReason: null, organizationUuid: null, configDir: p.dir, errorCode: null });
  for (let i = 0; i < 127; i++) p.provider.classify(synthetic(`fake-fill-${i}`));
  assert.equal(p.provider.expiryProbeStatus().ledgerSize, 128);
  assert.equal(p.provider.expiryProbeStatus().active, true);
  p.provider.classify(synthetic('fake-fill-overflow'));
  const status = p.provider.expiryProbeStatus();
  assert.deepEqual([status.active, status.closedReason, status.ledgerSize], [false, 'ledger_full', 128]);
  assert.equal(p.calls.save, 1);
  const disabled = p.events('claude_auth_expiry_probe_disabled').at(-1);
  assert.deepEqual([disabled.level, disabled.fields.reason], ['warn', 'ledger_full']);
  // 既存の 401 記録は残る
  p.write('fake-full-Y', { expiresAt: p.clock.now + 8 * HOUR });
  assert.equal(p.provider.classify(p.snapshot()).source, 'cached_401');
  // 新しい token は ON に戻しても割り当てない（閉じたセッションは再開しない）
  p.cfg.claudeExpiredUsageProbe = 'once';
  const expiresZ = await assignBaseline(p, 'fake-full-Z');
  await fetchAtDelay(p, expiresZ, 200);
  assert.equal(p.events('claude_auth_expiry_probe_assigned').length, 1);
  assert.equal(p.calls.usage, 3);

  // 再起動（新インスタンス）: expired の token へ再配布しない
  const restarted = p.create();
  await restarted.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  p.advance(200 * SEC);
  await restarted.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.equal(p.calls.usage, 3);
});

test('各段 4 件・合計 20 件の予算消費で停止し、満杯段を飛ばす。未送信失効はカーソルを進めても枠を消費しない', async (t) => {
  const p = makeProbeEnv(t);
  // 一件目は割当後に新 token で失効（3m の枠は消費しない）
  await assignBaseline(p, 'fake-budget-void');
  p.advance(60 * SEC);
  let n = 0;
  const probeOne = async () => {
    const token = `fake-budget-${n++}`;
    const expiresAt = await assignBaseline(p, token);
    const stage = /** @type {keyof typeof STAGE_DELAY_SEC} */ (p.provider.expiryProbeStatus().pendingStage);
    const batch = await fetchAtDelay(p, expiresAt, STAGE_DELAY_SEC[stage] + 1);
    assert.equal(batch.auth.requestKind, 'expiry_probe', `${token} ${stage}`);
    p.advance(60 * SEC);
    return stage;
  };
  const stages = [];
  for (let i = 0; i < 20; i++) stages.push(await probeOne());
  // 失効した 3m の次から 30m→…→8h→3m と回る
  assert.deepEqual(stages.slice(0, 5), ['30m', '2h', '6h', '8h', '3m']);
  const status = p.provider.expiryProbeStatus();
  assert.deepEqual(Object.values(status.stages).map((s) => s.spent), [4, 4, 4, 4, 4]);
  assert.equal(status.stages['3m'].assigned, 5);
  assert.equal(status.stages['3m'].skipped.token_replaced, 1);
  assert.deepEqual([status.active, status.closedReason, status.totalSpent], [false, 'budget_limit', 20]);
  assert.equal(p.calls.save, 1);
  // 20 件目の結果も記録し、停止後の新 token は割り当てない
  assert.equal(p.events('claude_auth_expiry_probe_result').length, 20);
  const expiresAt = await assignBaseline(p, 'fake-budget-after');
  await fetchAtDelay(p, expiresAt, 200);
  assert.equal(p.events('claude_auth_expiry_probe_start').length, 20);
  const disabled = p.events('claude_auth_expiry_probe_disabled').find((e) => e.fields.reason === 'budget_limit');
  assert.ok(disabled);
  // 停止ログは件数だけ（割合は出さない）。セッション開始時刻と経過秒を含む
  assert.equal(Object.prototype.hasOwnProperty.call(disabled.fields.stages['3m'], 'acceptanceRate'), false);
  assert.equal(typeof disabled.fields.sessionStartedAt, 'number');
  assert.ok(disabled.fields.elapsedSec > 0);
  assertLogsSafe(p.logs);
});

test('最初の once から 7 日ちょうどで停止する。OFF の期間も含め、OFF→ON で期間・カーソル・消費数をリセットしない', async (t) => {
  const p = makeProbeEnv(t);
  const sessionStart = p.clock.now;
  // 一件目（3m）を消費
  const e1 = await assignBaseline(p, 'fake-week-1');
  await fetchAtDelay(p, e1, 200);
  // OFF → 3 日後に ON（期間はリセットしない）
  p.cfg.claudeExpiredUsageProbe = 'off';
  p.provider.classify(p.snapshot());
  p.setNow(sessionStart + 3 * 24 * HOUR);
  p.cfg.claudeExpiredUsageProbe = 'once';
  const e2 = await assignBaseline(p, 'fake-week-2');
  assert.equal(p.provider.expiryProbeStatus().pendingStage, '30m', 'カーソルは継続');
  assert.equal(p.provider.expiryProbeStatus().stages['3m'].spent, 1, '消費数は継続');
  await fetchAtDelay(p, e2, 1_800);
  assert.deepEqual(p.events('claude_auth_expiry_probe_disabled').map((e) => e.fields.reason), ['configured_once', 'configured_off', 'configured_once']);
  // 7 日の直前に 2h 段を割り当て、その窓が 7 日境界を跨ぐ
  const MAX_MS = 7 * 24 * HOUR;
  p.setNow(sessionStart + MAX_MS - 7_300 * SEC - 300 * SEC);
  const e3 = await assignBaseline(p, 'fake-week-3');
  assert.equal(p.provider.expiryProbeStatus().pendingStage, '2h');
  p.setNow(sessionStart + MAX_MS - 1);
  p.provider.classify(p.snapshot());
  assert.equal(p.provider.expiryProbeStatus().active, true);
  // 7 日ちょうどから新要求を禁止する（窓内でも送らない）
  const batch = await fetchAtDelay(p, e3, 7_300);
  assert.equal(p.clock.now, sessionStart + MAX_MS);
  assert.equal(batch.auth.requestKind, 'local_gate');
  const status = p.provider.expiryProbeStatus();
  assert.deepEqual([status.active, status.closedReason], [false, 'time_limit']);
  assert.equal(p.events('claude_auth_expiry_probe_start').length, 2);
  assert.ok(p.events('claude_auth_expiry_probe_skipped').some((e) => e.fields.reason === 'session_ended' && e.fields.stage === '2h'));
  assert.equal(p.calls.save, 1);
  // ON に戻しても閉じたセッションは再開しない
  p.cfg.claudeExpiredUsageProbe = 'once';
  const e4 = await assignBaseline(p, 'fake-week-4');
  await fetchAtDelay(p, e4, 200);
  assert.equal(p.events('claude_auth_expiry_probe_start').length, 2);
  // 7 日内に揃わなかった段は 0 件のまま（0% や全拒否として数えない）
  const stages = p.events('claude_auth_expiry_probe_disabled').find((e) => e.fields.reason === 'time_limit').fields.stages;
  assert.deepEqual(Object.values(stages).map((s) => [s.spent, s.http200, s.http401]), [[1, 1, 0], [1, 1, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(summarizeProbeStage(stages['6h']), { decided: 0, acceptanceRate: null, sufficient: false, allRejected: false });
});

test('probe の 429 一件で次の要求を許す前に停止し off を保存する。保存に失敗しても停止は維持', async (t) => {
  for (const saveResult of [true, false]) {
    const p = makeProbeEnv(t, { saveResult });
    const e1 = await assignBaseline(p, 'fake-429-1');
    p.env.usage = () => ({ ok: false, status: 429, text: async () => '' });
    const batch = await fetchAtDelay(p, e1, 200);
    assert.deepEqual(batch.samples.map((s) => s.errorCode), ['http_429', 'http_429', 'http_429']);
    const status = p.provider.expiryProbeStatus();
    assert.deepEqual([status.active, status.closedReason], [false, 'probe_429']);
    assert.equal(p.calls.save, 1);
    const disabled = p.events('claude_auth_expiry_probe_disabled').at(-1);
    assert.deepEqual([disabled.level, disabled.fields.reason, disabled.fields.mode], ['warn', 'probe_429', 'off']);
    assert.equal(p.events('claude_auth_expiry_probe_config_save_failed').length, saveResult ? 0 : 1);
    assert.equal(p.cfg.claudeExpiredUsageProbe, saveResult ? 'off' : 'once');
    // 次の token は割り当てない（設定が once のままでも）
    p.env.usage = () => usageResponse();
    p.advance(HOUR);
    const e2 = await assignBaseline(p, 'fake-429-2');
    await fetchAtDelay(p, e2, 200);
    assert.equal(p.events('claude_auth_expiry_probe_start').length, 1);
    assert.equal(p.calls.usage, 3);
  }
});

test('経過時計: 睡眠で W/E が整合すれば窓内は適格、窓超過は late_probe。補正・後退・E 取得不能は送信前に除外', async (t) => {
  // 6h の睡眠（W も E も進む）→ resume が窓内なら送信可、clockSuspect なし
  const p = makeProbeEnv(t);
  // 失効でカーソルを 6h まで進める（3m → 30m → 2h を割当後に新 token で失効）
  for (let i = 0; p.provider.expiryProbeStatus().cursor !== 3; i++) {
    await assignBaseline(p, `fake-burn-${i}`);
    p.advance(60 * SEC);
  }
  const expiresAt = await assignBaseline(p, 'fake-sleep-6h');
  assert.equal(p.provider.expiryProbeStatus().pendingStage, '6h');
  p.provider.notePowerEvent('suspend');
  p.setNow(expiresAt + 21_700 * SEC);
  p.provider.notePowerEvent('resume');
  const batch = await p.provider.fetchSamples({ observedAt: p.clock.now, intervalSec: 180 });
  assert.equal(batch.auth.requestKind, 'expiry_probe');
  const start = p.events('claude_auth_expiry_probe_start')[0].fields;
  assert.deepEqual(
    [start.stage, start.clockSuspect, start.suspendCount, start.suspendedForSec, start.clockDeltaSec],
    ['6h', false, 1, 22_000, 0],
  );
  assert.equal(p.provider.expiryProbeStatus().stages['6h'].slept, 1);

  // 睡眠後の resume が窓超過 → late_probe（別段へ振り替えない）
  const q = makeProbeEnv(t);
  const eq = await assignBaseline(q, 'fake-sleep-late');
  q.provider.notePowerEvent('suspend');
  q.setNow(eq + 600 * SEC);
  q.provider.notePowerEvent('resume');
  await q.provider.fetchSamples({ observedAt: q.clock.now, intervalSec: 180 });
  assert.equal(q.calls.usage, 1);
  assert.equal(q.events('claude_auth_expiry_probe_skipped')[0].fields.reason, 'late_probe');

  /** @type {[string, (r:ReturnType<typeof makeProbeEnv>, expiresAt:number) => void, string][]} */
  const cases = [
    ['睡眠中の +60 秒補正', (r, e) => {
      r.provider.notePowerEvent('suspend');
      const d = e + 200 * SEC - r.clock.now;
      r.clock.e = /** @type {number} */ (r.clock.e) + d;
      r.clock.now += d + 60 * SEC;
      r.provider.notePowerEvent('resume');
    }, 'clock_suspect'],
    ['睡眠中の -60 秒補正', (r, e) => {
      r.provider.notePowerEvent('suspend');
      const d = e + 290 * SEC - r.clock.now;
      r.clock.e = /** @type {number} */ (r.clock.e) + d;
      r.clock.now += d - 60 * SEC;
      r.provider.notePowerEvent('resume');
    }, 'clock_suspect'],
    ['小補正の累積', (r) => {
      for (let i = 0; i < 3; i++) {
        r.clock.now += 20 * SEC;
        r.provider.classify(r.snapshot());
      }
    }, 'clock_suspect'],
    ['W の後退', (r) => { r.clock.now -= 1; r.provider.classify(r.snapshot()); }, 'clock_suspect'],
    ['E の後退', (r) => { r.clock.e = /** @type {number} */ (r.clock.e) - 1; r.provider.classify(r.snapshot()); }, 'clock_suspect'],
    ['E 取得不能', (r) => { r.clock.e = null; r.provider.classify(r.snapshot()); }, 'clock_unverified'],
  ];
  for (const [name, mutate, reason] of cases) {
    const r = makeProbeEnv(t);
    const e = await assignBaseline(r, 'fake-clock');
    r.advance(10 * SEC);
    mutate(r, e);
    if (r.clock.e === null) r.clock.e = 9_000_000;
    r.clock.now = Math.max(r.clock.now, e + 230 * SEC);
    await r.provider.fetchSamples({ observedAt: r.clock.now, intervalSec: 180 });
    assert.equal(r.calls.usage, 1, name);
    assert.equal(r.events('claude_auth_expiry_probe_skipped')[0]?.fields.reason, reason, name);
  }

  // 対照時に E が取得できない環境は段を割り当てず送信ゼロ（stage:null、カーソルは進めない）
  const u = makeProbeEnv(t);
  u.clock.e = null;
  const eu = await assignBaseline(u, 'fake-unverified');
  await fetchAtDelay(u, eu, 200);
  assert.equal(u.calls.usage, 1);
  const skipped = u.events('claude_auth_expiry_probe_skipped')[0].fields;
  assert.deepEqual([skipped.reason, skipped.stage], ['clock_unverified', null]);
  assert.equal(u.provider.expiryProbeStatus().cursor, 0);
});

test('複数の suspend/resume は回数と累積睡眠を記録し、対が欠けたら睡眠時間は null（0 と偽装しない）', async (t) => {
  const p = makeProbeEnv(t);
  const e1 = await assignBaseline(p, 'fake-multi-sleep');
  p.provider.notePowerEvent('suspend');
  p.advance(30 * SEC);
  p.provider.notePowerEvent('resume');
  p.provider.notePowerEvent('suspend');
  p.advance(40 * SEC);
  p.provider.notePowerEvent('resume');
  await fetchAtDelay(p, e1, 200);
  const start = p.events('claude_auth_expiry_probe_start')[0].fields;
  assert.deepEqual([start.suspendCount, start.suspendedForSec], [2, 70]);

  const q = makeProbeEnv(t);
  const e2 = await assignBaseline(q, 'fake-missing-pair');
  q.advance(30 * SEC);
  q.provider.notePowerEvent('resume'); // suspend を観測していない
  await fetchAtDelay(q, e2, 200);
  const start2 = q.events('claude_auth_expiry_probe_start')[0].fields;
  assert.deepEqual([start2.suspendCount, start2.suspendedForSec], [1, null]);
});

test('期限切れ起動の identity probe は once でも unknown・usage 0・profile 0・予算消費なし', async (t) => {
  const p = makeProbeEnv(t);
  p.write('fake-startup-identity', { expiresAt: p.clock.now - HOUR });
  assert.equal(await p.provider.resolveInitialIdentity(), null);
  assert.deepEqual([p.calls.usage, p.calls.profile], [0, 0]);
  assert.equal(p.provider.expiryProbeStatus().totalSpent, 0);
});

test('睡眠を含む経過時計アダプター: Windows は os.uptime（GetTickCount64 相当）を ms で返し、他 OS・取得失敗は null', () => {
  assert.equal(createSleepInclusiveClock({ platform: 'win32', uptimeSec: () => 1446635.531 })(), 1446635531);
  assert.equal(createSleepInclusiveClock({ platform: 'linux', uptimeSec: () => 100 })(), null);
  assert.equal(createSleepInclusiveClock({ platform: 'darwin', uptimeSec: () => 100 })(), null);
  assert.equal(createSleepInclusiveClock({ platform: 'win32', uptimeSec: () => { throw new Error('x'); } })(), null);
  assert.equal(createSleepInclusiveClock({ platform: 'win32', uptimeSec: () => NaN })(), null);
  assert.equal(createSleepInclusiveClock({ platform: 'win32', uptimeSec: () => -1 })(), null);
  // 実プロセスの既定アダプターも数値か null を返す（実 sleep/hibernate での契約確認は別途）
  const real = createSleepInclusiveClock()();
  assert.ok(real === null || (Number.isFinite(real) && real > 0));
});
