// Electron エントリ（設計書 §3 / §8）
// single-instance lock → config → logger → db → server → tray → scheduler
import { app } from 'electron';
import path from 'node:path';

import * as logger from './logger.mjs';
import { initConfig, readConfig, writeConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { startServer } from './server.mjs';
import { createScheduler } from './scheduler.mjs';
import { createTray } from './tray.mjs';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';

/** @type {ReturnType<typeof openDb>|null} */
let db = null;
/** @type {{port:number, url:string, close:()=>Promise<void>}|null} */
let server = null;
/** @type {ReturnType<typeof createScheduler>|null} */
let scheduler = null;
/** @type {ReturnType<typeof createTray>|null} */
let tray = null;
let quitting = false;

const appRoot = app.getAppPath();

// --- 単一インスタンス --------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 2 つ目の起動はダッシュボードを開かせて終了する
    tray?.openDashboard();
  });

  // ウィンドウは一切作らないので window-all-closed は発火しない（= 勝手に終了しない）。
  // 念のため、将来ウィンドウを持ったときにも終了しないようにしておく。
  app.on('window-all-closed', () => { /* 何もしない = 終了しない */ });

  app.whenReady().then(main).catch((e) => {
    logger.error('起動に失敗', { error: String(e && e.stack ? e.stack : e) });
    app.quit();
  });
}

async function main() {
  const userData = app.getPath('userData');
  logger.initLogger(path.join(userData, 'logs'));
  const cfgFile = initConfig(userData);
  logger.info('起動', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData,
    configPath: cfgFile,
  });

  // DB
  const dbFile = path.join(userData, 'quota-trail.sqlite');
  db = openDb(dbFile);
  logger.info('DB を開いた', { dbPath: dbFile, backend: db.backend });

  // 保持期間（設定されていれば起動時に一度だけ削除）
  const cfg0 = readConfig();
  if (cfg0.retentionDays) {
    const cutoff = Date.now() - cfg0.retentionDays * 86_400_000;
    const removed = db.pruneOlderThan(cutoff);
    if (removed > 0) logger.info('古い行を削除', { removed, retentionDays: cfg0.retentionDays });
  }

  // CLI バージョン（User-Agent 用。1 回だけ）
  void Promise.allSettled([claude.initUserAgent(), codex.initUserAgent()]).then(() => {
    logger.info('User-Agent を決定', { claude: claude.userAgent(), codex: codex.userAgent() });
  });

  // HTTP サーバ
  server = await startServer({
    db,
    readConfig,
    appRoot,
    onPort: (port) => {
      // 実際に bind したポートを書き戻す（次回同じ URL になるように）
      if (readConfig().port !== port) writeConfig({ port });
    },
  });

  // トレイ
  tray = createTray({
    appRoot,
    getUrl: () => server?.url ?? '',
    getLatest: () => (db ? db.latest() : {}),
    onFetchNow: () => { void scheduler?.runNow(); },
    onQuit: () => { quitting = true; app.quit(); },
  });

  // スケジューラ
  scheduler = createScheduler({
    db,
    readConfig,
    onSamples: () => tray?.refresh(),
  });
  scheduler.start();
  tray.refresh();
}

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  try { scheduler?.stop(); } catch { /* noop */ }
  try { tray?.destroy(); } catch { /* noop */ }
  try { void server?.close(); } catch { /* noop */ }
  try { db?.close(); } catch { /* noop */ }
  logger.info('終了', { quitting });
});

process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', { error: String(e && e.stack ? e.stack : e) });
});
process.on('unhandledRejection', (e) => {
  logger.error('unhandledRejection', { error: String(e) });
});
