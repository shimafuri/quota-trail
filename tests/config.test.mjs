import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeConfig, DEFAULTS, MIN_POLL_INTERVAL_SEC, LEGACY_REVEAL_KEY, needsRevealSettingMigration, initConfig, readConfig, writeConfig } from '../src/main/config.mjs';

const DEFAULT_CONFIG = { pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiersInAccountMenu: true };

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
  assert.deepEqual(Object.keys(normalized).sort(), ['pollIntervalSec', 'port', 'retentionDays', 'revealAccountIdentifiersInAccountMenu']);
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
    assert.deepEqual(migrated, { pollIntervalSec: 240, port: 47820, retentionDays: 30, revealAccountIdentifiersInAccountMenu: true });
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
