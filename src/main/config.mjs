// 設定の読み書き（設計書 §9）: userData/config.json
import fs from 'node:fs';
import path from 'node:path';
import * as logger from './logger.mjs';

/**
 * @typedef {Object} Config
 * @property {number} pollIntervalSec  取得間隔（秒）。既定 180、最小 30
 * @property {number} port             HTTP サーバのポート。既定 47811
 * @property {number|null} retentionDays  保持日数。null = 無制限
 * @property {boolean} revealAccountIdentifiersInAccountMenu アカウントメニューを開いている間だけ実 ID を表示するか
 * @property {boolean} claudeAuthNotifications Claude 認証の案内通知を出すか（設計書 §15.6）。false でも理由表示は続ける
 * @property {number} claudeAuthNoticeLeadSec 期限の何秒前から案内するか。300–3600 に clamp、既定 600
 * @property {'off'|'once'} claudeExpiredUsageProbe 期限超過後の usage 確認送信（設計書 §15.12）。'once' 以外は 'off'
 */

/** @type {Config} */
export const DEFAULTS = Object.freeze({
  pollIntervalSec: 180,
  port: 47811,
  retentionDays: null,
  revealAccountIdentifiersInAccountMenu: true,
  claudeAuthNotifications: true,
  claudeAuthNoticeLeadSec: 600,
  claudeExpiredUsageProbe: 'off',
});

/** 旧リリースの設定キー。正規化後の設定からは取り除く（設計書 §3.5）。 */
export const LEGACY_REVEAL_KEY = 'revealAccountIdentifiers';

export const MIN_POLL_INTERVAL_SEC = 30;

/** Claude 認証の案内時刻の範囲（秒）。30 秒の送信余裕とは独立（設計書 §15.6） */
export const MIN_CLAUDE_AUTH_NOTICE_LEAD_SEC = 300;
export const MAX_CLAUDE_AUTH_NOTICE_LEAD_SEC = 3600;

/** @type {string|null} */
let configFile = null;

/**
 * 設定ファイルの場所を決める。無ければ既定値で生成する。
 * 旧形式の config.json は一回だけ正規化して書き戻す（設計書 §3.5）。
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
    return configFile;
  }
  if (needsRevealSettingMigration(safeRead())) {
    writeConfig({});
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

  // 新設定が未定義なら旧 revealAccountIdentifiers の値にかかわらず true とする（設計書 §3.5）。
  const revealAccountIdentifiersInAccountMenu = src.revealAccountIdentifiersInAccountMenu !== false;

  // boolean 以外（欠落・文字列など）は既定 true（設計書 §15.6）
  const claudeAuthNotifications = typeof src.claudeAuthNotifications === 'boolean' ? src.claudeAuthNotifications : true;

  // 有限の数値だけを整数化して 300–3600 に clamp。それ以外は 600
  let claudeAuthNoticeLeadSec = src.claudeAuthNoticeLeadSec;
  if (typeof claudeAuthNoticeLeadSec === 'number' && Number.isFinite(claudeAuthNoticeLeadSec)) {
    claudeAuthNoticeLeadSec = Math.min(MAX_CLAUDE_AUTH_NOTICE_LEAD_SEC, Math.max(MIN_CLAUDE_AUTH_NOTICE_LEAD_SEC, Math.round(claudeAuthNoticeLeadSec)));
  } else {
    claudeAuthNoticeLeadSec = DEFAULTS.claudeAuthNoticeLeadSec;
  }

  // 'off' / 'once' のみ。欠落・不正値は安全側の 'off'（設計書 §15.6 / §15.12）
  const claudeExpiredUsageProbe = src.claudeExpiredUsageProbe === 'once' ? 'once' : 'off';
  return {
    pollIntervalSec, port, retentionDays, revealAccountIdentifiersInAccountMenu,
    claudeAuthNotifications, claudeAuthNoticeLeadSec, claudeExpiredUsageProbe,
  };
}

/**
 * 設定ファイルが旧形式のままかどうかを判定する（設計書 §3.5）。
 * @param {any} raw  config.json をそのまま JSON.parse した値
 * @returns {boolean} 書き戻しが必要なら true
 */
export function needsRevealSettingMigration(raw) {
  if (!raw || typeof raw !== 'object') {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'revealAccountIdentifiersInAccountMenu')) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(raw, LEGACY_REVEAL_KEY);
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
  return writeConfigResult(patch).config;
}

/**
 * 設定を書き戻し、保存できたかも返す。
 * @param {Partial<Config>} patch
 * @returns {{config:Config, saved:boolean}}
 */
function writeConfigResult(patch) {
  const next = sanitizeConfig({ ...(configFile && fs.existsSync(configFile) ? safeRead() : DEFAULTS), ...patch });
  if (!configFile) return { config: next, saved: false };
  try {
    fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { config: next, saved: true };
  } catch (e) {
    logger.warn('config.json を書けません', { error: String(e && e.message ? e.message : e) });
    return { config: next, saved: false };
  }
}

/**
 * 期限超過後の確認送信を設定上も off にする（429・期間/予算上限・台帳上限での停止。設計書 §15.12）。
 * 保存に失敗しても呼び出し側のメモリ上の停止は解除しない。
 * @returns {boolean} 保存できたら true
 */
export function saveClaudeExpiredUsageProbeOff() {
  return writeConfigResult({ claudeExpiredUsageProbe: 'off' }).saved;
}

function safeRead() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return DEFAULTS;
  }
}
