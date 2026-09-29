import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openDb } from '../src/main/db.mjs';
import { normalizeClaude } from '../src/main/lib/normalize.mjs';

/** SQLite バックエンドが現在のランタイムで使えるか確かめる */
function probeBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-probe-'));
  try {
    const db = openDb(path.join(dir, 'probe.sqlite'));
    const backend = db.backend;
    db.close();
    return { ok: true, backend };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const probe = probeBackend();
const skip = probe.ok
  ? false
  : `SQLite バックエンドを読み込めないためスキップ: ${probe.reason}（Electron では動作します。npm install の postinstall で Node ABI 版が作られたか確認してください）`;

if (probe.ok) process.stdout.write(`# db backend: ${probe.backend}\n`);

/** テスト用の一時 DB を開く */
function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-db-'));
  const db = openDb(path.join(dir, 'quota-trail.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

const t0 = 1_757_200_000_000;

/**
 * @param {number} i  何番目のサンプルか（3 分刻み）
 * @param {Partial<any>} [over]
 */
function sample(i, over = {}) {
  return {
    observedAt: t0 + i * 180_000,
    provider: 'claude',
    window: '5h',
    usedPercent: i,
    resetsAt: t0 + 3_600_000,
    status: 'ok',
    errorCode: null,
    intervalSec: 180,
    ...over,
  };
}

test('insert → query の往復', { skip }, () => {
  withDb((db) => {
    const n = db.insertSamples([
      sample(0),
      sample(0, { window: 'weekly', usedPercent: 10 }),
      sample(0, { provider: 'codex', usedPercent: 20 }),
      sample(0, { provider: 'codex', window: 'weekly', status: 'error', usedPercent: null, resetsAt: null, errorCode: 'window_absent' }),
    ]);
    assert.equal(n, 4);
    assert.equal(db.count(), 4);

    const rows = db.querySamples({ provider: 'claude', win: '5h', from: t0 - 1, to: t0 + 1 });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      observedAt: t0,
      provider: 'claude',
      window: '5h',
      usedPercent: 0,
      resetsAt: t0 + 3_600_000,
      status: 'ok',
      errorCode: null,
      intervalSec: 180,
    });

    const err = db.querySamples({ provider: 'codex', win: 'weekly', from: t0 - 1, to: t0 + 1 });
    assert.equal(err[0].status, 'error');
    assert.equal(err[0].usedPercent, null);
    assert.equal(err[0].resetsAt, null);
    assert.equal(err[0].errorCode, 'window_absent');
  });
});

test('querySamples は範囲外の直前 1 点・直後 1 点を含む', { skip }, () => {
  withDb((db) => {
    db.insertSamples([0, 1, 2, 3, 4, 5, 6].map((i) => sample(i)));
    // 範囲を i=2..4 に取る
    const from = t0 + 2 * 180_000;
    const to = t0 + 4 * 180_000;
    const rows = db.querySamples({ provider: 'claude', win: '5h', from, to });
    assert.deepEqual(rows.map((r) => r.usedPercent), [1, 2, 3, 4, 5]);
    // 昇順であること
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].observedAt > rows[i - 1].observedAt);
  });
});

test('範囲の外に点が無ければ前後の追加は無い', { skip }, () => {
  withDb((db) => {
    db.insertSamples([0, 1, 2].map((i) => sample(i)));
    const rows = db.querySamples({ provider: 'claude', win: '5h', from: t0, to: t0 + 2 * 180_000 });
    assert.deepEqual(rows.map((r) => r.usedPercent), [0, 1, 2]);
  });
});

test('系列は provider / window で分かれる', { skip }, () => {
  withDb((db) => {
    db.insertSamples([
      sample(0),
      sample(1, { provider: 'codex', usedPercent: 99 }),
    ]);
    const claude = db.querySamples({ provider: 'claude', win: '5h', from: t0 - 1, to: t0 + 10 * 180_000 });
    assert.equal(claude.length, 1);
    assert.equal(claude[0].provider, 'claude');
    const codex = db.querySamples({ provider: 'codex', win: '5h', from: t0 - 1, to: t0 + 10 * 180_000 });
    assert.equal(codex.length, 1);
    assert.equal(codex[0].usedPercent, 99);
  });
});

