// トレイアイコンとメニュー（設計書 §8 / §15.6）
import { Tray, Menu, nativeImage, shell, Notification } from 'electron';
import path from 'node:path';
import * as autostart from './autostart.mjs';
import * as logger from './logger.mjs';
import { buildTooltip } from './lib/tooltip.mjs';

export { buildTooltip } from './lib/tooltip.mjs';

/**
 * Electron の OS 通知（設計書 §15.6）。monitor へ注入する。click でダッシュボードを開く。
 * GC で click が失われないよう、表示中の通知への参照を閉じるまで保持する。
 * @returns {{show:(notice:{title:string, body:string, onClick?:() => void}) => void}}
 */
export function createElectronNotifier() {
  const live = new Set();
  return {
    show({ title, body, onClick }) {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: false });
      live.add(n);
      const release = () => { live.delete(n); };
      n.on('click', () => { release(); onClick?.(); });
      n.on('close', release);
      n.show();
    },
  };
}

/**
 * @param {Object} deps
 * @param {string} deps.appRoot
 * @param {() => string} deps.getUrl        ダッシュボード URL
 * @param {() => Record<string, any>} deps.getLatest
 * @param {() => any} [deps.getClaudeAuth]  Claude 認証監視の公開状態（期限前の案内用）
 * @param {() => void} deps.onFetchNow
 * @param {() => void} deps.onQuit
 */
export function createTray({ appRoot, getUrl, getLatest, getAccountDimensionAvailable = () => true, getClaudeAuth = () => null, onFetchNow, onQuit }) {
  const icoPath = path.join(appRoot, 'assets', 'icon.ico');
  const pngPath = path.join(appRoot, 'assets', 'icon.png');
  let image = nativeImage.createFromPath(icoPath);
  if (image.isEmpty()) image = nativeImage.createFromPath(pngPath);
  const tray = new Tray(image);

  const openDashboard = () => {
    const url = getUrl();
    if (url) void shell.openExternal(url);
  };

  function rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: 'ダッシュボードを開く', click: openDashboard },
      { label: '今すぐ取得', click: () => onFetchNow() },
      { type: 'separator' },
      {
        label: 'Windows 起動時に実行する',
        type: 'checkbox',
        checked: autostart.isEnabled(),
        click: (item) => {
          const now = autostart.setEnabled(item.checked);
          item.checked = now;
          rebuildMenu();
        },
      },
      { type: 'separator' },
      { label: '終了', click: () => onQuit() },
    ]);
    tray.setContextMenu(menu);
  }

  tray.on('click', openDashboard);
  tray.on('double-click', openDashboard);
  rebuildMenu();
  tray.setToolTip('quota-trail');

  return {
    tray,
    refresh() {
      try {
        let tooltip = buildTooltip(getLatest(), { claudeAuth: getClaudeAuth() });
        if (!getAccountDimensionAvailable()) {
          tooltip += '\nアカウント別表示は無効';
        }
        tray.setToolTip(tooltip);
      } catch (e) {
        logger.warn('ツールチップ更新に失敗', { error: String(e && e.message ? e.message : e) });
      }
      rebuildMenu();
    },
    openDashboard,
    destroy() {
      try { tray.destroy(); } catch { /* noop */ }
    },
  };
}
