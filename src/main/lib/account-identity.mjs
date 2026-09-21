// アカウント identity の構文処理（設計書 §2 / §3）。
// このモジュールは I/O を持たず、読み込み済みの資格情報・profile から
// 最小限の正規化済み identity だけを返す。token や JWT は返さない。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUID を trim・小文字化して検証する。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeUuid(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const out = value.trim().toLowerCase();
  return UUID.test(out) ? out : null;
}

/**
 * メールアドレスを trim・小文字化して最低限の形式を検証する。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const out = value.trim().toLowerCase();
  // 完全なメールアドレス検証ではなく、保存可否のための控えめな形式確認である。
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : null;
}

/**
 * identity 候補を正規化する。
 * @param {{provider:string, uuid?:unknown, email?:unknown, source:string, assurance?:string}} input
 * @returns {{provider:string, uuid:string|null, email:string|null, source:string, assurance:string}|null}
 */
export function identity({ provider, uuid = null, email = null, source, assurance = 'authoritative' }) {
  const normalizedUuid = normalizeUuid(uuid);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedUuid && !normalizedEmail) return null;
  return { provider, uuid: normalizedUuid, email: normalizedEmail, source, assurance };
}

/**
 * ローカル auth ファイル由来の未検証 JWT payload を decode する。
 * @param {unknown} token
 * @returns {Record<string, unknown>|null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return null;
  }
  const part = token.split('.')[1];
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) {
    return null;
  }
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Codex auth.json から usage と同じ資格情報の identity を決定する。
 * @param {unknown} auth
 * @returns {{identity: ReturnType<typeof identity>, accountId:string|null, claimMismatch:boolean}}
 */
export function codexIdentityFromAuth(auth) {
  const tokens = auth && typeof auth === 'object' ? auth.tokens : null;
  const accountId = normalizeUuid(tokens?.account_id);
  const payload = decodeJwtPayload(tokens?.id_token);
  // id_token の OpenAI claim は namespace キー配下のオブジェクトである。
  const authClaim = payload?.['https://api.openai.com/auth'];
  const claim = normalizeUuid(
    authClaim && typeof authClaim === 'object'
      ? authClaim.chatgpt_account_id
      : null,
  );
  const email = normalizeEmail(payload?.email);
  // account_id は実際に request header へ送る値なので優先する。
  return {
    identity: identity({ provider: 'codex', uuid: accountId ?? claim, email, source: 'codex_auth', assurance: 'authoritative' }),
    accountId: accountId ?? claim,
    claimMismatch: Boolean(accountId && claim && accountId !== claim),
  };
}

/**
 * Claude profile 応答から権威的 identity を取り出す。
 * @param {unknown} profile
 * @returns {ReturnType<typeof identity>}
 */
export function claudeIdentityFromProfile(profile) {
  const account = profile && typeof profile === 'object' ? profile.account : null;
  return identity({ provider: 'claude', uuid: account?.uuid, email: account?.email, source: 'claude_profile', assurance: 'authoritative' });
}

/**
 * organization snapshot が矛盾しない場合だけローカル fallback を返す。
 * @param {{local:unknown, credentialOrganizationUuid?:unknown}} input
 * @returns {ReturnType<typeof identity>}
 */
export function claudeLocalFallback({ local, credentialOrganizationUuid = null }) {
  const account = local && typeof local === 'object' ? local.oauthAccount : null;
  const credentialOrg = normalizeUuid(credentialOrganizationUuid);
  const localOrg = normalizeUuid(account?.organizationUuid);
  if (credentialOrg && localOrg && credentialOrg !== localOrg) {
    return null;
  }
  return identity({
    provider: 'claude',
    uuid: account?.accountUuid,
    email: account?.emailAddress,
    source: 'claude_local_fallback',
    assurance: 'local_fallback',
  });
}
