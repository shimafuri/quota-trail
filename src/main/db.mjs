// SQLite 永続化とアカウント分離（設計書 §4）。
// better-sqlite3 を優先し、読み込めなければ Electron 同梱 Node の node:sqlite
// にフォールバックする。どちらを使っているかは openDb().backend で分かる。
// v1 行は migration 時点の上限 ID までに限定して、後から一回だけ backfill する。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { warn } from './logger.mjs';

const V1_SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_samples_series_time
  ON samples (provider, win, observed_at);
`;

const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  account_uuid TEXT,
  email TEXT,
  alias_no INTEGER NOT NULL,
  identity_source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_uuid
  ON accounts (provider, account_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_email
  ON accounts (provider, email);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_alias
  ON accounts (provider, alias_no);
CREATE TABLE IF NOT EXISTS account_backfill_v2 (
  provider TEXT PRIMARY KEY,
  through_sample_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  target_account_id INTEGER,
  attempted_at INTEGER
);
`;

export const SERIES = [
  ['claude', '5h'],
  ['claude', 'weekly'],
  ['codex', '5h'],
  ['codex', 'weekly'],
];

/** @typedef {import('./lib/normalize.mjs').Sample} Sample */

/**
 * DB 行を renderer に渡す Sample へ変換する。
 * @param {any} row
 * @returns {Sample}
 */
function rowToSample(row) {
  return {
    observedAt: Number(row.observed_at),
    provider: /** @type {any} */ (row.provider),
    window: /** @type {any} */ (row.win),
    usedPercent: row.used_percent == null ? null : Number(row.used_percent),
    resetsAt: row.resets_at == null ? null : Number(row.resets_at),
    status: /** @type {any} */ (row.status),
    errorCode: row.error_code == null ? null : String(row.error_code),
    intervalSec: Number(row.interval_sec),
  };
}

/**
 * better-sqlite3 を読み込む。ABI が合わなければ null。
 * @param {string} file
 * @returns {{raw:any, backend:string}|null}
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
    const packageDir = path.dirname(require_.resolve('better-sqlite3/package.json'));
    const releaseDir = path.join(packageDir, 'build', 'Release');
    const abiName = process.versions.electron
      ? 'better_sqlite3-electron.node'
      : 'better_sqlite3-node.node';
    const preferred = path.join(releaseDir, abiName);
    if (fs.existsSync(preferred)) {
      candidates.push(preferred);
    }
  } catch { /* noop */ }
  candidates.push(undefined);
  let lastError = null;
  for (const nativeBinding of candidates) {
    try {
      const raw = new Database(file, nativeBinding ? { nativeBinding } : {});
      const suffix = nativeBinding ? ` (${path.basename(nativeBinding)})` : '';
      return { raw, backend: `better-sqlite3${suffix}` };
    } catch (error) {
      lastError = error;
    }
  }
  if (process.env.QUOTA_TRAIL_DEBUG_DB) {
    process.stderr.write(`better-sqlite3 load failed: ${lastError}\n`);
  }
  return null;
}

/**
 * node:sqlite（Node >= 22.13）を読み込む。
 * @param {string} file
 * @returns {{raw:any, backend:string}|null}
 */
function tryNodeSqlite(file) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 13))) {
    return null;
  }
  try {
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync } = require_('node:sqlite');
    return { raw: new DatabaseSync(file), backend: 'node:sqlite' };
  } catch {
    return null;
  }
}

/** @param {any} raw @param {string} name @returns {boolean} */
function hasColumn(raw, name) {
  return raw.prepare('PRAGMA table_info(samples)').all().some((column) => column.name === name);
}

/** @param {any} raw @param {string} name @returns {boolean} */
function hasTable(raw, name) {
  return raw.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length > 0;
}

/** @param {any} raw @param {string} name @returns {boolean} */
function hasIndex(raw, name) {
  return raw.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = ?").all(name).length > 0;
}