test('queryAllSeries は 5 系列すべてのキーを返す', { skip }, () => {
  withDb((db) => {
    db.insertSamples([sample(0)]);
    const all = db.queryAllSeries({ from: t0 - 1, to: t0 + 1 });
    assert.deepEqual(Object.keys(all), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
    assert.equal(all['claude/5h'].length, 1);
    assert.equal(all['codex/weekly'].length, 0);
  });
});

test('latest は各系列の最新 1 行（無ければ null）', { skip }, () => {
  withDb((db) => {
    db.insertSamples([sample(0), sample(1), sample(2)]);
    const latest = db.latest();
    assert.equal(latest['claude/5h'].usedPercent, 2);
    assert.equal(latest['claude/weekly'], null);
    assert.equal(latest['claude/weekly-fable'], null);
    assert.equal(latest['codex/5h'], null);
  });
});

test('実観測値は 5 系列として同時保存され、旧 4 系列の値を維持する', { skip }, () => {
  withDb((db) => {
    const claudeRows = normalizeClaude({
      five_hour: { utilization: 40 },
      seven_day: { utilization: 56 },
      limits: [{ kind: 'weekly_scoped', group: 'weekly', scope: { surface: null, model: { id: null, display_name: 'Fable' } }, percent: 80, resets_at: '2026-09-30T00:00:00Z', is_active: false }],
    }, { observedAt: t0, intervalSec: 180 });
    db.insertSamples([
      ...claudeRows,
      sample(0, { provider: 'codex', usedPercent: 52 }),
      sample(0, { provider: 'codex', window: 'weekly', usedPercent: 59 }),
    ]);
    const all = db.queryAllSeries({ from: t0 - 1, to: t0 + 1 });
    assert.deepEqual(Object.keys(all), ['claude/5h', 'claude/weekly', 'claude/weekly-fable', 'codex/5h', 'codex/weekly']);
    assert.deepEqual(Object.values(all).map((rows) => rows[0].usedPercent), [40, 56, 80, 52, 59]);
    assert.deepEqual(Object.values(db.latest()).map((row) => row.usedPercent), [40, 56, 80, 52, 59]);
    assert.equal(db.count(), 5);
  });
});

test('Claude Fable 行は account ごとに分離される', { skip }, () => {
  withDb((db) => {
    const a = { provider: 'claude', uuid: '11111111-1111-4111-8111-111111111111', email: null, source: 'test' };
    const b = { provider: 'claude', uuid: '22222222-2222-4222-8222-222222222222', email: null, source: 'test' };
    db.recordPoll([{ provider: 'claude', identity: a, samples: [sample(0, { window: 'weekly-fable', usedPercent: 80 })] }]);
    db.recordPoll([{ provider: 'claude', identity: b, samples: [sample(1, { window: 'weekly-fable', usedPercent: 20 })] }]);
    const accountA = db.resolveAccountKey('claude', 'claude:1');
    const accountB = db.resolveAccountKey('claude', 'claude:2');
    const ids = { codex: null, claude: accountA };
    assert.equal(db.latest({ accountIdsByProvider: ids })['claude/weekly-fable'].usedPercent, 80);
    ids.claude = accountB;
    assert.equal(db.latest({ accountIdsByProvider: ids })['claude/weekly-fable'].usedPercent, 20);
    assert.deepEqual(db.queryAllSeries({ from: t0 - 1, to: t0 + 180_001, accountIdsByProvider: ids })['claude/weekly-fable'].map((row) => row.usedPercent), [20]);
  });
});

test('pruneOlderThan は古い行を消す', { skip }, () => {
  withDb((db) => {
    db.insertSamples([0, 1, 2, 3].map((i) => sample(i)));
    const removed = db.pruneOlderThan(t0 + 2 * 180_000);
    assert.equal(removed, 2);
    assert.equal(db.count(), 2);
  });
});

test('DB を開き直しても行が残る', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-db2-'));
  const file = path.join(dir, 'quota-trail.sqlite');
  try {
    const a = openDb(file);
    a.insertSamples([sample(0)]);
    a.close();
    const b = openDb(file);
    assert.equal(b.count(), 1);
    b.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('v1 fixture は行を失わず冪等に v2 化される', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-v1-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1); CREATE TABLE samples (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, provider TEXT NOT NULL, win TEXT NOT NULL, used_percent REAL, resets_at INTEGER, status TEXT NOT NULL, error_code TEXT, interval_sec INTEGER NOT NULL);');
    raw.prepare('INSERT INTO samples (observed_at,provider,win,used_percent,resets_at,status,error_code,interval_sec) VALUES (?,?,?,?,?,?,?,?)').run(t0,'claude','5h',1,null,'ok',null,180);
    raw.prepare('INSERT INTO samples (observed_at,provider,win,used_percent,resets_at,status,error_code,interval_sec) VALUES (?,?,?,?,?,?,?,?)').run(t0+1,'codex','weekly',2,null,'ok',null,180);
    raw.close();
    let d = openDb(file);
    assert.equal(d.count(), 2);
    assert.equal(d.accountDimensionAvailable, true);
    d.close();
    d = openDb(file);
    assert.equal(d.count(), 2);
    assert.equal(d.accountDimensionAvailable, true);
    d.close();
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('known/unknown と範囲外境界点は account ごとに分離される', { skip }, () => {
  withDb((db) => {
    const a = { provider:'claude', uuid:'11111111-1111-4111-8111-111111111111', email:null, source:'test', assurance:'authoritative' };
    const b = { provider:'claude', uuid:'22222222-2222-4222-8222-222222222222', email:null, source:'test', assurance:'authoritative' };
    db.recordPoll([{ provider:'claude', identity:a, samples:[sample(0),sample(2)] }]);
    db.recordPoll([{ provider:'claude', identity:b, samples:[sample(1),sample(3)] }]);
    db.recordPoll([{ provider:'claude', identity:null, samples:[sample(1, { usedPercent:77 })] }]);
    const aid = db.resolveAccountKey('claude', 'claude:1');
    const rows = db.querySamples({ provider:'claude', win:'5h', accountId:aid, from:t0 + 180_000, to:t0 + 180_000 });
    assert.deepEqual(rows.map(x => x.usedPercent), [0, 2]);
    assert.equal(db.latest({accountIdsByProvider:{claude:null,codex:null}})['claude/5h'].usedPercent, 77);
  });
});

test('UUID と email の衝突では UUID 用の新規行へ保存し、既存行へ誤帰属しない', { skip }, () => {
  withDb((db) => {
    const uuid1 = '11111111-1111-4111-8111-111111111111';
    const uuid2 = '22222222-2222-4222-8222-222222222222';
    const email = 'shared@example.test';
    db.recordPoll([{ provider: 'claude', identity: { provider: 'claude', uuid: uuid1, email, source: 'test' }, samples: [sample(0)] }]);
    db.recordPoll([{ provider: 'claude', identity: { provider: 'claude', uuid: uuid2, email, source: 'test' }, samples: [sample(1)] }]);
    const first = db.resolveAccountKey('claude', 'claude:1');
    const second = db.resolveAccountKey('claude', 'claude:2');
    assert.notEqual(first, second);
    assert.deepEqual(db.querySamples({ provider: 'claude', win: '5h', accountId: first, from: t0 - 1, to: t0 + 2 * 180_000 }).map((row) => row.usedPercent), [0]);
    assert.deepEqual(db.querySamples({ provider: 'claude', win: '5h', accountId: second, from: t0 - 1, to: t0 + 2 * 180_000 }).map((row) => row.usedPercent), [1]);
  });
});

test('targeted の commit 後に更新が失敗しても、再開時は固定済み target を使う', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-targeted-'));
  const file = path.join(dir, 'targeted.sqlite');
  const uuidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const uuidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1); CREATE TABLE samples (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, provider TEXT NOT NULL, win TEXT NOT NULL, used_percent REAL, resets_at INTEGER, status TEXT NOT NULL, error_code TEXT, interval_sec INTEGER NOT NULL);');
    raw.prepare('INSERT INTO samples (observed_at,provider,win,used_percent,resets_at,status,error_code,interval_sec) VALUES (?,?,?,?,?,?,?,?)').run(t0, 'claude', '5h', 1, null, 'ok', null, 180);
    raw.close();
    const db = openDb(file);
    const raw2 = new DatabaseSync(file);
    raw2.exec("CREATE TRIGGER stop_backfill BEFORE UPDATE OF account_id ON samples BEGIN SELECT RAISE(ABORT, 'stop'); END;");
    raw2.close();
    assert.throws(() => db.finishV2Backfill('claude', { provider: 'claude', uuid: uuidA, email: null, source: 'test' }));
    db.close();
    const raw3 = new DatabaseSync(file);
    const targeted = raw3.prepare("SELECT state, target_account_id FROM account_backfill_v2 WHERE provider = 'claude'").get();
    assert.equal(targeted.state, 'targeted');
    raw3.exec('DROP TRIGGER stop_backfill;');
    raw3.close();
    const resumed = openDb(file);
    resumed.finishV2Backfill('claude', { provider: 'claude', uuid: uuidB, email: null, source: 'test' });
    const accountA = resumed.resolveAccountKey('claude', 'claude:1');
    const accountB = resumed.resolveAccountKey('claude', 'claude:2');
    assert.equal(accountB, 'invalid');
    assert.equal(resumed.querySamples({ provider: 'claude', win: '5h', accountId: accountA, from: t0 - 1, to: t0 + 1 }).length, 1);
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('version 2 でも accounts table が無ければ migration を再実行する', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-incomplete-v2-'));
  const file = path.join(dir, 'incomplete.sqlite');
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (2); CREATE TABLE samples (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, provider TEXT NOT NULL, win TEXT NOT NULL, used_percent REAL, resets_at INTEGER, status TEXT NOT NULL, error_code TEXT, interval_sec INTEGER NOT NULL, account_id INTEGER);');
    raw.close();
    const db = openDb(file);
    assert.equal(db.accountDimensionAvailable, true);
    assert.deepEqual(db.listAccounts(), []);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 縮退モードでも範囲外の直前と直後を返す', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-v1-fallback-'));
  const file = path.join(dir, 'fallback.sqlite');
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1); CREATE TABLE samples (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, provider TEXT NOT NULL, win TEXT NOT NULL, used_percent REAL, resets_at INTEGER, status TEXT NOT NULL, error_code TEXT, interval_sec INTEGER NOT NULL); CREATE VIEW accounts AS SELECT 1 AS id;');
    for (const i of [0, 1, 2]) raw.prepare('INSERT INTO samples (observed_at,provider,win,used_percent,resets_at,status,error_code,interval_sec) VALUES (?,?,?,?,?,?,?,?)').run(t0 + i * 180_000, 'claude', '5h', i, null, 'ok', null, 180);
    raw.close();
    const db = openDb(file);
    assert.equal(db.accountDimensionAvailable, false);
    assert.deepEqual(db.querySamples({ provider: 'claude', win: '5h', from: t0 + 180_000, to: t0 + 180_000 }).map((row) => row.usedPercent), [0, 1, 2]);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listAccountIdentifiers は alias 順にメール優先・UUID fallback で返す', { skip }, () => {
  withDb((db) => {
    const claudeEmail = 'first@example.test';
    const claudeUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const codexEmail = 'codex@example.test';
    db.recordPoll([{ provider: 'claude', identity: { provider: 'claude', uuid: null, email: claudeEmail, source: 'test' }, samples: [sample(0)] }]);
    db.recordPoll([{ provider: 'claude', identity: { provider: 'claude', uuid: claudeUuid, email: null, source: 'test' }, samples: [sample(1)] }]);
    db.recordPoll([{ provider: 'codex', identity: { provider: 'codex', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: codexEmail, source: 'test' }, samples: [sample(2, { provider: 'codex' })] }]);

    const identifiers = db.listAccountIdentifiers();
    assert.deepEqual(identifiers, [
      { provider: 'claude', accountKey: 'claude:1', kind: 'email', value: claudeEmail },
      { provider: 'claude', accountKey: 'claude:2', kind: 'uuid', value: claudeUuid },
      { provider: 'codex', accountKey: 'codex:1', kind: 'email', value: codexEmail },
    ]);
    // provider 間で alias number 1 が重なっても混同しない。
    assert.equal(identifiers.filter((row) => row.accountKey.endsWith(':1')).length, 2);
    // メールがある行は UUID を返さない。
    assert.equal(JSON.stringify(identifiers).includes('bbbbbbbb'), false);
    // 旧単件 API は廃止済み。
    assert.equal(db.accountIdentifier, undefined);
  });
});

