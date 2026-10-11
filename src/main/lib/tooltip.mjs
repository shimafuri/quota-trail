// トレイのツールチップ文字列（設計書 §8 / §15.6）。Electron に依存しない純粋関数（node:test 対象）。
// Windows のツールチップは約 127 文字で切れるため、同じ理由の 2 値は理由を 1 回だけ書く。

export const ERROR_LABEL = Object.freeze({
  no_credentials: '未ログイン',
  auth_expired_local: '認証期限切れ',
  auth_expiring: '期限間近・更新待ち',
  auth_expired: '認証エラー',
  window_absent: '枠なし',
  timeout: 'タイムアウト',
  network: '通信失敗',
  parse: '応答不正',
});

/** Claude の認証更新待ちを示す error code（§15.6） */
const CLAUDE_AUTH_CODES = new Set(['auth_expired_local', 'auth_expiring', 'auth_expired']);

/** 現在の資格情報が期限切れ/認証エラーの間に表示する ok 値の注記（§15.12。継続取得できるようには見せない） */
export const LAST_CONFIRMED_LABEL = '(最終確認値)';

/** 回復を断言しない案内文（§15.6） */
export const CLAUDE_AUTH_GUIDANCE = 'Claude: Claude Code を通常起動して認証を更新（回復しない場合は再ログイン）';

/**
 * @param {any} s
 * @returns {string}
 */
function reasonOf(s) {
  return ERROR_LABEL[s?.errorCode ?? ''] ?? s?.errorCode ?? 'error';
}

/**
 * @param {any} s
 * @returns {string}
 */
function fmt(s) {
  if (!s) return '--';
  if (s.status === 'ok' && s.usedPercent !== null && s.usedPercent !== undefined) return `${Math.round(s.usedPercent)}%`;
  return `-- (${reasonOf(s)})`;
}

/**
 * 1 プロバイダー分の 2 値行。両方が同じ理由の error なら理由を末尾に 1 回だけ書く。
 * @param {string} label
 * @param {any} five
 * @param {any} weekly
 */
function providerLine(label, five, weekly) {
  const bothError = five && weekly && five.status !== 'ok' && weekly.status !== 'ok'
    && (five.errorCode ?? null) === (weekly.errorCode ?? null);
  if (bothError) return `${label} 5h -- / W -- (${reasonOf(five)})`;
  return `${label} 5h ${fmt(five)} / W ${fmt(weekly)}`;
}

/**
 * @param {Record<string, any>} latest  系列キー → 最新 Sample
 * @param {{claudeAuth?: {state?:string, expiresAt?:number|null, withinLead?:boolean}|null, now?:number}} [options]
 *   claudeAuth: 認証監視の公開状態（期限前の案内に使う）
 * @returns {string}
 */
export function buildTooltip(latest, { claudeAuth = null, now = Date.now() } = {}) {
  const lines = ['quota-trail'];
  const monitorBlocked = claudeAuth?.state === 'expired' || claudeAuth?.state === 'rejected';
  let claudeLine = providerLine('Claude', latest['claude/5h'], latest['claude/weekly']);
  if (monitorBlocked && [latest['claude/5h'], latest['claude/weekly']].some((s) => s?.status === 'ok')) {
    // 期限超過後の確認送信で得た値や期限前の最後の値は「最終確認値」とし、認証更新の案内を併記する
    claudeLine += ` ${LAST_CONFIRMED_LABEL}`;
  }
  lines.push(claudeLine);
  lines.push(providerLine('Codex', latest['codex/5h'], latest['codex/weekly']));
  const times = Object.values(latest).filter(Boolean).map((s) => s.observedAt);
  if (times.length > 0) {
    const d = new Date(Math.max(...times));
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    lines.push(`最終取得 ${hh}:${mm}`);
  }
  const claudeCode = latest['claude/5h']?.status === 'error' ? latest['claude/5h'].errorCode : null;
  if (CLAUDE_AUTH_CODES.has(claudeCode ?? '') || monitorBlocked) {
    // 認証更新待ちのときは回復方法を案内する（必ず回復するとは断言しない）
    lines.push(CLAUDE_AUTH_GUIDANCE);
  } else if (claudeAuth?.withinLead && Number.isFinite(claudeAuth.expiresAt)) {
    const minutes = Math.max(0, Math.ceil((/** @type {number} */ (claudeAuth.expiresAt) - now) / 60_000));
    lines.push(`Claude: 認証期限まで約 ${minutes} 分`);
  }
  return lines.join('\n');
}
