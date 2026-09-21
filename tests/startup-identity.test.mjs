import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialIdentityWithinBudget } from '../src/main/lib/startup-identity.mjs';

test('初回 identity 解決が失敗・停止しても短い予算で unknown へ確定し公開処理を続けられる', async () => {
  const startedAt = Date.now();
  const result = await resolveInitialIdentityWithinBudget(new Promise(() => {}), 25);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result, null);
  assert.ok(elapsedMs < 250, `起動予算を超過しました: ${elapsedMs}ms`);
});
