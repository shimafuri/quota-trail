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
