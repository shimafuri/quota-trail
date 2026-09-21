import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForLog } from '../src/main/logger.mjs';

test('logger は実 ID と秘密値を落とし匿名 account key は残す', () => {
  const value = sanitizeForLog({ token:'secret', accountId:42, profile:{ email:'a@example.com' }, text:'Bearer abc 11111111-1111-4111-8111-111111111111 a@example.com', accountKey:'claude:1' });
  assert.deepEqual(value, { text:'[REDACTED] [REDACTED] [REDACTED]', accountKey:'claude:1' });
});