/** @param {any} raw @returns {boolean} */
function hasCompleteV2Schema(raw) {
  return hasColumn(raw, 'account_id')
    && hasTable(raw, 'accounts')
    && hasTable(raw, 'account_backfill_v2')
    && hasIndex(raw, 'ux_accounts_provider_uuid')
    && hasIndex(raw, 'ux_accounts_provider_email')
    && hasIndex(raw, 'ux_accounts_provider_alias')
    && hasIndex(raw, 'idx_samples_account_series_time');
}

/** @template T @param {any} raw @param {() => T} callback @returns {T} */
function transaction(raw, callback) {
  raw.exec('BEGIN');
  try {
    const result = callback();
    raw.exec('COMMIT');
    return result;
  } catch (error) {
    try { raw.exec('ROLLBACK'); } catch { /* noop */ }
    throw error;
  }
}

/** @param {Sample} sample @returns {unknown[]} */
function sampleArgs(sample) {
  return [
    Math.round(sample.observedAt),
    String(sample.provider),
    String(sample.window),
    sample.usedPercent == null ? null : Number(sample.usedPercent),
    sample.resetsAt == null ? null : Math.round(sample.resetsAt),
    String(sample.status),
    sample.errorCode == null ? null : String(sample.errorCode),
    Math.round(sample.intervalSec),
  ];
}

/**
 * DB を開き、v1 の schema を保証してから v2 へ移行する。
 * @param {string} file sqlite ファイルのパス
 * @returns {ReturnType<typeof createDbApi>}
 */
export function openDb(file) {
  const directory = path.dirname(file);
  if (directory && directory !== '.') {
    try { fs.mkdirSync(directory, { recursive: true }); } catch { /* noop */ }
  }
  const loaded = tryBetterSqlite3(file) ?? tryNodeSqlite(file);
  if (!loaded) {
    throw new Error('SQLite バックエンドを読み込めません（better-sqlite3 のビルド失敗、かつ node:sqlite 非対応）');
  }
  const { raw, backend } = loaded;
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA synchronous = NORMAL;');
  raw.exec(V1_SCHEMA);
  if (raw.prepare('SELECT version FROM schema_version LIMIT 1').all().length === 0) {
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }
  let accountDimensionAvailable = true;
  try {
    const version = Number(raw.prepare('SELECT MAX(version) AS n FROM schema_version').all()[0]?.n ?? 0);
    if (version < 2 || !hasCompleteV2Schema(raw)) {
      transaction(raw, () => migrateV2(raw));
    }
  } catch {
    // 構造 migration の失敗時も v1 の記録・表示は継続する。
    accountDimensionAvailable = false;
    warn('db_migration_failed');
  }
  return createDbApi(raw, backend, file, accountDimensionAvailable);
}

/**
 * v2 構造を作る。各 provider の cutoff は ALTER 前の既存行に固定する。
 * @param {any} raw
 * @returns {void}
 */
function migrateV2(raw) {
  raw.exec(V2_SCHEMA);
  for (const provider of ['claude', 'codex']) {
    const row = raw.prepare('SELECT MAX(id) AS n FROM samples WHERE provider = ?').all(provider)[0];
    const cutoff = Number(row?.n ?? 0);
    const state = cutoff === 0 ? 'assigned' : 'pending';
    raw.prepare('INSERT OR IGNORE INTO account_backfill_v2 (provider, through_sample_id, state, target_account_id, attempted_at) VALUES (?, ?, ?, NULL, NULL)').run(provider, cutoff, state);
  }
  if (!hasColumn(raw, 'account_id')) {
    raw.exec('ALTER TABLE samples ADD COLUMN account_id INTEGER;');
  }
  raw.exec('CREATE INDEX IF NOT EXISTS idx_samples_account_series_time ON samples (provider, account_id, win, observed_at, id);');
  // schema_version は複数行になり得るため、一行の v2 表現へ正規化する。
  raw.exec('DELETE FROM schema_version;');
  raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
}

/**
 * v1/v2 両対応の公開 DB API を構築する。
 * @param {any} raw
 * @param {string} backend
 * @param {string} file
 * @param {boolean} accountDimensionAvailable
 * @returns {any}
 */
