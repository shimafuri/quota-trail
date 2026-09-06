// Codex CLI の使用率取得（設計書 §4.4）
// - 資格情報は毎回読み直す。書き込みは一切しない
// - 401 または応答形不一致のとき 1 回だけ `codex app-server` にフォールバック
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../lib/exec.mjs';
import { normalizeCodex, normalizeCodexAppServer, errorSamples, httpErrorCode, allFailed } from '../lib/normalize.mjs';
import { readRateLimitsViaAppServer } from './codex-app-server.mjs';

const USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';
const TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'codex-cli/0.153.4';

/** @type {string|null} */
let cachedUserAgent = null;

/** auth.json のパス */
export function authPath() {
  const dir = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ''
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  return path.join(dir, 'auth.json');
}

/**
 * access_token / account_id を読む。
 * @returns {{ token: string|null, accountId: string|null, errorCode: string|null }}
 */
export function readAuth() {
  const file = authPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { token: null, accountId: null, errorCode: 'no_credentials' };
  }
  try {
    const json = JSON.parse(text);
    const token = json?.tokens?.access_token;
    const accountId = json?.tokens?.account_id ?? null;
    if (typeof token !== 'string' || token === '') return { token: null, accountId: null, errorCode: 'no_credentials' };
    return { token, accountId: typeof accountId === 'string' ? accountId : null, errorCode: null };
  } catch {
    return { token: null, accountId: null, errorCode: 'parse' };
  }
}

/** `codex --version` を 1 回だけ実行して User-Agent を作る */
export async function initUserAgent() {
  if (cachedUserAgent) return cachedUserAgent;
  const { stdout } = await runCommand('codex', ['--version'], { timeoutMs: 8000 });
  const m = /(\d+\.\d+\.\d+)/.exec(stdout || '');
  cachedUserAgent = m ? `codex-cli/${m[1]}` : DEFAULT_UA;
  return cachedUserAgent;
}

export function userAgent() {
  return cachedUserAgent ?? DEFAULT_UA;
}

/**
 * Codex の使用率を取得して Sample[]（5h / weekly の 2 行）を返す。例外は投げない。
 * @param {{observedAt:number, intervalSec:number, allowAppServer?:boolean}} ctx
 * @returns {Promise<import('../lib/normalize.mjs').Sample[]>}
 */
export async function fetchCodexSamples({ observedAt, intervalSec, allowAppServer = true }) {
  const { token, accountId, errorCode } = readAuth();
  if (!token) {
    // 資格情報が無い場合も app-server が自前でログイン情報を持っていることがある
    if (allowAppServer) {
      const viaCli = await tryAppServer({ observedAt, intervalSec });
      if (viaCli) return viaCli;
    }
    return errorSamples('codex', { observedAt, intervalSec, errorCode: errorCode ?? 'no_credentials' });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  /** @type {import('../lib/normalize.mjs').Sample[]|null} */
  let httpRows = null;
  /** @type {string|null} */
  let httpError = null;
  try {
    /** @type {Record<string,string>} */
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent(),
      Accept: 'application/json',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;

    const res = await fetch(USAGE_URL, { method: 'GET', signal: ac.signal, headers });
    if (!res.ok) {
      try { await res.text(); } catch { /* noop */ }
      httpError = httpErrorCode(res.status);
    } else {
      let json;
      try {
        json = await res.json();
      } catch {
        httpError = 'parse';
      }
      if (!httpError) {
        httpRows = normalizeCodex(json, { observedAt, intervalSec });
        if (allFailed(httpRows)) httpError = 'parse';
      }
    }
  } catch (e) {
    httpError = e && e.name === 'AbortError' ? 'timeout' : 'network';
  } finally {
    clearTimeout(timer);
  }

  if (httpRows && !httpError) return httpRows;

  // フォールバック条件: 401（auth_expired）または応答形不一致（parse）のとき 1 回だけ
  const shouldFallback = allowAppServer && (httpError === 'auth_expired' || httpError === 'parse');
  if (shouldFallback) {
    const viaCli = await tryAppServer({ observedAt, intervalSec });
    if (viaCli) return viaCli;
  }
  // 応答形不一致でも 5h だけ読めていた等の部分結果があればそれを返す
  if (httpRows) return httpRows;
  return errorSamples('codex', { observedAt, intervalSec, errorCode: httpError ?? 'network' });
}

/**
 * app-server フォールバック。読めなければ null。
 * @returns {Promise<import('../lib/normalize.mjs').Sample[]|null>}
 */
async function tryAppServer({ observedAt, intervalSec }) {
  const r = await readRateLimitsViaAppServer({});
  if (!r.ok) return null;
  const rows = normalizeCodexAppServer(r.result, { observedAt, intervalSec });
  if (allFailed(rows)) return null;
  return rows;
}
