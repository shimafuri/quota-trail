import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeConfig, DEFAULTS, MIN_POLL_INTERVAL_SEC, LEGACY_REVEAL_KEY, needsRevealSettingMigration, initConfig, readConfig, writeConfig, saveClaudeExpiredUsageProbeOff } from '../src/main/config.mjs';

const DEFAULT_CONFIG = {
  pollIntervalSec: 180,
  port: 47811,
  retentionDays: null,
  revealAccountIdentifiersInAccountMenu: true,
  claudeAuthNotifications: true,
  claudeAuthNoticeLeadSec: 600,
  claudeExpiredUsageProbe: 'off',
};

/** テスト用の一時 userData ディレクトリを作る */
function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-cfg-'));
  try {
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

test('既定値は設計書どおりで、新設定の既定は true', () => {
  assert.deepEqual({ ...DEFAULTS }, DEFAULT_CONFIG);
  assert.equal(DEFAULTS.revealAccountIdentifiersInAccountMenu, true);
});

test('sanitizeConfig は壊れた値を既定に戻し、間隔を最小 30 秒に切り上げる', () => {
  assert.deepEqual(sanitizeConfig({}), DEFAULT_CONFIG);
  assert.equal(sanitizeConfig({ pollIntervalSec: 5 }).pollIntervalSec, MIN_POLL_INTERVAL_SEC);
  assert.equal(sanitizeConfig({ pollIntervalSec: 'abc' }).pollIntervalSec, 180);
  assert.equal(sanitizeConfig({ pollIntervalSec: 600 }).pollIntervalSec, 600);
  assert.equal(sanitizeConfig({ port: 0 }).port, 47811);
  assert.equal(sanitizeConfig({ port: 70000 }).port, 47811);
  assert.equal(sanitizeConfig({ port: 47812 }).port, 47812);
  assert.equal(sanitizeConfig({ retentionDays: 30 }).retentionDays, 30);
  assert.equal(sanitizeConfig({ retentionDays: -1 }).retentionDays, null);
  assert.equal(sanitizeConfig(null).pollIntervalSec, 180);
});

test('sanitizeConfig は旧設定を除去し、明示的な false だけを維持する', () => {
  assert.equal(sanitizeConfig({ [LEGACY_REVEAL_KEY]: false }).revealAccountIdentifiersInAccountMenu, true);
  assert.equal(sanitizeConfig({ [LEGACY_REVEAL_KEY]: true }).revealAccountIdentifiersInAccountMenu, true);
  assert.equal(sanitizeConfig({ revealAccountIdentifiersInAccountMenu: false }).revealAccountIdentifiersInAccountMenu, false);
  assert.equal(sanitizeConfig({ revealAccountIdentifiersInAccountMenu: true }).revealAccountIdentifiersInAccountMenu, true);
  // 新設定が明示 false でも旧設定は残さない。
  const normalized = sanitizeConfig({ revealAccountIdentifiersInAccountMenu: false, [LEGACY_REVEAL_KEY]: true });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, LEGACY_REVEAL_KEY), false);
  assert.deepEqual(Object.keys(normalized).sort(), ['claudeAuthNoticeLeadSec', 'claudeAuthNotifications', 'claudeExpiredUsageProbe', 'pollIntervalSec', 'port', 'retentionDays', 'revealAccountIdentifiersInAccountMenu']);
});

test('needsRevealSettingMigration は新設定が無い config と旧キーが残る config だけを対象にする', () => {
  assert.equal(needsRevealSettingMigration({ [LEGACY_REVEAL_KEY]: false }), true);
  assert.equal(needsRevealSettingMigration({}), true);
  assert.equal(needsRevealSettingMigration(null), true);
  assert.equal(needsRevealSettingMigration({ revealAccountIdentifiersInAccountMenu: false, [LEGACY_REVEAL_KEY]: false }), true);
  assert.equal(needsRevealSettingMigration({ revealAccountIdentifiersInAccountMenu: false }), false);
  assert.equal(needsRevealSettingMigration({ revealAccountIdentifiersInAccountMenu: true }), false);
});

test('initConfig は無ければ既定で生成し、writeConfig で更新できる', () => {
  withConfigDir((dir) => {
    const file = initConfig(dir);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(readConfig(), DEFAULT_CONFIG);

    writeConfig({ port: 47850 });
    assert.equal(readConfig().port, 47850);
    assert.equal(readConfig().pollIntervalSec, 180);

    // 壊れた JSON でも既定値で続行する
    fs.writeFileSync(file, '{ broken', 'utf8');
    assert.deepEqual(readConfig(), DEFAULT_CONFIG);
  });
});

