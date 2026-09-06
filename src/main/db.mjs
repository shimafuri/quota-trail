// SQLite 永続化（設計書 §5）
// better-sqlite3 を優先し、読み込めなければ Electron 同梱 Node の node:sqlite にフォールバックする。
// どちらを使っているかは openDb().backend で分かる。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  win TEXT NOT NULL,
  used_percent REAL,
  resets_at INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  interval_sec INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_series_time ON samples (provider, win, observed_at);
`;

const SERIES = [
  ['claude', '5h'],
  ['claude', 'weekly'],
  ['codex', '5h'],
  ['codex', 'weekly'],
];

/** @typedef {import('./lib/normalize.mjs').Sample} Sample */

/** DB 行 → Sample（camelCase） */
function rowToSample(r) {
  return {
    observedAt: Number(r.observed_at),
    provider: /** @type {any} */ (r.provider),
    window: /** @type {any} */ (r.win),
    usedPercent: r.used_percent === null || r.used_percent === undefined ? null : Number(r.used_percent),
    resetsAt: r.resets_at === null || r.resets_at === undefined ? null : Number(r.resets_at),
    status: /** @type {any} */ (r.status),
    errorCode: r.error_code === null || r.error_code === undefined ? null : String(r.error_code),
    intervalSec: Number(r.interval_sec),
  };
}

/**
 * better-sqlite3 を読み込む。ABI が合わなければ null。
 * @param {string} file
 * @returns {{ raw: any, backend: string }|null}
 */
function tryBetterSqlite3(file) {
  const require_ = createRequire(import.meta.url);
  /** @type {any} */
  let Database;
  try {
    Database = require_('better-sqlite3');
  } catch {
    return null;
  }
  /** @type {(string|undefined)[]} */
  const candidates = [];
  try {
    const pkgDir = path.dirname(require_.resolve('better-sqlite3/package.json'));
    const rel = path.join(pkgDir, 'build', 'Release');
    const abiName = process.versions.electron ? 'better_sqlite3-electron.node' : 'better_sqlite3-node.node';
    const preferred = path.join(rel, abiName);
    if (fs.existsSync(preferred)) candidates.push(preferred);
  } catch { /* noop */ }
  candidates.push(undefined); // 既定の build/Release/better_sqlite3.node
  let lastErr = null;
  for (const nativeBinding of candidates) {
    try {
      const raw = new Database(file, nativeBinding ? { nativeBinding } : {});
      return { raw, backend: `better-sqlite3${nativeBinding ? ` (${path.basename(nativeBinding)})` : ''}` };
    } catch (e) {
      lastErr = e;
    }
  }
  if (process.env.QUOTA_TRAIL_DEBUG_DB) process.stderr.write(`better-sqlite3 load failed: ${lastErr}\n`);
  return null;
}

/**
 * node:sqlite (Node >= 22.13) を読み込む。
 * @param {string} file
 * @returns {{ raw: any, backend: string }|null}
 */
function tryNodeSqlite(file) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (!(maj > 22 || (maj === 22 && min >= 13))) return null;
  try {
    // 同期 require で node:sqlite を掴む（ESM の動的 import は非同期のため）
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync } = require_('node:sqlite');
    const raw = new DatabaseSync(file);
    return { raw, backend: 'node:sqlite' };
  } catch {
    return null;
  }
}

/**
 * DB を開いて（無ければ作って）マイグレーションする。
 * @param {string} file  sqlite ファイルのパス
 * @returns {{
 *   backend: string,
 *   dbPath: string,
 *   insertSamples: (samples: Sample[]) => number,
 *   querySamples: (q: {provider:string, win:string, from:number, to:number}) => Sample[],
 *   queryAllSeries: (q: {from:number, to:number}) => Record<string, Sample[]>,
 *   latest: () => Record<string, Sample|null>,
 *   pruneOlderThan: (cutoffMs:number) => number,
 *   count: () => number,
 *   close: () => void,
 * }}
 */
export function openDb(file) {
  const dir = path.dirname(file);
  if (dir && dir !== '.') {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  }

  const loaded = tryBetterSqlite3(file) ?? tryNodeSqlite(file);
  if (!loaded) {
    throw new Error('SQLite バックエンドを読み込めません（better-sqlite3 のビルド失敗、かつ node:sqlite 非対応）');
  }
  const { raw, backend } = loaded;

  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA synchronous = NORMAL;');
  raw.exec(SCHEMA);
  const ver = raw.prepare('SELECT version FROM schema_version LIMIT 1').all();
  if (ver.length === 0) raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);

  const insertStmt = raw.prepare(
    'INSERT INTO samples (observed_at, provider, win, used_percent, resets_at, status, error_code, interval_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const inRangeStmt = raw.prepare(
    'SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at ASC',
  );
  const beforeStmt = raw.prepare(
    'SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1',
  );
  const afterStmt = raw.prepare(
    'SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at > ? ORDER BY observed_at ASC LIMIT 1',
  );
  const latestStmt = raw.prepare(
    'SELECT * FROM samples WHERE provider = ? AND win = ? ORDER BY observed_at DESC LIMIT 1',
  );
  const pruneStmt = raw.prepare('DELETE FROM samples WHERE observed_at < ?');
  const countStmt = raw.prepare('SELECT COUNT(*) AS n FROM samples');

  return {
    backend,
    dbPath: file,

    insertSamples(samples) {
      if (!Array.isArray(samples) || samples.length === 0) return 0;
      raw.exec('BEGIN');
      try {
        for (const s of samples) {
          insertStmt.run(
            Math.round(s.observedAt),
            String(s.provider),
            String(s.window),
            s.usedPercent === null || s.usedPercent === undefined ? null : Number(s.usedPercent),
            s.resetsAt === null || s.resetsAt === undefined ? null : Math.round(s.resetsAt),
            String(s.status),
            s.errorCode === null || s.errorCode === undefined ? null : String(s.errorCode),
            Math.round(s.intervalSec),
          );
        }
        raw.exec('COMMIT');
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      return samples.length;
    },

    querySamples({ provider, win, from, to }) {
      const a = Math.round(from);
      const b = Math.round(to);
      const rows = inRangeStmt.all(provider, win, a, b).map(rowToSample);
      const before = beforeStmt.all(provider, win, a).map(rowToSample);
      const after = afterStmt.all(provider, win, b).map(rowToSample);
      return [...before, ...rows, ...after];
    },

    queryAllSeries({ from, to }) {
      /** @type {Record<string, Sample[]>} */
      const out = {};
      for (const [provider, win] of SERIES) {
        out[`${provider}/${win}`] = this.querySamples({ provider, win, from, to });
      }
      return out;
    },

    latest() {
      /** @type {Record<string, Sample|null>} */
      const out = {};
      for (const [provider, win] of SERIES) {
        const rows = latestStmt.all(provider, win).map(rowToSample);
        out[`${provider}/${win}`] = rows.length > 0 ? rows[0] : null;
      }
      return out;
    },

    pruneOlderThan(cutoffMs) {
      const r = pruneStmt.run(Math.round(cutoffMs));
      return Number(r.changes ?? 0);
    },

    count() {
      const rows = countStmt.all();
      return rows.length ? Number(rows[0].n) : 0;
    },

    close() {
      try { raw.close(); } catch { /* noop */ }
    },
  };
}

export { SERIES };
