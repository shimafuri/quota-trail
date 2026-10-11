// 1 行 JSON のログ（設計書 §10）
// userData/logs/quota-trail.log、1 MB でローテーション（1 世代）。
// トークン・ヘッダは絶対に書かない（呼び出し側が渡さない前提だが、念のため既知のキーを落とす）。
// 設計書 §15.6: token fingerprint・内部キー・CLI の raw 出力も防御として落とす。文字列中の sk-ant- token と SHA-256 hex も伏せる。
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
const SECRET_KEYS = /^(authorization|cookie|token|access_token|accessToken|refresh_token|refreshToken|apiKey|api_key|headers|credentials|account_id|accountId|account_uuid|accountUuid|email|emailAddress|id_token|sub|profile|nonce|identifierAccessToken|identifier_access_token|fingerprint|tokenFingerprint|token_fingerprint|credentialKey|credential_key|stdout|stderr|rawOutput|raw_output|cliOutput|cli_output)$/i;
const PRIVATE_TEXT = /\bsk-ant-[A-Za-z0-9_-]+|\b[0-9a-f]{64}\b|Bearer\s+[^\s"']+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/ig;

/** @type {{ file: string|null, dir: string|null }} */
const state = { file: null, dir: null };

/**
 * ログ出力先を設定する。
 * @param {string} logDir
 */
export function initLogger(logDir) {
  state.dir = logDir;
  state.file = path.join(logDir, 'quota-trail.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    state.file = null;
  }
  return state.file;
}

/** 秘匿キーを落とした浅いコピー */
function sanitize(obj) {
  if (typeof obj === 'string') return obj.replace(PRIVATE_TEXT, '[REDACTED]');
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = sanitize(v);
  }
  return out;
}
export const sanitizeForLog = sanitize;

function rotateIfNeeded() {
  if (!state.file) return;
  try {
    const st = fs.statSync(state.file);
    if (st.size < MAX_BYTES) return;
    const old = `${state.file}.1`;
    try { fs.rmSync(old, { force: true }); } catch { /* noop */ }
    fs.renameSync(state.file, old);
  } catch {
    // ファイルが無い等は無視
  }
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export function log(level, msg, fields) {
  const rec = { t: new Date().toISOString(), level, msg, ...(fields ? sanitize(fields) : {}) };
  let line;
  try {
    line = `${JSON.stringify(rec)}\n`;
  } catch {
    line = `${JSON.stringify({ t: rec.t, level, msg })}\n`;
  }
  // 開発時に見えるよう stdout にも出す
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
  if (!state.file) return;
  rotateIfNeeded();
  try {
    fs.appendFileSync(state.file, line);
  } catch {
    // ログ書き込み失敗でアプリを落とさない
  }
}

export const debug = (msg, f) => log('debug', msg, f);
export const info = (msg, f) => log('info', msg, f);
export const warn = (msg, f) => log('warn', msg, f);
export const error = (msg, f) => log('error', msg, f);

/** 現在のログファイルパス（未初期化なら null） */
export function logPath() {
  return state.file;
}
