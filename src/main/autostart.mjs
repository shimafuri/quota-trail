// Windows のログイン時自動起動（設計書 §8）
// app.setLoginItemSettings は HKCU\Software\Microsoft\Windows\CurrentVersion\Run に書く。
import { app } from 'electron';
import * as logger from './logger.mjs';

/** 開発時（未パッケージ）は electron.exe に app のパスを渡す必要がある */
function loginItemOptions(openAtLogin) {
  return {
    openAtLogin,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  };
}

/** @returns {boolean} 現在 自動起動が有効か */
export function isEnabled() {
  try {
    return app.getLoginItemSettings(loginItemOptions(true)).openAtLogin === true;
  } catch (e) {
    logger.warn('getLoginItemSettings に失敗', { error: String(e && e.message ? e.message : e) });
    return false;
  }
}

/**
 * @param {boolean} enabled
 * @returns {boolean} 設定後の状態
 */
export function setEnabled(enabled) {
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
    logger.info('自動起動を変更', { enabled });
  } catch (e) {
    logger.warn('setLoginItemSettings に失敗', { error: String(e && e.message ? e.message : e) });
  }
  return isEnabled();
}

/** トグル */
export function toggle() {
  return setEnabled(!isEnabled());
}