function createDbApi(raw, backend, file, accountDimensionAvailable) {
  const insertV1 = raw.prepare('INSERT INTO samples (observed_at, provider, win, used_percent, resets_at, status, error_code, interval_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertV2 = accountDimensionAvailable
    ? raw.prepare('INSERT INTO samples (observed_at, provider, win, used_percent, resets_at, status, error_code, interval_sec, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    : null;

  /** @param {any} identity @param {number} [observedAt] @returns {number|null} */
  function upsertAccount(identity, observedAt = Date.now()) {
    if (!accountDimensionAvailable || !identity || (!identity.uuid && !identity.email)) {
      return null;
    }
    const provider = String(identity.provider);
    const uuid = identity.uuid ?? null;
    const email = identity.email ?? null;
    const uuidRow = uuid
      ? raw.prepare('SELECT * FROM accounts WHERE provider = ? AND account_uuid = ?').all(provider, uuid)[0]
      : null;
    const emailRow = email
      ? raw.prepare('SELECT * FROM accounts WHERE provider = ? AND email = ?').all(provider, email)[0]
      : null;
    // UUID が指定された場合、別 UUID を持つ email 行を採用してはならない。
    // その場合は UUID 用の別行を作り、email は衝突させずに残す。
    const emailCanSupplementUuid = !uuid || !emailRow || emailRow.account_uuid == null;
    const account = uuidRow ?? (emailCanSupplementUuid ? emailRow : null);
    const conflict = Boolean(
      (uuidRow && emailRow && uuidRow.id !== emailRow.id)
      || (uuid && emailRow && emailRow.account_uuid != null && emailRow.account_uuid !== uuid),
    );
    if (account) {
      // UUID 優先。別行の email は自動 merge せず、現在の UUID 行を守る。
      raw.prepare('UPDATE accounts SET account_uuid = COALESCE(account_uuid, ?), email = CASE WHEN ? THEN COALESCE(email, ?) ELSE email END, identity_source = ?, last_seen_at = ? WHERE id = ?').run(
        account.account_uuid ? null : uuid,
        conflict ? 0 : 1,
        conflict ? null : email,
        String(identity.source ?? 'unknown'),
        Math.round(observedAt),
        account.id,
      );
      if (conflict) {
        warn('account_upsert_identity_conflict');
      }
      return Number(account.id);
    }
    // alias_no は provider ごとの MAX + 1 とし、更新・再利用しない。
    const aliasRow = raw.prepare('SELECT MAX(alias_no) AS n FROM accounts WHERE provider = ?').all(provider)[0];
    const aliasNo = Number(aliasRow?.n ?? 0) + 1;
    const result = raw.prepare('INSERT INTO accounts (provider, account_uuid, email, alias_no, identity_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      provider, uuid, conflict ? null : email, aliasNo, String(identity.source ?? 'unknown'), Math.round(observedAt), Math.round(observedAt),
    );
    if (conflict) {
      warn('account_upsert_identity_conflict');
    }
    return Number(result.lastInsertRowid);
  }

  /** @param {string} provider @param {string} win @param {number|null} accountId @param {'inside'|'before'|'after'|'latest'} mode @param {number} from @param {number} to @returns {Sample[]} */
  function selectSamples(provider, win, accountId, mode, from, to) {
    const condition = accountId === null ? 'account_id IS NULL' : 'account_id = ?';
    const parameters = accountId === null ? [provider, win] : [provider, win, accountId];
    let sql = `SELECT * FROM samples WHERE provider = ? AND win = ? AND ${condition}`;
    if (mode === 'inside') {
      sql += ' AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at, id';
      parameters.push(from, to);
    } else if (mode === 'before') {
      sql += ' AND observed_at < ? ORDER BY observed_at DESC, id DESC LIMIT 1';
      parameters.push(from);
    } else if (mode === 'after') {
      sql += ' AND observed_at > ? ORDER BY observed_at, id LIMIT 1';
      parameters.push(to);
    } else {
      sql += ' ORDER BY observed_at DESC, id DESC LIMIT 1';
    }
    return raw.prepare(sql).all(...parameters).map(rowToSample);
  }

  return {
    backend,
    dbPath: file,
    accountDimensionAvailable,

    /** @param {Sample[]} samples @returns {number} */
    insertSamples(samples) {
      if (!Array.isArray(samples) || samples.length === 0) {
        return 0;
      }
      return transaction(raw, () => {
        for (const sample of samples) {
          insertV1.run(...sampleArgs(sample));
        }
        return samples.length;
      });
    },

    /** @param {{provider:string, samples:Sample[], identity:any}[]} batches @returns {number} */
    recordPoll(batches) {
      if (!Array.isArray(batches) || batches.length === 0) {
        return 0;
      }
      return transaction(raw, () => {
        let count = 0;
        for (const batch of batches) {
          const accountId = upsertAccount(batch.identity);
          for (const sample of batch.samples ?? []) {
            if (insertV2) {
              insertV2.run(...sampleArgs(sample), accountId);
            } else {
              insertV1.run(...sampleArgs(sample));
            }
            count += 1;
          }
        }
        return count;
      });
    },

    /** @param {any} identity @returns {number|null} */
    upsertAccount(identity) {
      return transaction(raw, () => upsertAccount(identity));
    },

    /** @returns {{provider:string, accountKey:string, label:string}[]} */
    listAccounts() {
      if (!accountDimensionAvailable) {
        return [];
      }
      return raw.prepare('SELECT provider, alias_no FROM accounts ORDER BY provider, alias_no').all().map((row) => ({
        provider: row.provider,
        accountKey: `${row.provider}:${row.alias_no}`,
        label: `アカウント${row.alias_no}`,
      }));
    },

    /** @param {string} provider @returns {boolean} */
    hasUnknownSamples(provider) {
      if (!accountDimensionAvailable) {
        return false;
      }
      return raw.prepare('SELECT 1 AS found FROM samples WHERE provider = ? AND account_id IS NULL LIMIT 1').all(provider).length > 0;
    },

    /**
     * 全 account の表示用識別情報を alias 順で返す（設計書 §3.4）。
     * メールを優先し、メールが無い行だけ UUID を返す。
     * UUID もメールも無い行、および v1 縮退時は返さない。
     * @returns {{provider:string, accountKey:string, kind:'email'|'uuid', value:string}[]}
     */
    listAccountIdentifiers() {
      if (!accountDimensionAvailable) {
        return [];
      }
      const rows = raw.prepare('SELECT provider, alias_no, account_uuid, email FROM accounts ORDER BY provider, alias_no').all();
      /** @type {{provider:string, accountKey:string, kind:'email'|'uuid', value:string}[]} */
      const out = [];
      for (const row of rows) {
        const email = typeof row.email === 'string' && row.email !== '' ? row.email : null;
        const uuid = typeof row.account_uuid === 'string' && row.account_uuid !== '' ? row.account_uuid : null;
        if (email === null && uuid === null) {
          continue;
        }
        out.push({
          provider: String(row.provider),
          accountKey: `${row.provider}:${row.alias_no}`,
          kind: email === null ? 'uuid' : 'email',
          value: email === null ? uuid : email,
        });
      }
      return out;
    },

    /** @param {string} provider @param {unknown} accountKey @returns {number|null|'invalid'} */
    resolveAccountKey(provider, accountKey) {
      if (!accountDimensionAvailable) {
        return 'invalid';
      }
      if (accountKey === `${provider}:unknown`) {
        return null;
      }
      if (typeof accountKey !== 'string' || !new RegExp(`^${provider}:[1-9][0-9]*$`).test(accountKey)) {
        return 'invalid';
      }
      const aliasNo = Number(accountKey.slice(provider.length + 1));
      const row = raw.prepare('SELECT id FROM accounts WHERE provider = ? AND alias_no = ?').all(provider, aliasNo)[0];
      return row ? Number(row.id) : 'invalid';
    },

    /** @param {{provider:string, win:string, accountId?:number|null, from:number, to:number}} query @returns {Sample[]} */
    querySamples({ provider, win, accountId = null, from, to }) {
      const start = Math.round(from);
      const end = Math.round(to);
      if (!accountDimensionAvailable) {
        const inside = raw.prepare('SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at, id').all(provider, win, start, end);
        const before = raw.prepare('SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at < ? ORDER BY observed_at DESC, id DESC LIMIT 1').all(provider, win, start);
        const after = raw.prepare('SELECT * FROM samples WHERE provider = ? AND win = ? AND observed_at > ? ORDER BY observed_at, id LIMIT 1').all(provider, win, end);
        return [...before, ...inside, ...after].map(rowToSample);
      }
      return [
        ...selectSamples(provider, win, accountId, 'before', start, end),
        ...selectSamples(provider, win, accountId, 'inside', start, end),
        ...selectSamples(provider, win, accountId, 'after', start, end),
      ];
    },

    /** @param {{from:number, to:number, accountIdsByProvider?:Record<string, number|null>}} query @returns {Record<string, Sample[]>} */
    queryAllSeries({ from, to, accountIdsByProvider = { claude: null, codex: null } }) {
      /** @type {Record<string, Sample[]>} */
      const result = {};
      for (const [provider, win] of SERIES) {
        result[`${provider}/${win}`] = this.querySamples({
          provider, win, accountId: accountIdsByProvider[provider] ?? null, from, to,
        });
      }
      return result;
    },

    /** @param {{accountIdsByProvider?:Record<string, number|null>}} [query] @returns {Record<string, Sample|null>} */
    latest({ accountIdsByProvider = { claude: null, codex: null } } = {}) {
      /** @type {Record<string, Sample|null>} */
      const result = {};
      for (const [provider, win] of SERIES) {
        if (accountDimensionAvailable) {
          result[`${provider}/${win}`] = selectSamples(provider, win, accountIdsByProvider[provider] ?? null, 'latest', 0, 0)[0] ?? null;
        } else {
          const row = raw.prepare('SELECT * FROM samples WHERE provider = ? AND win = ? ORDER BY observed_at DESC, id DESC LIMIT 1').all(provider, win)[0];
          result[`${provider}/${win}`] = row ? rowToSample(row) : null;
        }
      }
      return result;
    },

    /** @param {string} provider @param {any} identity @returns {{state:string, accountId?:number}} */
    finishV2Backfill(provider, identity) {
      if (!accountDimensionAvailable) {
        return { state: 'unavailable' };
      }
      let backfill = raw.prepare('SELECT * FROM account_backfill_v2 WHERE provider = ?').all(provider)[0];
      if (!backfill || backfill.state === 'assigned' || backfill.state === 'unresolved') {
        return { state: backfill?.state ?? 'none' };
      }
      // target の確定だけを先に commit する。クラッシュ後も別 account へ付け替えない。
      if (backfill.state !== 'targeted') {
        const target = transaction(raw, () => {
          const accountId = upsertAccount(identity);
          if (!accountId) {
            raw.prepare("UPDATE account_backfill_v2 SET state = 'unresolved', attempted_at = ? WHERE provider = ?").run(Date.now(), provider);
            return null;
          }
          raw.prepare("UPDATE account_backfill_v2 SET target_account_id = ?, state = 'targeted', attempted_at = ? WHERE provider = ?").run(accountId, Date.now(), provider);
          return accountId;
        });
        if (!target) {
          return { state: 'unresolved' };
        }
        backfill = raw.prepare('SELECT * FROM account_backfill_v2 WHERE provider = ?').all(provider)[0];
      }
      const accountId = Number(backfill.target_account_id);
      transaction(raw, () => {
        raw.prepare('UPDATE samples SET account_id = ? WHERE provider = ? AND account_id IS NULL AND id <= ?').run(accountId, provider, backfill.through_sample_id);
        raw.prepare("UPDATE account_backfill_v2 SET state = 'assigned' WHERE provider = ?").run(provider);
      });
      return { state: 'assigned', accountId };
    },

    /** @param {number} cutoffMs @returns {number} */
    pruneOlderThan(cutoffMs) {
      const result = raw.prepare('DELETE FROM samples WHERE observed_at < ?').run(Math.round(cutoffMs));
      return Number(result.changes ?? 0);
    },

    /** @returns {number} */
    count() {
      const row = raw.prepare('SELECT COUNT(*) AS n FROM samples').all()[0];
      return Number(row?.n ?? 0);
    },

    /** @returns {void} */
    close() {
      try { raw.close(); } catch { /* noop */ }
    },
  };
}
