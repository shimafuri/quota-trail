import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTooltip, CLAUDE_AUTH_GUIDANCE, LAST_CONFIRMED_LABEL } from '../src/main/lib/tooltip.mjs';

const AT = new Date(2026, 9, 2, 3, 24).getTime();

/** @param {string} provider @param {string} window @param {Partial<any>} [over] */
function sample(provider, window, over = {}) {
  return { observedAt: AT, provider, window, usedPercent: 40, resetsAt: null, status: 'ok', errorCode: null, intervalSec: 180, ...over };
}

/** @param {string} code */
function claudeError(code) {
  const e = { status: 'error', usedPercent: null, errorCode: code };
  return {
    'claude/5h': sample('claude', '5h', e),
    'claude/weekly': sample('claude', 'weekly', e),
    'claude/weekly-fable': sample('claude', 'weekly-fable', e),
    'codex/5h': sample('codex', '5h', { usedPercent: 52 }),
    'codex/weekly': sample('codex', 'weekly', { usedPercent: 59 }),
  };
}

test('通常時は現行の 2 値表示を維持する', () => {
  const tip = buildTooltip({
    'claude/5h': sample('claude', '5h'),
    'claude/weekly': sample('claude', 'weekly', { usedPercent: 36 }),
    'codex/5h': sample('codex', '5h', { usedPercent: 52 }),
    'codex/weekly': sample('codex', 'weekly', { usedPercent: 59 }),
  });
  assert.equal(tip, 'quota-trail\nClaude 5h 40% / W 36%\nCodex 5h 52% / W 59%\n最終取得 03:24');
});

test('認証理由: ローカル期限切れ・期限間近・認証エラーを区別し、回復を断言しない案内を出す', () => {
  const expired = buildTooltip(claudeError('auth_expired_local'));
  assert.match(expired, /Claude 5h -- \/ W -- \(認証期限切れ\)/);
  assert.ok(expired.includes(CLAUDE_AUTH_GUIDANCE));
  assert.match(buildTooltip(claudeError('auth_expiring')), /\(期限間近・更新待ち\)/);
  const rejected = buildTooltip(claudeError('auth_expired'));
  assert.match(rejected, /\(認証エラー\)/);
  assert.ok(rejected.includes('回復しない場合は再ログイン'));
  assert.equal(/一度起動すると回復します/.test(rejected), false);
  // Windows のツールチップ上限（約 127 文字）に収まる
  for (const code of ['auth_expired_local', 'auth_expiring', 'auth_expired']) {
    assert.ok(buildTooltip(claudeError(code)).length <= 127, code);
  }
  // 429 や通信失敗には認証の案内を出さない
  assert.equal(buildTooltip(claudeError('http_429')).includes(CLAUDE_AUTH_GUIDANCE), false);
});

test('監視状態: 期限前は残り分数、監視が期限切れを検知していれば tick 前でも案内する', () => {
  const latest = {
    'claude/5h': sample('claude', '5h'),
    'claude/weekly': sample('claude', 'weekly'),
    'codex/5h': sample('codex', '5h'),
    'codex/weekly': sample('codex', 'weekly'),
  };
  const lead = buildTooltip(latest, { claudeAuth: { state: 'valid', withinLead: true, expiresAt: AT + 9 * 60_000 + 1 }, now: AT });
  assert.match(lead, /Claude: 認証期限まで約 10 分/);
  const blocked = buildTooltip(latest, { claudeAuth: { state: 'expired', withinLead: false, expiresAt: AT - 1 }, now: AT });
  assert.ok(blocked.includes(CLAUDE_AUTH_GUIDANCE));
});

test('期限超過中の正常値は「最終確認値」として認証更新の案内を併記し、回復と誤表示しない（§15.12）', () => {
  const latest = {
    'claude/5h': sample('claude', '5h', { usedPercent: 41 }),
    'claude/weekly': sample('claude', 'weekly', { usedPercent: 37 }),
    'claude/weekly-fable': sample('claude', 'weekly-fable', { status: 'error', usedPercent: null, errorCode: 'window_absent' }),
    'codex/5h': sample('codex', '5h', { usedPercent: 52 }),
    'codex/weekly': sample('codex', 'weekly', { usedPercent: 59 }),
  };
  for (const state of ['expired', 'rejected']) {
    const tip = buildTooltip(latest, { claudeAuth: { state, withinLead: false, expiresAt: AT - 1 }, now: AT });
    assert.ok(tip.includes(`Claude 5h 41% / W 37% ${LAST_CONFIRMED_LABEL}`), state);
    assert.ok(tip.includes(CLAUDE_AUTH_GUIDANCE), state);
    assert.ok(tip.length <= 127, `${state}: ${tip.length}`);
  }
  // 通常の有効 token では注記を付けない（従来どおり）
  const valid = buildTooltip(latest, { claudeAuth: { state: 'valid', withinLead: false, expiresAt: AT + 3_600_000 }, now: AT });
  assert.equal(valid, 'quota-trail\nClaude 5h 41% / W 37%\nCodex 5h 52% / W 59%\n最終取得 03:24');
  // 次 tick の local error では従来の認証理由表示に戻る
  const back = buildTooltip(claudeError('auth_expired_local'), { claudeAuth: { state: 'expired', withinLead: false, expiresAt: AT - 1 }, now: AT });
  assert.equal(back.includes(LAST_CONFIRMED_LABEL), false);
  assert.match(back, /\(認証期限切れ\)/);
});