test('listAccountIdentifiers は UUID もメールも無い行を返さない', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-identifiers-'));
  const file = path.join(dir, 'identifiers.sqlite');
  try {
    const db = openDb(file);
    db.recordPoll([{ provider: 'claude', identity: { provider: 'claude', uuid: null, email: 'only@example.test', source: 'test' }, samples: [sample(0)] }]);
    const raw = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(file);
    raw.prepare('INSERT INTO accounts (provider, account_uuid, email, alias_no, identity_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('claude', null, null, 9, 'broken', t0, t0);
    raw.prepare('INSERT INTO accounts (provider, account_uuid, email, alias_no, identity_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('claude', '', '', 10, 'broken', t0, t0);
    raw.close();
    assert.deepEqual(db.listAccountIdentifiers(), [
      { provider: 'claude', accountKey: 'claude:1', kind: 'email', value: 'only@example.test' },
    ]);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 縮退では listAccountIdentifiers が空配列を返す', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-identifiers-v1-'));
  const file = path.join(dir, 'fallback.sqlite');
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1); CREATE TABLE samples (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, provider TEXT NOT NULL, win TEXT NOT NULL, used_percent REAL, resets_at INTEGER, status TEXT NOT NULL, error_code TEXT, interval_sec INTEGER NOT NULL); CREATE VIEW accounts AS SELECT 1 AS id;');
    raw.close();
    const db = openDb(file);
    assert.equal(db.accountDimensionAvailable, false);
    assert.deepEqual(db.listAccountIdentifiers(), []);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
