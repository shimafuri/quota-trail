import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForLog } from '../src/main/logger.mjs';

test('logger は実 ID と秘密値を落とし匿名 account key は残す', () => {
  const value = sanitizeForLog({ token:'secret', accountId:42, profile:{ email:'a@example.com' }, text:'Bearer abc 11111111-1111-4111-8111-111111111111 a@example.com', accountKey:'claude:1' });
  assert.deepEqual(value, { text:'[REDACTED] [REDACTED] [REDACTED]', accountKey:'claude:1' });
});

test('logger は batch endpoint の応答と nonce を sanitize する', () => {
  const value = sanitizeForLog({
    identifierAccessToken: 'C1Dq9v0T7kZ2mQ8sX4nL6pR3yU5wA7bE9cF1gH2jK4M',
    nonce: 'C1Dq9v0T7kZ2mQ8sX4nL6pR3yU5wA7bE9cF1gH2jK4M',
    providers: {
      claude: {
        'claude:1': { kind: 'email', value: 'user@example.test' },
        'claude:2': { kind: 'uuid', value: '01234567-89ab-cdef-0123-456789abcdef' },
      },
    },
  });
  assert.deepEqual(value, {
    providers: {
      claude: {
        'claude:1': { kind: 'email', value: '[REDACTED]' },
        'claude:2': { kind: 'uuid', value: '[REDACTED]' },
      },
    },
  });
});

test('logger は request header と error body を落とし、匿名 key と status は残す', () => {
  const value = sanitizeForLog({
    status: 404,
    path: '/api/account-identifiers',
    headers: { 'x-quota-trail-identifier-token': 'C1Dq9v0T7kZ2mQ8sX4nL6pR3yU5wA7bE9cF1gH2jK4M' },
    body: '{"error":"not found"}',
    accountKey: 'codex:2',
  });
  assert.deepEqual(value, {
    status: 404,
    path: '/api/account-identifiers',
    body: '{"error":"not found"}',
    accountKey: 'codex:2',
  });
});

test('logger は fingerprint・内部キー・refresh token・CLI の raw 出力を防御的に落とし、認証イベントの安全な fields は残す（設計書 §15.6）', () => {
  const fingerprint = 'a'.repeat(64);
  const value = sanitizeForLog({
    provider: 'claude',
    accountKey: 'claude:1',
    checkedAt: 1_790_000_000_000,
    expiresAt: 1_790_000_600_000,
    errorCode: 'auth_expired_local',
    source: 'local',
    blockedForSec: 3600,
    fingerprint,
    tokenFingerprint: fingerprint,
    credentialKey: fingerprint,
    refreshToken: 'sk-ant-ort01-fake-refresh',
    refresh_token: 'sk-ant-ort01-fake-refresh',
    stdout: '{"loggedIn":true}',
    stderr: 'warning',
    rawOutput: 'raw',
    cliOutput: 'raw',
    note: `token sk-ant-oat01-fake-access-token key ${fingerprint}`,
  });
  assert.deepEqual(value, {
    provider: 'claude',
    accountKey: 'claude:1',
    checkedAt: 1_790_000_000_000,
    expiresAt: 1_790_000_600_000,
    errorCode: 'auth_expired_local',
    source: 'local',
    blockedForSec: 3600,
    note: 'token [REDACTED] key [REDACTED]',
  });
  const serialized = JSON.stringify(value);
  for (const secret of ['sk-ant-', fingerprint, 'loggedIn', 'fake-refresh']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('logger は期限超過後の確認送信イベントの安全な fields をすべて残し、秘密を混ぜない（設計書 §15.12）', () => {
  const start = {
    provider: 'claude', mode: 'once', probeNo: 1, observedAt: 1_790_000_200_000, requestStartedAt: 1_790_000_200_000,
    expiresAt: 1_790_000_000_000, stage: '3m', targetDelaySec: 180, windowEndDelaySec: 480, scheduleLateSec: 20,
    expiredForSec: 200, lastUsageOkAt: 1_789_999_800_000, lastUsageOkAgeSec: 400, preexpiryLeadSec: 200, intervalSec: 180,
    expiryStable: true, clockSuspect: false, clockDeltaSec: 0.012, clockSource: 'sleep_inclusive', suspendCount: 1, suspendedForSec: null,
  };
  const result = { ...start, outcome: 'http_200', httpStatus: 200, errorCode: null, durationMs: 321, parseOk: true, okWindowCount: 2, nextAction: 'local_gate' };
  const disabled = {
    provider: 'claude', checkedAt: 1_790_000_300_000, mode: 'off', reason: 'probe_429', sessionStartedAt: 1_789_000_000_000, elapsedSec: 1000.5,
    stages: { '3m': { assigned: 2, spent: 1, http200: 0, http401: 0, undetermined: 1, useful: 0, skipped: { token_replaced: 1 }, minExpiredForSec: 200, maxExpiredForSec: 200, slept: 1 } },
  };
  const skipped = { provider: 'claude', mode: 'once', checkedAt: 1, expiresAt: null, expiredForSec: null, stage: null, targetDelaySec: null, reason: 'clock_unverified' };
  for (const fields of [start, result, disabled, skipped]) {
    assert.deepEqual(sanitizeForLog(fields), fields);
  }
  // 呼び出し側が誤って渡しても秘密は落とす（防御）
  const leaked = sanitizeForLog({ ...result, token: 'sk-ant-oat01-x', headers: { Authorization: 'Bearer x' }, credentialKey: 'a'.repeat(64), note: 'sk-ant-oat01-abc' });
  const json = JSON.stringify(leaked);
  for (const secret of ['sk-ant-', 'Bearer', 'a'.repeat(64)]) assert.equal(json.includes(secret), false, secret);
});
