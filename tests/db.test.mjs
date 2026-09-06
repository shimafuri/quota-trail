import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.mjs';

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

test('queryAllSeries は 4 系列すべてのキーを返す', { skip }, () => {
  withDb((db) => {
    db.insertSamples([sample(0)]);
    const all = db.queryAllSeries({ from: t0 - 1, to: t0 + 1 });
    assert.deepEqual(Object.keys(all), ['claude/5h', 'claude/weekly', 'codex/5h', 'codex/weekly']);
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
    assert.equal(latest['codex/5h'], null);
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
