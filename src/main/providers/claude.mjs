// Claude Code の使用率取得（設計書 §4.2 / §4.3 / §15.4）
// - 資格情報は毎回読み直す（Claude Code が refresh して書き換えるため）
// - 自発的な token refresh はしない。資格情報ファイルへは一切書き込まない
// - 全 HTTP（usage / profile）の直前にローカル期限判定を行い、期限切れ・30 秒以内・同一 token の 401 済みなら送らない
// - refreshToken は読み取った JSON から取り出さず、保持・コピー・ログ出力しない
// - トークン・fingerprint・config dir は絶対にログ・DB・公開 API へ出さない
// - 期限超過後の確認送信（§15.12）は明示設定 once のときだけ、usage を token ごとに最大 1 回。profile は送らない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../lib/exec.mjs';
import { normalizeClaude, errorSamples, httpErrorCode } from '../lib/normalize.mjs';
import { claudeIdentityFromProfile, claudeLocalFallback } from '../lib/account-identity.mjs';
import { classifyClaudeAuth, parseExpiresAt } from '../lib/claude-auth-state.mjs';
import { sleepInclusiveElapsedMs } from '../lib/elapsed-clock.mjs';
import { createExpiryProbeController } from './claude-expiry-probe.mjs';
import * as defaultLogger from '../logger.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'claude-code/2.1.263';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_SUCCESS_TTL_MS = 60 * 60_000;
const PROFILE_RETRY_TTL_MS = 5 * 60_000;
const PROFILE_CACHE_MAX_ENTRIES = 8;
const PROFILE_CACHE_MAX_IDLE_MS = 24 * 60 * 60_000;
/** 401 / 期限切れ latch の上限件数（メモリ内だけ。token 切替が頻繁でも増え続けない） */
const LATCH_MAX_ENTRIES = 16;

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
 * 資格情報スナップショット。token と key はメモリ内限定。
 * @typedef {Object} CredentialSnapshot
 * @property {string|null} token
 * @property {string|null} key            解決済み config dir と token の SHA-256 から作る内部キー
 * @property {number|null} expiresAt      有効な epoch ms のみ
 * @property {null|'missing_expiry'|'invalid_expiry'} expiryReason
 * @property {string|null} organizationUuid
 * @property {string} configDir
 * @property {string|null} errorCode      'no_credentials' | 'parse' | null
 */

/**
 * config dir と access token から内部キーを作る。
 * @param {string} configDir
 * @param {string} token
 * @returns {string}
 */
function credentialKey(configDir, token) {
  return createHash('sha256').update(configDir).update('\0').update(token).digest('hex');
}

/**
 * `.credentials.json` を 1 回だけ読み、スナップショットを返す。書き込みは一切しない。
 * refreshToken は取り出さない。
 * @param {{configDir?:string}} [options]
 * @returns {CredentialSnapshot}
 */
export function readCredentialSnapshot({ configDir = claudeConfigDir() } = {}) {
  const dir = path.resolve(configDir);
  const base = { token: null, key: null, expiresAt: null, expiryReason: null, organizationUuid: null, configDir: dir };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8');
  } catch {
    return { ...base, errorCode: 'no_credentials' };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...base, errorCode: 'parse' };
  }
  const oauth = json && typeof json === 'object' ? json.claudeAiOauth : null;
  const token = oauth && typeof oauth === 'object' ? oauth.accessToken : null;
  if (typeof token !== 'string' || token === '') {
    return { ...base, errorCode: 'no_credentials' };
  }
  const { expiresAt, reason } = parseExpiresAt(oauth.expiresAt);
  return {
    token,
    key: credentialKey(dir, token),
    expiresAt,
    expiryReason: reason,
    organizationUuid: typeof json.organizationUuid === 'string' ? json.organizationUuid : null,
    configDir: dir,
    errorCode: null,
  };
}

/**
 * accessToken を読む（互換ラッパ）。書き込みは一切しない。
 * @returns {{ token: string|null, organizationUuid?: string|null, errorCode: string|null }}
 */
