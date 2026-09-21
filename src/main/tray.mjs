// トレイアイコンとメニュー（設計書 §8）
import { Tray, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import * as autostart from './autostart.mjs';
import * as logger from './logger.mjs';

const ERROR_LABEL = {
  no_credentials: '未ログイン',
  auth_expired: '認証期限切れ',
  window_absent: '枠なし',
  timeout: 'タイムアウト',
  network: '通信失敗',
  parse: '応答不正',
};

/**
 * @param {Record<string, import('./lib/normalize.mjs').Sample|null>} latest
 * @returns {string}
 */
export function buildTooltip(latest) {
  const fmt = (s) => {
    if (!s) return '--';
    if (s.status === 'ok' && s.usedPercent !== null) return `${Math.round(s.usedPercent)}%`;
    return `-- (${ERROR_LABEL[s.errorCode ?? ''] ?? s.errorCode ?? 'error'})`;
  };
  const lines = ['quota-trail'];
  lines.push(`Claude 5h ${fmt(latest['claude/5h'])} / W ${fmt(latest['claude/weekly'])}`);
  lines.push(`Codex 5h ${fmt(latest['codex/5h'])} / W ${fmt(latest['codex/weekly'])}`);
  const times = Object.values(latest).filter(Boolean).map((s) => s.observedAt);
  if (times.length > 0) {
    const d = new Date(Math.max(...times));
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    lines.push(`最終取得 ${hh}:${mm}`);
  }
  // 認証期限切れのときは回復方法を案内する
  if (latest['claude/5h']?.errorCode === 'auth_expired') {
    lines.push('Claude: Claude Code を一度起動すると回復します');
  }
  return lines.join('\n');
}

/**
 * @param {Object} deps
 * @param {string} deps.appRoot
 * @param {() => string} deps.getUrl        ダッシュボード URL
 * @param {() => Record<string, any>} deps.getLatest
 * @param {() => void} deps.onFetchNow
 * @param {() => void} deps.onQuit
 */
export function createTray({ appRoot, getUrl, getLatest, getAccountDimensionAvailable = () => true, onFetchNow, onQuit }) {
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
        let tooltip = buildTooltip(getLatest());
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
