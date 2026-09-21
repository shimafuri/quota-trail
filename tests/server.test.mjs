import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decimate, resolveStatic, startServer } from '../src/main/server.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('decimate は上限以下ならそのまま、超えたら先頭と末尾を残して間引く', () => {
  const arr = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(decimate(arr, 10), arr);
  const d = decimate(arr, 5);
  assert.equal(d.length, 5);
  assert.equal(d[0], 0);
  assert.equal(d[d.length - 1], 9);
});

test('resolveStatic はルート外を拒否する', () => {
  const root = path.join(appRoot, 'src', 'renderer');
  assert.equal(resolveStatic(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveStatic(root, '/sub/app.mjs'), path.join(root, 'sub', 'app.mjs'));
  assert.equal(resolveStatic(root, '/../../package.json'), null);
  assert.equal(resolveStatic(root, '/..%2f..%2fpackage.json'), null);
  assert.equal(resolveStatic(root, '/%00evil'), null);
});

/** テスト用のダミー DB */
function fakeDb() {
  const s = {
    observedAt: 1_757_200_000_000,
    provider: 'claude',
    window: '5h',
    usedPercent: 41.5,
    resetsAt: 1_757_210_000_000,
    status: 'ok',
    errorCode: null,
    intervalSec: 180,
  };
  return {
    dbPath: 'C:/tmp/fake.sqlite',
    backend: 'fake',
    latest: () => ({ 'claude/5h': s, 'claude/weekly': null, 'codex/5h': null, 'codex/weekly': null }),
    queryAllSeries: () => ({ 'claude/5h': [s], 'claude/weekly': [], 'codex/5h': [], 'codex/weekly': [] }),
    accountDimensionAvailable: true,
    listAccounts: () => [{ provider:'claude', accountKey:'claude:1', label:'アカウント1' }],
    hasUnknownSamples: (provider) => provider === 'codex',
    resolveAccountKey: (p, k) => k === `${p}:unknown` ? null : (k === `${p}:1` ? 42 : 'invalid'),
    accountIdentifier: () => ({ uuid:'11111111-1111-4111-8111-111111111111', email:'private@example.com' }),
  };
}

function fakeAccountManager() {
  return {
    accounts: () => [{ provider:'claude', accountKey:'claude:1', label:'アカウント1', isCurrent:true }],
    current: (provider) => provider === 'claude'
      ? { status:'known', accountKey:'claude:1', accountId:42 }
      : { status:'unknown', accountKey:null, accountId:null },
  };
}

test('HTTP API: /api/meta, /api/latest, /api/samples', async (t) => {
  const server = await startServer({
    db: fakeDb(),
    readConfig: () => ({ pollIntervalSec: 180, port: 0 }),
    appRoot,
    getAutostart: () => true,
    accountManager: fakeAccountManager(),
  });
  t.after(() => server.close());
  const base = server.url.replace(/\/$/, '');

  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.deepEqual(meta.providers, ['claude', 'codex']);
  assert.deepEqual(meta.windows, ['5h', 'weekly']);
  assert.equal(meta.pollIntervalSec, 180);
  assert.equal(typeof meta.now, 'number');
  assert.equal(meta.dbPath, 'C:/tmp/fake.sqlite');
  assert.equal(meta.autostart, true);
  assert.equal(meta.accountDimensionAvailable, true);

  const accounts = await (await fetch(`${base}/api/accounts`)).json();
  assert.equal(accounts.providers.claude.resolution, 'known');
  assert.equal(accounts.providers.claude.currentAccountKey, 'claude:1');
  assert.deepEqual(accounts.providers.claude.accounts, [{
    accountKey: 'claude:1', label: 'アカウント1', isCurrent: true, kind: 'known',
  }]);
  assert.equal(accounts.providers.codex.accounts[0].accountKey, 'codex:unknown');
  const serializedAccounts = JSON.stringify(accounts);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serializedAccounts), false);
  assert.equal(/[^\s"]+@[^\s"]+/.test(serializedAccounts), false);
  assert.equal(/"(?:id|accountId)"\s*:/.test(serializedAccounts), false);

  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.series['claude/5h'].usedPercent, 41.5);
  assert.equal(latest.series['codex/weekly'], null);

  const samples = await (await fetch(`${base}/api/samples?from=0&to=${Date.now()}`)).json();
  assert.deepEqual(Object.keys(samples.series), ['claude/5h', 'claude/weekly', 'codex/5h', 'codex/weekly']);
  assert.equal(samples.series['claude/5h'][0].provider, 'claude');
  assert.equal(samples.decimated, undefined);

  const bad = await fetch(`${base}/api/samples`);
  assert.equal(bad.status, 400);

  const notFound = await fetch(`${base}/api/nope`);
  assert.equal(notFound.status, 404);

  const traversal = await fetch(`${base}/../package.json`, { redirect: 'manual' });
  assert.ok(traversal.status === 400 || traversal.status === 404, `got ${traversal.status}`);

  const post = await fetch(`${base}/api/meta`, { method: 'POST' });
  assert.equal(post.status, 405);
});
