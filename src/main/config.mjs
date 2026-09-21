// 設定の読み書き（設計書 §9）: userData/config.json
import fs from 'node:fs';
import path from 'node:path';
import * as logger from './logger.mjs';

/**
 * @typedef {Object} Config
 * @property {number} pollIntervalSec  取得間隔（秒）。既定 180、最小 30
 * @property {number} port             HTTP サーバのポート。既定 47811
 * @property {number|null} retentionDays  保持日数。null = 無制限
 * @property {boolean} revealAccountIdentifiers 実 ID の明示表示を許可するか
 */

/** @type {Config} */
export const DEFAULTS = Object.freeze({
  pollIntervalSec: 180,
  port: 47811,
  retentionDays: null,
  revealAccountIdentifiers: false,
});

export const MIN_POLL_INTERVAL_SEC = 30;

/** @type {string|null} */
let configFile = null;

/**
 * 設定ファイルの場所を決める。無ければ既定値で生成する。
 * @param {string} userDataDir
 * @returns {string} config.json のパス
 */
export function initConfig(userDataDir) {
  configFile = path.join(userDataDir, 'config.json');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch { /* noop */ }
  if (!fs.existsSync(configFile)) {
    writeConfig(DEFAULTS);
  }
  return configFile;
}

/** 現在の config.json のパス */
export function configPath() {
  return configFile;
}

/**
 * 値の健全化。壊れた値は既定に戻す。
 * @param {any} raw
 * @returns {Config}
 */
export function sanitizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let pollIntervalSec = Number(src.pollIntervalSec);
  if (!Number.isFinite(pollIntervalSec)) pollIntervalSec = DEFAULTS.pollIntervalSec;
  pollIntervalSec = Math.max(MIN_POLL_INTERVAL_SEC, Math.round(pollIntervalSec));

  let port = Number(src.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULTS.port;

  let retentionDays = src.retentionDays;
  if (retentionDays === undefined) retentionDays = null;
  if (retentionDays !== null) {
    const n = Number(retentionDays);
    retentionDays = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  const revealAccountIdentifiers = src.revealAccountIdentifiers === true;
  return { pollIntervalSec, port, retentionDays, revealAccountIdentifiers };
}

/**
 * 設定を読む。毎回ファイルを読み直すので、外部エディタでの変更が次の tick から効く。
 * @returns {Config}
 */
export function readConfig() {
  if (!configFile) return { ...DEFAULTS };
  try {
    const text = fs.readFileSync(configFile, 'utf8');
    return sanitizeConfig(JSON.parse(text));
  } catch (e) {
    logger.warn('config.json を読めないため既定値で続行', { error: String(e && e.message ? e.message : e) });
    return { ...DEFAULTS };
  }
}

/**
 * 設定を書き戻す。
 * @param {Partial<Config>} patch
 * @returns {Config}
 */
export function writeConfig(patch) {
  const next = sanitizeConfig({ ...(configFile && fs.existsSync(configFile) ? safeRead() : DEFAULTS), ...patch });
  if (!configFile) return next;
  try {
    fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (e) {
    logger.warn('config.json を書けません', { error: String(e && e.message ? e.message : e) });
  }
  return next;
}

function safeRead() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return DEFAULTS;
  }
}
