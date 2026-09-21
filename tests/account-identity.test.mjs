import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUuid, normalizeEmail, decodeJwtPayload, codexIdentityFromAuth, claudeLocalFallback } from '../src/main/lib/account-identity.mjs';

const uuid = 'A0B1C2D3-E4F5-4123-8ABC-0123456789AB';
test('identity normalization and Codex choice are pure and do not return tokens', () => {
  assert.equal(normalizeUuid(` ${uuid} `), uuid.toLowerCase());
  assert.equal(normalizeEmail(' A@Example.COM '), 'a@example.com');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: uuid },
    email: 'A@Example.COM',
  })).toString('base64url');
  const r = codexIdentityFromAuth({ tokens: { account_id: uuid, id_token: `x.${payload}.y`, access_token: 'secret' } });
  assert.equal(r.accountId, uuid.toLowerCase());
  assert.equal(r.identity.uuid, uuid.toLowerCase());
  assert.equal(r.identity.email, 'a@example.com');
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(decodeJwtPayload('bad'), null);
});

test('Codex は tokens.account_id がなくてもネストした JWT claim を使う', () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: uuid },
  })).toString('base64url');
  const result = codexIdentityFromAuth({ tokens: { id_token: `x.${payload}.y` } });

  assert.equal(result.accountId, uuid.toLowerCase());
  assert.equal(result.identity.uuid, uuid.toLowerCase());
});

test('Codex claim namespace がオブジェクト以外でも例外にしない', () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': 'not-an-object',
  })).toString('base64url');

  assert.doesNotThrow(() => {
    const result = codexIdentityFromAuth({ tokens: { id_token: `x.${payload}.y` } });
    assert.equal(result.accountId, null);
  });
});
test('Claude fallback rejects conflicting organizations', () => {
  assert.equal(claudeLocalFallback({ credentialOrganizationUuid: uuid, local: { oauthAccount: { organizationUuid: '11111111-1111-4111-8111-111111111111', accountUuid: uuid } } }), null);
});
