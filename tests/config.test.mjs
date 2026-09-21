import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeConfig, DEFAULTS, MIN_POLL_INTERVAL_SEC, initConfig, readConfig, writeConfig } from '../src/main/config.mjs';

test('既定値は設計書どおり', () => {
  assert.deepEqual({ ...DEFAULTS }, { pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiers: false });
});

test('sanitizeConfig は壊れた値を既定に戻し、間隔を最小 30 秒に切り上げる', () => {
  assert.deepEqual(sanitizeConfig({}), { pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiers: false });
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

test('initConfig は無ければ既定で生成し、writeConfig で更新できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-cfg-'));
  try {
    const file = initConfig(dir);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(readConfig(), { pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiers: false });

    writeConfig({ port: 47850 });
    assert.equal(readConfig().port, 47850);
    assert.equal(readConfig().pollIntervalSec, 180);

    // 壊れた JSON でも既定値で続行する
    fs.writeFileSync(file, '{ broken', 'utf8');
    assert.deepEqual(readConfig(), { pollIntervalSec: 180, port: 47811, retentionDays: null, revealAccountIdentifiers: false });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
