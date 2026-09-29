// Claude Code の使用率取得（設計書 §4.2 / §4.3）
// - 資格情報は毎回読み直す（Claude Code が refresh して書き換えるため）
// - 自発的な token refresh はしない。401 は auth_expired として記録するだけ
// - トークンやヘッダは絶対にログへ出さない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../lib/exec.mjs';
import { normalizeClaude, errorSamples, httpErrorCode } from '../lib/normalize.mjs';
import { claudeIdentityFromProfile, claudeLocalFallback } from '../lib/account-identity.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'claude-code/2.1.263';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const profileCache = new Map();
const PROFILE_SUCCESS_TTL_MS = 60 * 60_000;
const PROFILE_RETRY_TTL_MS = 5 * 60_000;
const PROFILE_CACHE_MAX_ENTRIES = 8;
const PROFILE_CACHE_MAX_IDLE_MS = 24 * 60 * 60_000;

/** @type {string|null} */
let cachedUserAgent = null;

/** 資格情報ファイルのパス */
export function credentialsPath() {
  return path.join(claudeConfigDir(), '.credentials.json');
}

/** CLAUDE_CONFIG_DIR を尊重した資格情報ディレクトリ */
function claudeConfigDir() {
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    return process.env.CLAUDE_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.claude');
}

/** CLAUDE_CONFIG_DIR を尊重したローカル fallback ファイルのパス */
function localFallbackPath() {
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    return path.join(claudeConfigDir(), '.claude.json');
  }
  return path.join(os.homedir(), '.claude.json');
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
    return { token, organizationUuid: typeof json?.organizationUuid === 'string' ? json.organizationUuid : null, errorCode: null };
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

function readLocalFallback(credentialOrganizationUuid) {
  try {
    const local = JSON.parse(fs.readFileSync(localFallbackPath(), 'utf8'));
    return claudeLocalFallback({ local, credentialOrganizationUuid });
  } catch {
    return null;
  }
}

/**
 * 最終参照から 24 時間を超えた entry を捨て、最大 8 件の LRU に抑える。
 * @param {number} currentTime
 * @returns {void}
 */
function pruneProfileCache(currentTime) {
  for (const [fingerprint, entry] of profileCache) {
    if (currentTime - entry.lastUsedAt > PROFILE_CACHE_MAX_IDLE_MS) {
      profileCache.delete(fingerprint);
    }
  }
  if (profileCache.size <= PROFILE_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldest = [...profileCache.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  for (const [fingerprint] of oldest.slice(0, profileCache.size - PROFILE_CACHE_MAX_ENTRIES)) {
    profileCache.delete(fingerprint);
  }
}

/**
 * 権威 profile の成功を cache entry に反映する。
 * @param {string} fingerprint
 * @param {any} identity
 * @param {any} previous
 * @param {number} currentTime
 * @returns {any}
 */
function cacheProfileResult(fingerprint, identity, previous, currentTime) {
  const entry = {
    authoritativeIdentity: identity ?? previous?.authoritativeIdentity ?? null,
    authoritativeExpiresAt: identity ? currentTime + PROFILE_SUCCESS_TTL_MS : (previous?.authoritativeExpiresAt ?? 0),
    localFallbackIdentity: identity ? null : (previous?.localFallbackIdentity ?? null),
    localFallbackExpiresAt: identity ? 0 : (previous?.localFallbackExpiresAt ?? 0),
    profileRetryAt: currentTime + (identity ? PROFILE_SUCCESS_TTL_MS : PROFILE_RETRY_TTL_MS),
    lastUsedAt: currentTime,
  };
  profileCache.set(fingerprint, entry);
  pruneProfileCache(currentTime);
  return entry;
}

/**
 * Claude の使用率を取得して Sample[]（5h / weekly / weekly-fable の 3 行）を返す。
 * 例外は投げない。
 * @param {{observedAt:number, intervalSec:number}} ctx
 * @returns {Promise<{provider:string, samples:import('../lib/normalize.mjs').Sample[], identity:any}>}
 */
export async function fetchClaudeSamples({ observedAt, intervalSec }) {
  const { token, organizationUuid, errorCode } = readAccessToken();
  if (!token) {
    return {
      provider: 'claude',
      samples: errorSamples('claude', { observedAt, intervalSec, errorCode: errorCode ?? 'no_credentials' }),
      identity: null,
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  /** @type {any} */
  let resolvedIdentity = null;
  try {
    const currentTime = Date.now();
    const fingerprint = createHash('sha256').update(token).digest('hex');
    pruneProfileCache(currentTime);
    const cached = profileCache.get(fingerprint);
    if (cached) {
      cached.lastUsedAt = currentTime;
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': userAgent(),
      Accept: 'application/json',
    };
    const usagePromise = fetch(USAGE_URL, {
      method: 'GET',
      signal: ac.signal,
      headers,
    });
    const shouldFetchProfile = !cached || cached.profileRetryAt <= currentTime;
    const profilePromise = shouldFetchProfile
      ? fetch(PROFILE_URL, { method: 'GET', signal: ac.signal, headers })
        .then(async (response) => {
          if (!response.ok) {
            return null;
          }
          return claudeIdentityFromProfile(await response.json());
        })
        .catch(() => null)
      : Promise.resolve(null);
    const profile = await profilePromise;
    if (shouldFetchProfile) {
      const entry = cacheProfileResult(fingerprint, profile, cached, currentTime);
      if (!profile && !entry.authoritativeIdentity) {
        // local fallback は権威 cache に混ぜない。5 分ごとにファイルを読み直す。
        if (!entry.localFallbackIdentity || entry.localFallbackExpiresAt <= currentTime) {
          entry.localFallbackIdentity = readLocalFallback(organizationUuid);
          entry.localFallbackExpiresAt = currentTime + PROFILE_RETRY_TTL_MS;
          profileCache.set(fingerprint, entry);
        }
      }
    }
    const entry = profileCache.get(fingerprint) ?? cached;
    resolvedIdentity = entry?.authoritativeIdentity ?? entry?.localFallbackIdentity ?? null;
    const res = await usagePromise;
    if (!res.ok) {
      // 本文は読み捨て（トークンを含みうる情報は残さない）
      try { await res.text(); } catch { /* noop */ }
      return { provider: 'claude', samples: errorSamples('claude', { observedAt, intervalSec, errorCode: httpErrorCode(res.status) }), identity: resolvedIdentity };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { provider: 'claude', samples: errorSamples('claude', { observedAt, intervalSec, errorCode: 'parse' }), identity: resolvedIdentity };
    }
    return { provider: 'claude', samples: normalizeClaude(json, { observedAt, intervalSec }), identity: resolvedIdentity };
  } catch (e) {
    const code = e && e.name === 'AbortError' ? 'timeout' : 'network';
    return { provider: 'claude', samples: errorSamples('claude', { observedAt, intervalSec, errorCode: code }), identity: resolvedIdentity };
  } finally {
    clearTimeout(timer);
  }
}
