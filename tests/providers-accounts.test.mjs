import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchClaudeSamples } from '../src/main/providers/claude.mjs';
import { resolveAppServerIdentity } from '../src/main/providers/codex-app-server.mjs';

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