test('旧 config.json は一回の migration で新設定 true へ書き戻され、再実行は冪等', () => {
  withConfigDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify({ pollIntervalSec: 240, port: 47820, retentionDays: 30, [LEGACY_REVEAL_KEY]: false }, null, 2)}\n`, 'utf8');
    initConfig(dir);
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(migrated, {
      pollIntervalSec: 240,
      port: 47820,
      retentionDays: 30,
      revealAccountIdentifiersInAccountMenu: true,
      claudeAuthNotifications: true,
      claudeAuthNoticeLeadSec: 600,
      claudeExpiredUsageProbe: 'off',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(migrated, LEGACY_REVEAL_KEY), false);

    const afterFirst = fs.readFileSync(file, 'utf8');
    initConfig(dir);
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst);
    assert.equal(readConfig().revealAccountIdentifiersInAccountMenu, true);
  });
});

test('新形式で明示的に false にした config は migration で書き換えられない', () => {
  withConfigDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify({ pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiersInAccountMenu: false }, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    initConfig(dir);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(readConfig().revealAccountIdentifiersInAccountMenu, false);
  });
});

test('Claude 認証の案内設定: boolean 以外は true、案内秒は有限数を整数化して 300–3600 に clamp（設計書 §15.6）', () => {
  assert.equal(sanitizeConfig({ claudeAuthNotifications: false }).claudeAuthNotifications, false);
  assert.equal(sanitizeConfig({ claudeAuthNotifications: true }).claudeAuthNotifications, true);
  for (const bad of ['false', 0, null, undefined, {}]) {
    assert.equal(sanitizeConfig({ claudeAuthNotifications: bad }).claudeAuthNotifications, true, `値 ${String(bad)}`);
  }
  assert.equal(sanitizeConfig({ claudeAuthNoticeLeadSec: 900 }).claudeAuthNoticeLeadSec, 900);
  assert.equal(sanitizeConfig({ claudeAuthNoticeLeadSec: 900.6 }).claudeAuthNoticeLeadSec, 901);
  assert.equal(sanitizeConfig({ claudeAuthNoticeLeadSec: 10 }).claudeAuthNoticeLeadSec, 300);
  assert.equal(sanitizeConfig({ claudeAuthNoticeLeadSec: 99999 }).claudeAuthNoticeLeadSec, 3600);
  for (const bad of ['900', NaN, Infinity, null, undefined, true]) {
    assert.equal(sanitizeConfig({ claudeAuthNoticeLeadSec: bad }).claudeAuthNoticeLeadSec, 600, `値 ${String(bad)}`);
  }
  // 段階 B の claudeAuthRecovery は本変更では扱わない（未知キーは落とす）
  assert.equal(Object.prototype.hasOwnProperty.call(sanitizeConfig({ claudeAuthRecovery: 'verified-cli' }), 'claudeAuthRecovery'), false);
});

test('新しい認証設定が無い旧 config も既定値で読め、ポーリング設定は変わらない', () => {
  withConfigDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify({ pollIntervalSec: 240, port: 47811, retentionDays: null, revealAccountIdentifiersInAccountMenu: true }, null, 2)}\n`, 'utf8');
    initConfig(dir);
    const cfg = readConfig();
    assert.equal(cfg.pollIntervalSec, 240);
    assert.equal(cfg.claudeAuthNotifications, true);
    assert.equal(cfg.claudeAuthNoticeLeadSec, 600);
  });
});

test('期限超過後の確認送信設定: once/off だけを受け付け、欠落・不正値は off（設計書 §15.6 / §15.12）', () => {
  assert.equal(DEFAULTS.claudeExpiredUsageProbe, 'off');
  assert.equal(sanitizeConfig({ claudeExpiredUsageProbe: 'once' }).claudeExpiredUsageProbe, 'once');
  assert.equal(sanitizeConfig({ claudeExpiredUsageProbe: 'off' }).claudeExpiredUsageProbe, 'off');
  for (const bad of [undefined, null, true, 1, 'ONCE', 'on', 'twice', { mode: 'once' }]) {
    assert.equal(sanitizeConfig({ claudeExpiredUsageProbe: bad }).claudeExpiredUsageProbe, 'off', `値 ${String(bad)}`);
  }
});

test('確認送信の once/off を読み書きでき、停止時の off 保存は他の設定を保ち、失敗を返す', () => {
  withConfigDir((dir) => {
    const file = initConfig(dir);
    assert.equal(readConfig().claudeExpiredUsageProbe, 'off');
    writeConfig({ claudeExpiredUsageProbe: 'once', pollIntervalSec: 240 });
    assert.equal(readConfig().claudeExpiredUsageProbe, 'once');

    assert.equal(saveClaudeExpiredUsageProbeOff(), true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.claudeExpiredUsageProbe, 'off');
    assert.equal(saved.pollIntervalSec, 240);

    // 書けない場合（パスがディレクトリ）は false を返す。呼び出し側はメモリ上の停止を解除しない
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.equal(saveClaudeExpiredUsageProbeOff(), false);
  });
});