export function readAccessToken() {
  const snap = readCredentialSnapshot();
  if (!snap.token) return { token: null, errorCode: snap.errorCode ?? 'no_credentials' };
  return { token: snap.token, organizationUuid: snap.organizationUuid, errorCode: null };
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
 * `.claude.json` からの local fallback identity（既定の reader）。
 * @param {string|null} credentialOrganizationUuid
 * @returns {any}
 */
function defaultReadLocalFallback(credentialOrganizationUuid) {
  try {
    const local = JSON.parse(fs.readFileSync(localFallbackPath(), 'utf8'));
    return claudeLocalFallback({ local, credentialOrganizationUuid });
  } catch {
    return null;
  }
}

/**
 * 上限付き Set（挿入順で古いものから捨てる）。
 * @param {Set<string>} set
 * @param {string} key
 */
function addBounded(set, key) {
  set.delete(key);
  set.add(key);
  while (set.size > LATCH_MAX_ENTRIES) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

/**
 * @typedef {Object} ClaudeBatchAuth
 * @property {string|null} key   内部キー（monitor との突合用。DB・ログ・API へ出さない）
 * @property {import('../lib/claude-auth-state.mjs').ClaudeAuthState} state
 * @property {string|null} errorCode
 * @property {'local'|'cached_401'|'http_401'|'http_ok'|'http_error'|null} source
 * @property {'normal'|'expiry_probe'|'local_gate'} requestKind
 *   通常取得 / 期限超過後の確認送信 / ローカル判定で送らなかった。Sample・DB・公開 DTO へは渡さない
 */

/**
 * Claude provider を作る。profile cache / 401 latch / in-flight profile をインスタンス内に持つ。
 * 起動 probe と scheduler は同じインスタンスを使う（profile 要求と latch を共有するため）。
 * @param {Object} [deps]
 * @param {() => CredentialSnapshot} [deps.readSnapshot]
 * @param {(url:string, init:any) => Promise<any>} [deps.fetch]
 * @param {() => number} [deps.now]
 * @param {(organizationUuid:string|null) => any} [deps.readLocalFallback]
 * @param {() => string} [deps.userAgent]
 * @param {() => any} [deps.readConfig]  claudeExpiredUsageProbe / pollIntervalSec。省略時は確認送信 off
 * @param {{info:Function, warn:Function}} [deps.logger]
 * @param {() => number|null} [deps.elapsedNow]  睡眠を含む OS 経過時計（ms）。取得不能なら null
 * @param {() => boolean} [deps.saveProbeOff]    確認送信の停止時に設定 off を保存する
 */
export function createClaudeProvider({
  readSnapshot = () => readCredentialSnapshot(),
  fetch: fetchImpl = (url, init) => globalThis.fetch(url, init),
  now = () => Date.now(),
  readLocalFallback = defaultReadLocalFallback,
  userAgent: getUserAgent = userAgent,
  readConfig = () => ({}),
  logger = defaultLogger,
  elapsedNow = sleepInclusiveElapsedMs,
  saveProbeOff = () => false,
} = {}) {
  const profileCache = new Map();
  /** usage 401 を受けた token の内部キー */
  const rejectedKeys = new Set();
  /** 一度 expired と判定した token の内部キー（時計の後退で送信を再開しない） */
  const expiredKeys = new Set();
  /** @type {Map<string, Promise<any>>} */
  const inFlightProfiles = new Map();
  /** 期限超過後の確認送信の予算台帳（§15.12）。expired latch の外側に置く */
  const probe = createExpiryProbeController({
    now, elapsedNow, readConfig, userAgent: getUserAgent, logger, saveProbeOff,
  });

  /**
   * 最終参照から 24 時間を超えた entry を捨て、最大 8 件の LRU に抑える。
   * @param {number} currentTime
   */
  function pruneProfileCache(currentTime) {
    for (const [key, entry] of profileCache) {
      if (currentTime - entry.lastUsedAt > PROFILE_CACHE_MAX_IDLE_MS) {
        profileCache.delete(key);
      }
    }
    if (profileCache.size <= PROFILE_CACHE_MAX_ENTRIES) {
      return;
    }
    const oldest = [...profileCache.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [key] of oldest.slice(0, profileCache.size - PROFILE_CACHE_MAX_ENTRIES)) {
      profileCache.delete(key);
    }
  }

  /**
   * 権威 profile の成功を cache entry に反映する。
   * @param {string} key
   * @param {any} identity
   * @param {any} previous
   * @param {number} currentTime
   * @returns {any}
   */
  function cacheProfileResult(key, identity, previous, currentTime) {
    const entry = {
      authoritativeIdentity: identity ?? previous?.authoritativeIdentity ?? null,
      authoritativeExpiresAt: identity ? currentTime + PROFILE_SUCCESS_TTL_MS : (previous?.authoritativeExpiresAt ?? 0),
      localFallbackIdentity: identity ? null : (previous?.localFallbackIdentity ?? null),
      localFallbackExpiresAt: identity ? 0 : (previous?.localFallbackExpiresAt ?? 0),
      profileRetryAt: currentTime + (identity ? PROFILE_SUCCESS_TTL_MS : PROFILE_RETRY_TTL_MS),
      lastUsedAt: currentTime,
    };
    profileCache.set(key, entry);
    pruneProfileCache(currentTime);
    return entry;
  }

  /**
   * スナップショットを判定する。expired と判定した token は latch する。
   * @param {CredentialSnapshot} snap
   * @param {number} [at]
   * @returns {import('../lib/claude-auth-state.mjs').ClaudeAuthClassification}
   */
  function classify(snap, at = now()) {
    const key = snap?.key ?? null;
    const result = classifyClaudeAuth({
      now: at,
      hasToken: Boolean(snap?.token && key),
      credentialError: snap?.errorCode ?? null,
      expiresAt: snap?.expiresAt ?? null,
      // 台帳の既知 401 も cached_401 として扱う（16 件 latch の除去と連動して捨てない）
      rejected: key !== null && (rejectedKeys.has(key) || probe.isRejected(snap?.token)),
      expiredLatched: key !== null && expiredKeys.has(key),
    });
    if (result.state === 'expired' && key !== null) addBounded(expiredKeys, key);
    // 確認送信の適格性も同じ snapshot で再確認する（HTTP なし・予算消費なし）
    probe.observe(snap, at, result);
    return result;
  }

  /**
   * 同じ token に既に結び付いた権威 identity（stale でも可）。ローカル判定中の帰属に使う。
   * `.claude.json` の現 account を推測帰属しない。
   * @param {string|null} key
   * @param {number} currentTime
   */
  function boundIdentity(key, currentTime) {
    if (!key) return null;
    pruneProfileCache(currentTime);
    const entry = profileCache.get(key);
    if (!entry) return null;
    entry.lastUsedAt = currentTime;
    return entry.authoritativeIdentity ?? null;
  }

  function headersFor(token) {
    return {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': getUserAgent(),
      Accept: 'application/json',
    };
  }

  /**
   * profile を要求する（同じキーの要求が進行中ならそれを共有し、二重要求しない）。
   * 結果は Promise 内で cache に反映する。呼び出し側は gate を通した後にだけ呼ぶ。
   * @param {CredentialSnapshot} snap
   * @param {number} currentTime
   * @returns {Promise<void>}
   */
  function ensureProfile(snap, currentTime) {
    const key = /** @type {string} */ (snap.key);
    const pending = inFlightProfiles.get(key);
    if (pending) return pending;
    const cached = profileCache.get(key);
    if (cached && cached.profileRetryAt > currentTime) return Promise.resolve();
    const promise = (async () => {
      let identity = null;
      try {
        const response = await fetchImpl(PROFILE_URL, {
          method: 'GET',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: headersFor(/** @type {string} */ (snap.token)),
        });
        if (response && response.ok) {
          identity = claudeIdentityFromProfile(await response.json());
        } else {
          // 本文は読み捨て（認証情報を含みうる情報は残さない）
          try { await response?.text?.(); } catch { /* noop */ }
        }
      } catch {
        identity = null;
      }
      const entry = cacheProfileResult(key, identity, profileCache.get(key) ?? cached, currentTime);
      if (!identity && !entry.authoritativeIdentity) {
        // local fallback は権威 cache に混ぜない。5 分ごとにファイルを読み直す。
        if (!entry.localFallbackIdentity || entry.localFallbackExpiresAt <= currentTime) {
          entry.localFallbackIdentity = readLocalFallback(snap.organizationUuid);
          entry.localFallbackExpiresAt = currentTime + PROFILE_RETRY_TTL_MS;
          profileCache.set(key, entry);
        }
      }
    })().finally(() => {
      inFlightProfiles.delete(key);
    });
    inFlightProfiles.set(key, promise);
    return promise;
  }

  /** 有効 token の通常取得で使う identity（権威 → local fallback） */
  function currentIdentity(key) {
    const entry = profileCache.get(key);
    return entry?.authoritativeIdentity ?? entry?.localFallbackIdentity ?? null;
  }

  /**
   * Claude の使用率を取得して Sample[]（5h / weekly / weekly-fable の 3 行）を返す。例外は投げない。
   * @param {{observedAt:number, intervalSec:number}} ctx
   * @returns {Promise<{provider:'claude', samples:import('../lib/normalize.mjs').Sample[], identity:any, auth:ClaudeBatchAuth}>}
   */
  async function fetchSamples({ observedAt, intervalSec }) {
    const snap = readSnapshot();
    const currentTime = now();
    const gate = classify(snap, currentTime);
    const key = snap?.key ?? null;
    if (!snap?.token || !key) {
      return {
        provider: 'claude',
        samples: errorSamples('claude', { observedAt, intervalSec, errorCode: gate.errorCode ?? 'no_credentials' }),
        identity: null,
        auth: { key: null, state: gate.state, errorCode: gate.errorCode, source: 'local', requestKind: 'local_gate' },
      };
    }
    if (gate.blocked) {
      if (gate.state === 'expired') {
        // §15.12: 割当段の窓内なら usage だけを 1 回確認する（cached_401 は classify が先に返している）
        const ticket = probe.reserve(snap, currentTime, intervalSec);
        if (ticket) return runExpiryProbe(snap, key, ticket, { observedAt, intervalSec });
      }
      return {
        provider: 'claude',
        samples: errorSamples('claude', { observedAt, intervalSec, errorCode: /** @type {string} */ (gate.errorCode) }),
        identity: boundIdentity(key, currentTime),
        auth: { key, state: gate.state, errorCode: gate.errorCode, source: gate.source, requestKind: 'local_gate' },
      };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    /** @type {any} */
    let resolvedIdentity = null;
    /** @type {any} */
    let usageTicket = null;
    try {
      pruneProfileCache(currentTime);
      const cached = profileCache.get(key);
      if (cached) {
        cached.lastUsedAt = currentTime;
      }
      usageTicket = probe.beginNormalUsage(snap, currentTime, intervalSec);
      const usagePromise = fetchImpl(USAGE_URL, {
        method: 'GET',
        signal: ac.signal,
        headers: headersFor(snap.token),
      });
      // 未処理 rejection を避ける（結果は下で await する）
      usagePromise.catch(() => {});
      await ensureProfile(snap, currentTime);
      resolvedIdentity = currentIdentity(key);
      const res = await usagePromise;
      if (!res.ok) {
        // 本文は読み捨て（トークンを含みうる情報は残さない）
        try { await res.text(); } catch { /* noop */ }
        if (res.status === 401) {
          addBounded(rejectedKeys, key);
          probe.noteUsage401(snap.token);
        }
        probe.finishNormalUsage(usageTicket, { status: res.status ?? null, httpOk: false, okWindowCount: 0 });
        const errorCode = httpErrorCode(res.status);
        return {
          provider: 'claude',
          samples: errorSamples('claude', { observedAt, intervalSec, errorCode }),
          identity: resolvedIdentity,
          auth: res.status === 401
            ? { key, state: 'rejected', errorCode, source: 'http_401', requestKind: 'normal' }
            : { key, state: gate.state, errorCode, source: 'http_error', requestKind: 'normal' },
        };
      }
      let json;
      try {
        json = await res.json();
      } catch {
        probe.finishNormalUsage(usageTicket, { status: res.status ?? 200, httpOk: true, okWindowCount: 0 });
        return {
          provider: 'claude',
          samples: errorSamples('claude', { observedAt, intervalSec, errorCode: 'parse' }),
          identity: resolvedIdentity,
          auth: { key, state: gate.state, errorCode: null, source: 'http_ok', requestKind: 'normal' },
        };
      }
      const samples = normalizeClaude(json, { observedAt, intervalSec });
      probe.finishNormalUsage(usageTicket, {
        status: res.status ?? 200, httpOk: true, okWindowCount: samples.filter((s) => s.status === 'ok').length,
      });
      return {
        provider: 'claude',
        samples,
        identity: resolvedIdentity,
        auth: { key, state: gate.state, errorCode: null, source: 'http_ok', requestKind: 'normal' },
      };
    } catch (e) {
      const code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      probe.finishNormalUsage(usageTicket, { status: null, httpOk: false, okWindowCount: 0 });
      return {
        provider: 'claude',
        samples: errorSamples('claude', { observedAt, intervalSec, errorCode: code }),
        identity: resolvedIdentity,
        auth: { key, state: gate.state, errorCode: code, source: 'http_error', requestKind: 'normal' },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 期限超過後の確認送信（§15.12）。予算は reserve() で消費済み。usage だけを通常と同じ URL・ヘッダ・
   * 15 秒 timeout で 1 回送る。profile 要求・再試行・`.claude.json` fallback はしない。
   * 帰属は同じ token に結び付いた権威 profile cache（stale 可）だけ。無ければ unknown。
   * 200 でもローカル期限・expired latch・通知済み状態は変えず、次 tick からは auth_expired_local に戻る。
   * @param {CredentialSnapshot} snap
   * @param {string} key
   * @param {any} ticket
   * @param {{observedAt:number, intervalSec:number}} ctx
   */
  async function runExpiryProbe(snap, key, ticket, { observedAt, intervalSec }) {
    const identity = boundIdentity(key, ticket.requestStartedAt);
    probe.start(ticket, observedAt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    /** @type {number|null} */
    let httpStatus = null;
    /** @type {'http_200'|'http_401'|'http_429'|'http_other'|'network'|'timeout'} */
    let outcome = 'network';
    /** @type {string|null} */
    let errorCode = null;
    /** @type {boolean|null} */
    let parseOk = null;
    let okWindowCount = 0;
    /** @type {import('../lib/normalize.mjs').Sample[]} */
    let samples;
    /** @type {ClaudeBatchAuth} */
    let auth;
    try {
      const res = await fetchImpl(USAGE_URL, {
        method: 'GET',
        signal: ac.signal,
        headers: headersFor(/** @type {string} */ (snap.token)),
      });
      httpStatus = typeof res?.status === 'number' ? res.status : (res?.ok ? 200 : null);
      if (!res.ok) {
        // 本文は読み捨て（トークンを含みうる情報は残さない）
        try { await res.text(); } catch { /* noop */ }
        errorCode = httpErrorCode(res.status);
        outcome = res.status === 401 ? 'http_401' : res.status === 429 ? 'http_429' : 'http_other';
        samples = errorSamples('claude', { observedAt, intervalSec, errorCode });
        if (res.status === 401) {
          addBounded(rejectedKeys, key);
          probe.noteUsage401(snap.token);
          auth = { key, state: 'rejected', errorCode, source: 'http_401', requestKind: 'expiry_probe' };
        } else {
          auth = { key, state: 'expired', errorCode, source: 'http_error', requestKind: 'expiry_probe' };
        }
      } else {
        // HTTP 200 を確認した試行は、本文の失敗でも「受付あり・有用サンプルなし」として数える
        outcome = 'http_200';
        let json;
        try {
          json = await res.json();
          parseOk = true;
        } catch (e) {
          const aborted = e && e.name === 'AbortError';
          parseOk = aborted ? null : false;
          errorCode = aborted ? 'timeout' : 'parse';
        }
        if (parseOk) {
          samples = normalizeClaude(json, { observedAt, intervalSec });
          okWindowCount = samples.filter((s) => s.status === 'ok').length;
          errorCode = okWindowCount > 0 ? null : (samples.find((s) => s.status !== 'ok')?.errorCode ?? null);
        } else {
          samples = errorSamples('claude', { observedAt, intervalSec, errorCode: /** @type {string} */ (errorCode) });
        }
        auth = { key, state: 'expired', errorCode: null, source: 'http_ok', requestKind: 'expiry_probe' };
      }
    } catch (e) {
      const code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      outcome = code;
      errorCode = code;
      samples = errorSamples('claude', { observedAt, intervalSec, errorCode: code });
      auth = { key, state: 'expired', errorCode: code, source: 'http_error', requestKind: 'expiry_probe' };
    } finally {
      clearTimeout(timer);
    }
    probe.finish(ticket, {
      outcome, httpStatus, errorCode, durationMs: Math.max(0, now() - ticket.requestStartedAt), parseOk, okWindowCount,
    });
    return { provider: 'claude', samples, identity, auth };
  }

  /**
   * 電源イベント（§15.12）。suspend/resume を確認送信の予約に記録し、最新 snapshot で gate を再評価する。
   * index.mjs は resume の即時 tick より先にこれを呼ぶ。unlock は睡眠とみなさない。例外は投げない。
   * @param {'suspend'|'resume'} kind
   */
  function notePowerEvent(kind) {
    try {
      const at = now();
      const snap = readSnapshot();
      probe.notePowerEvent(kind);
      classify(snap, at);
    } catch { /* 監視の例外で電源イベント処理を止めない */ }
  }

  /**
   * 起動時の identity probe（§15.4）。gate を通し、usage は取得せず profile/cache だけを参照する。
   * 進行中の profile は通常 tick と共有する。例外は投げない。
   * @returns {Promise<any|null>}
   */
  async function resolveInitialIdentity() {
    try {
      const snap = readSnapshot();
      const currentTime = now();
      const gate = classify(snap, currentTime);
      const key = snap?.key ?? null;
      if (!snap?.token || !key) return null;
      if (gate.blocked) return boundIdentity(key, currentTime);
      pruneProfileCache(currentTime);
      const cached = profileCache.get(key);
      if (cached) cached.lastUsedAt = currentTime;
      await ensureProfile(snap, currentTime);
      return currentIdentity(key);
    } catch {
      return null;
    }
  }

  return {
    fetchSamples,
    resolveInitialIdentity,
    classify,
    notePowerEvent,
    /** テスト・診断用: 確認送信の集計（秘密は含めない） */
    expiryProbeStatus: () => probe.status(),
    /** テスト・診断用: 進行中 profile の件数 */
    inFlightProfileCount: () => inFlightProfiles.size,
  };
}

/** 既存 export と index.mjs が共有する既定インスタンス */
export const defaultClaudeProvider = createClaudeProvider();

/**
 * Claude の使用率を取得する（既定インスタンスの互換ラッパ）。
 * @param {{observedAt:number, intervalSec:number}} ctx
 */
export function fetchClaudeSamples(ctx) {
  return defaultClaudeProvider.fetchSamples(ctx);
}

/** 起動時の Claude identity probe（既定インスタンスの互換ラッパ） */
export function resolveInitialClaudeIdentity() {
  return defaultClaudeProvider.resolveInitialIdentity();
}
