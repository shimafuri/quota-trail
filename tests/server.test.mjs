import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decimate, resolveStatic, startServer } from '../src/main/server.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_EMAIL = 'private@example.com';
const FIXTURE_UUID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_CODEX_UUID = '22222222-2222-4222-8222-222222222222';
const IDENTIFIER_HEADER = 'X-Quota-Trail-Identifier-Token';

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
function fakeDb(over = {}) {
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
    latest: () => ({ 'claude/5h': s, 'claude/weekly': null, 'claude/weekly-fable': null, 'codex/5h': null, 'codex/weekly': null }),
    queryAllSeries: () => ({ 'claude/5h': [s], 'claude/weekly': [], 'claude/weekly-fable': [], 'codex/5h': [], 'codex/weekly': [] }),
    accountDimensionAvailable: true,
    listAccounts: () => [{ provider:'claude', accountKey:'claude:1', label:'アカウント1' }],
    hasUnknownSamples: (provider) => provider === 'codex',
    resolveAccountKey: (p, k) => k === `${p}:unknown` ? null : (k === `${p}:1` ? 42 : 'invalid'),
    listAccountIdentifiers: () => ([
      { provider:'claude', accountKey:'claude:1', kind:'email', value: FIXTURE_EMAIL },
      { provider:'claude', accountKey:'claude:2', kind:'uuid', value: FIXTURE_UUID },
      { provider:'codex', accountKey:'codex:1', kind:'uuid', value: FIXTURE_CODEX_UUID },
    ]),
    ...over,
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

// 閉じた直後の port を別サーバが再利用すると keep-alive 接続が使い回されて fetch が失敗するため、
// テスト内では希望 port をずらして毎回別の port へ bind する。
let nextPreferredPort = 47850;

/**
 * テスト用のサーバを起動し、base URL を返す。
 * @param {import('node:test').TestContext} t
 * @param {Object} [options]
 * @param {any} [options.db]
 * @param {boolean} [options.reveal]
 * @returns {Promise<string>}
 */
async function withServer(t, { db = fakeDb(), reveal = true } = {}) {
  const preferred = nextPreferredPort;
  nextPreferredPort += 1;
  const server = await startServer({
    db,
    readConfig: () => ({ pollIntervalSec: 180, port: preferred, revealAccountIdentifiersInAccountMenu: reveal }),
    appRoot,
    getAutostart: () => true,
    accountManager: fakeAccountManager(),
  });
  t.after(() => server.close());
  return server.url.replace(/\/$/, '');
}

test('HTTP API: /api/meta, /api/latest, /api/samples', async (t) => {
  const base = await withServer(t);

  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.deepEqual(meta.providers, ['claude', 'codex']);
  assert.deepEqual(meta.windows, ['5h', 'weekly', 'weekly-fable']);
  assert.equal(meta.pollIntervalSec, 180);
  assert.equal(typeof meta.now, 'number');
  assert.equal(meta.dbPath, 'C:/tmp/fake.sqlite');
  assert.equal(meta.autostart, true);
  assert.equal(meta.accountDimensionAvailable, true);
  assert.equal(meta.canRevealAccountIdentifiersInAccountMenu, true);
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'canRevealAccountIdentifiers'), false);

  const accounts = await (await fetch(`${base}/api/accounts`)).json();
  assert.equal(accounts.providers.claude.resolution, 'known');
  assert.equal(accounts.providers.claude.currentAccountKey, 'claude:1');
  assert.deepEqual(accounts.providers.claude.accounts, [{
    accountKey: 'claude:1', label: 'アカウント1', isCurrent: true, kind: 'known',
  }]);
  assert.equal(accounts.providers.codex.accounts[0].accountKey, 'codex:unknown');
  const serializedAccounts = JSON.stringify(accounts.providers);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serializedAccounts), false);
  assert.equal(/[^\s"]+@[^\s"]+/.test(serializedAccounts), false);
  assert.equal(/"(?:id|accountId)"\s*:/.test(serializedAccounts), false);

  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.series['claude/5h'].usedPercent, 41.5);
  assert.equal(latest.series['codex/weekly'], null);
  assert.equal(latest.series['claude/weekly-fable'], null);

  const samples = await (await fetch(`${base}/api/samples?from=0&to=${Date.now()}`)).json();
  assert.deepEqual(Object.keys(samples.series), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
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

test('/api/accounts は設定有効時だけ identifierAccessToken を返す', async (t) => {
  const enabled = await withServer(t);
  const withToken = await (await fetch(`${enabled}/api/accounts`)).json();
  assert.equal(typeof withToken.identifierAccessToken, 'string');
  assert.ok(withToken.identifierAccessToken.length >= 32);

  const disabled = await withServer(t, { reveal: false });
  const withoutToken = await (await fetch(`${disabled}/api/accounts`)).json();
  assert.equal(Object.prototype.hasOwnProperty.call(withoutToken, 'identifierAccessToken'), false);
});

test('/api/account-identifiers は nonce と設定が揃った GET だけ 200 になる', async (t) => {
  const base = await withServer(t);
  const { identifierAccessToken } = await (await fetch(`${base}/api/accounts`)).json();

  const ok = await fetch(`${base}/api/account-identifiers`, { headers: { [IDENTIFIER_HEADER]: identifierAccessToken } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  const body = await ok.json();
  assert.deepEqual(body.providers, {
    claude: {
      'claude:1': { kind: 'email', value: FIXTURE_EMAIL },
      'claude:2': { kind: 'uuid', value: FIXTURE_UUID },
    },
    codex: {
      'codex:1': { kind: 'uuid', value: FIXTURE_CODEX_UUID },
    },
  });
  assert.equal(typeof body.now, 'number');
  // 内部整数 ID、identity_source、unknown、余分な profile field を含めない。
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('identity_source'), false);
  assert.equal(serialized.includes('identitySource'), false);
  assert.equal(serialized.includes('unknown'), false);
  assert.equal(/"(?:id|accountId|alias_no|aliasNo|assurance)"\s*:/.test(serialized), false);
  assert.deepEqual(Object.keys(body).sort(), ['now', 'providers']);
  for (const rows of Object.values(body.providers)) {
    for (const entry of Object.values(rows)) {
      assert.deepEqual(Object.keys(entry).sort(), ['kind', 'value']);
    }
  }

  const missing = await fetch(`${base}/api/account-identifiers`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });

  const mismatched = await fetch(`${base}/api/account-identifiers`, { headers: { [IDENTIFIER_HEADER]: 'wrong-token' } });
  assert.equal(mismatched.status, 404);
  assert.deepEqual(await mismatched.json(), { error: 'not found' });

  const sameLength = await fetch(`${base}/api/account-identifiers`, { headers: { [IDENTIFIER_HEADER]: 'x'.repeat(identifierAccessToken.length) } });
  assert.equal(sameLength.status, 404);

  const head = await fetch(`${base}/api/account-identifiers`, { method: 'HEAD', headers: { [IDENTIFIER_HEADER]: identifierAccessToken } });
  assert.equal(head.status, 404);
});

test('/api/account-identifiers は設定無効と縮退で同じ 404 になる', async (t) => {
  const enabled = await withServer(t);
  const { identifierAccessToken } = await (await fetch(`${enabled}/api/accounts`)).json();

  const disabled = await withServer(t, { reveal: false });
  const offByConfig = await fetch(`${disabled}/api/account-identifiers`, { headers: { [IDENTIFIER_HEADER]: identifierAccessToken } });
  assert.equal(offByConfig.status, 404);
  assert.deepEqual(await offByConfig.json(), { error: 'not found' });

  const degraded = await withServer(t, {
    db: fakeDb({ accountDimensionAvailable: false, listAccountIdentifiers: () => [] }),
  });
  const offByDimension = await fetch(`${degraded}/api/account-identifiers`, { headers: { [IDENTIFIER_HEADER]: identifierAccessToken } });
  assert.equal(offByDimension.status, 404);
  assert.deepEqual(await offByDimension.json(), { error: 'not found' });
});

test('エラー応答は request header・query・fixture の実 ID を反射しない', async (t) => {
  const base = await withServer(t);
  const { identifierAccessToken } = await (await fetch(`${base}/api/accounts`)).json();
  const probe = `${base}/api/account-identifiers?account=${encodeURIComponent(FIXTURE_EMAIL)}&uuid=${FIXTURE_UUID}`;
  const response = await fetch(probe, { headers: { [IDENTIFIER_HEADER]: 'reflect-me-please' } });
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.equal(text, '{"error":"not found"}');
  assert.equal(text.includes(FIXTURE_EMAIL), false);
  assert.equal(text.includes(FIXTURE_UUID), false);
  assert.equal(text.includes('reflect-me-please'), false);
  assert.equal(text.includes(identifierAccessToken), false);
});

test('旧単件 endpoint /api/account-identifier は 404 になる', async (t) => {
  const base = await withServer(t);
  const { identifierAccessToken } = await (await fetch(`${base}/api/accounts`)).json();
  for (const url of [
    `${base}/api/account-identifier?provider=claude&account=claude:1`,
    `${base}/api/account-identifier`,
  ]) {
    const response = await fetch(url, { headers: { [IDENTIFIER_HEADER]: identifierAccessToken } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
});

test('実 ID endpoint を追加しても series shape は変わらない', async (t) => {
  const base = await withServer(t);
  const samples = await (await fetch(`${base}/api/samples?from=0&to=${Date.now()}&claude=claude:1`)).json();
  assert.deepEqual(Object.keys(samples.series), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
  const latest = await (await fetch(`${base}/api/latest?claude=claude:1`)).json();
  assert.deepEqual(Object.keys(latest.series), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
  const serialized = `${JSON.stringify(samples)}${JSON.stringify(latest)}`;
  assert.equal(serialized.includes(FIXTURE_EMAIL), false);
  assert.equal(serialized.includes(FIXTURE_UUID), false);
});

// ---------------------------------------------------------------- §15.6 認証区間 overlay

/**
 * Claude 認証 error が続く系列（偽データ）を返す DB。
 * @param {number} count Claude 5h の行数
 * @param {(i:number) => string|null} codeAt 各行の error code（null なら ok）
 */
function authDb(count, codeAt) {
  const base = 1_757_200_000_000;
  const row = (i, window) => {
    const code = codeAt(i);
    return {
      observedAt: base + i * 180_000,
      provider: 'claude',
      window,
      usedPercent: code ? null : 10,
      resetsAt: null,
      status: code ? 'error' : 'ok',
      errorCode: code,
      intervalSec: 180,
    };
  };
  const calls = [];
  return {
    base,
    calls,
    db: fakeDb({
      queryAllSeries: (args) => {
        calls.push(args);
        return {
          'claude/5h': Array.from({ length: count }, (_, i) => row(i, '5h')),
          'claude/weekly': [],
          'claude/weekly-fable': [],
          'codex/5h': [],
          'codex/weekly': [],
        };
      },
    }),
  };
}

test('/api/samples は account filter 後の生データから authGaps を返し、series と既存フィールドは互換', async (t) => {
  // 0..9 は ok、10..19 はローカル期限切れ、20..29 は 401（旧 auth_expired）、30 は 429
  const { base, calls, db } = authDb(31, (i) => (i >= 10 && i < 20 ? 'auth_expired_local' : (i >= 20 && i < 30 ? 'auth_expired' : (i === 30 ? 'http_429' : null))));
  const baseUrl = await withServer(t, { db });
  const body = await (await fetch(`${baseUrl}/api/samples?from=${base}&to=${base + 31 * 180_000}&claude=claude:1`)).json();
  assert.deepEqual(Object.keys(body.series), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
  assert.deepEqual(Object.keys(body.authGaps), ['claude/5h', 'claude/weekly', 'claude/weekly-fable']);
  assert.deepEqual(body.authGaps['claude/5h'], [
    { from: base + 10 * 180_000, to: base + 20 * 180_000, reason: 'auth_expired_local' },
    { from: base + 20 * 180_000, to: base + 30 * 180_000, reason: 'auth_expired' },
  ]);
  assert.deepEqual(body.authGaps['claude/weekly'], []);
  assert.equal(body.decimated, undefined);
  // account filter はクエリの段階で適用されている
  assert.equal(calls[0].accountIdsByProvider.claude, 42);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(FIXTURE_EMAIL), false);
  assert.equal(serialized.includes(FIXTURE_UUID), false);
});

test('/api/samples の authGaps は間引きで消えない', async (t) => {
  // 上限 50,000 行を超える系列の中に 1 行だけ認証 error を置く。等間隔の間引きでは落ちる位置
  const count = 50_010;
  const indexes = Array.from({ length: count }, (_, i) => i);
  const kept = new Set(decimate(indexes));
  const target = indexes.find((i) => !kept.has(i) && i > 0);
  const { base, db } = authDb(count, (i) => (i === target ? 'auth_expired_local' : null));
  const baseUrl = await withServer(t, { db });
  const body = await (await fetch(`${baseUrl}/api/samples?from=${base}&to=${base + count * 180_000}`)).json();
  assert.equal(body.decimated, true);
  assert.equal(body.series['claude/5h'].length, 50_000);
  assert.equal(body.series['claude/5h'].some((s) => s.errorCode === 'auth_expired_local'), false);
  assert.deepEqual(body.authGaps['claude/5h'], [
    { from: base + target * 180_000, to: base + (target + 1) * 180_000, reason: 'auth_expired_local' },
  ]);
});

test('/api/samples: 確認送信の ok 点は通常の点と同じ shape で返り、authGaps は ok 点で分割される（§15.12）', async (t) => {
  // 0..4 ローカル期限切れ、5 は確認送信の 200、6..9 ローカル期限切れ
  const { base, db } = authDb(10, (i) => (i === 5 ? null : 'auth_expired_local'));
  const baseUrl = await withServer(t, { db });
  const body = await (await fetch(`${baseUrl}/api/samples?from=${base}&to=${base + 10 * 180_000}&claude=claude:1`)).json();
  assert.deepEqual(body.authGaps['claude/5h'], [
    { from: base, to: base + 5 * 180_000, reason: 'auth_expired_local' },
    { from: base + 6 * 180_000, to: base + 10 * 180_000, reason: 'auth_expired_local' },
  ]);
  const okPoint = body.series['claude/5h'][5];
  assert.deepEqual(Object.keys(okPoint).sort(), Object.keys(body.series['claude/5h'][4]).sort());
  assert.deepEqual([okPoint.status, okPoint.errorCode, okPoint.usedPercent], ['ok', null, 10]);
  // 期限超過フラグ等の追加フィールドはない
  assert.equal(JSON.stringify(body).includes('probe'), false);
});
