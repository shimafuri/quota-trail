// Claude Code の使用率取得（設計書 §4.2 / §4.3）
// - 資格情報は毎回読み直す（Claude Code が refresh して書き換えるため）
// - 自発的な token refresh はしない。401 は auth_expired として記録するだけ
// - トークンやヘッダは絶対にログへ出さない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../lib/exec.mjs';
import { normalizeClaude, errorSamples, httpErrorCode } from '../lib/normalize.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'claude-code/2.1.263';

/** @type {string|null} */
let cachedUserAgent = null;

/** 資格情報ファイルのパス */
export function credentialsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== ''
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

/**
 * accessToken を読む。書き込みは一切しない。
 * @returns {{ token: string|null, errorCode: string|null }}
 */
export function readAccessToken() {
  const file = credentialsPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { token: null, errorCode: 'no_credentials' };
  }
  try {
    const json = JSON.parse(text);
    const token = json?.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || token === '') return { token: null, errorCode: 'no_credentials' };
    return { token, errorCode: null };
  } catch {
    return { token: null, errorCode: 'parse' };
  }
}

/**
 * `claude --version` を 1 回だけ実行して User-Agent を作る。取れなければ既定値。
 * @returns {Promise<string>}
 */
export async function initUserAgent() {
  if (cachedUserAgent) return cachedUserAgent;
  const { stdout } = await runCommand('claude', ['--version'], { timeoutMs: 8000 });
  const m = /(\d+\.\d+\.\d+)/.exec(stdout || '');
  cachedUserAgent = m ? `claude-code/${m[1]}` : DEFAULT_UA;
  return cachedUserAgent;
}

/** 現在の User-Agent（未取得なら既定値） */
export function userAgent() {
  return cachedUserAgent ?? DEFAULT_UA;
}

/**
 * Claude の使用率を取得して Sample[]（5h / weekly の 2 行）を返す。
 * 例外は投げない。
 * @param {{observedAt:number, intervalSec:number}} ctx
 * @returns {Promise<import('../lib/normalize.mjs').Sample[]>}
 */
export async function fetchClaudeSamples({ observedAt, intervalSec }) {
  const { token, errorCode } = readAccessToken();
  if (!token) return errorSamples('claude', { observedAt, intervalSec, errorCode: errorCode ?? 'no_credentials' });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': userAgent(),
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      // 本文は読み捨て（トークンを含みうる情報は残さない）
      try { await res.text(); } catch { /* noop */ }
      return errorSamples('claude', { observedAt, intervalSec, errorCode: httpErrorCode(res.status) });
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return errorSamples('claude', { observedAt, intervalSec, errorCode: 'parse' });
    }
    return normalizeClaude(json, { observedAt, intervalSec });
  } catch (e) {
    const code = e && e.name === 'AbortError' ? 'timeout' : 'network';
    return errorSamples('claude', { observedAt, intervalSec, errorCode: code });
  } finally {
    clearTimeout(timer);
  }
}
