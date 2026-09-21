// Electron エントリ（設計書 §3 / §8）
// single-instance lock → config → logger → db → 初回 identity/backfill → server → tray → scheduler
import { app, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import * as logger from './logger.mjs';
import { initConfig, readConfig, writeConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { startServer } from './server.mjs';
import { createScheduler } from './scheduler.mjs';
import { createAccountManager } from './account-manager.mjs';
import { createTray } from './tray.mjs';
import * as autostart from './autostart.mjs';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';
import { resolveInitialIdentityWithinBudget } from './lib/startup-identity.mjs';

/** @type {ReturnType<typeof openDb>|null} */
let db = null;
/** @type {{port:number, url:string, close:()=>Promise<void>}|null} */
let server = null;
/** @type {ReturnType<typeof createScheduler>|null} */
let scheduler = null;
/** @type {ReturnType<typeof createTray>|null} */
let tray = null;
let accountManager = null;
let quitting = false;
/** will-quit で理由を出すための記録。'tray-menu' | 'second-instance' | 'signal:<name>' | 'power-shutdown' | 'unknown' */
let quitReason = 'unknown';
/** @type {NodeJS.Timeout|null} */
let lastAliveTimer = null;
/** @type {string|null} */
let lastAlivePath = null;

const appRoot = app.getAppPath();
const INITIAL_IDENTITY_TIMEOUT_MS = 3_000;

// --- 単一インスタンス --------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  quitReason = 'second-instance';
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

/** userData/last-alive.json を書き込む（前回異常終了の検知用） */
function writeLastAlive(startedAt) {
  if (!lastAlivePath) return;
  const rec = {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  };
  const tmp = `${lastAlivePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, lastAlivePath);
  } catch (e) {
    logger.warn('last-alive.json の更新に失敗', { error: String(e && e.message ? e.message : e) });
  }
}

/** 前回インスタンスが last-alive.json を更新したまま消えていないか確認する */
function checkPreviousInstanceAlive() {
  if (!lastAlivePath) return;
  try {
    if (!fs.existsSync(lastAlivePath)) return;
    const prev = JSON.parse(fs.readFileSync(lastAlivePath, 'utf8'));
    const prevAt = new Date(prev.at).getTime();
    if (Number.isFinite(prevAt) && Date.now() - prevAt > 3 * 60_000) {
      logger.warn('前回のインスタンスは正常終了せずに消えた', { lastAliveAt: prev.at, pid: prev.pid });
    }
  } catch (e) {
    logger.warn('last-alive.json の確認に失敗', { error: String(e && e.message ? e.message : e) });
  }
}

/** powerMonitor イベントをログし、resume/unlock-screen で即時 tick する */
function registerPowerMonitorLogging() {
  const events = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown'];
  for (const evt of events) {
    powerMonitor.on(evt, () => {
      if (evt === 'shutdown') quitReason = 'power-shutdown';
      logger.info('powerMonitor', { event: evt });
      if (evt === 'resume' || evt === 'unlock-screen') {
        // スリープ復帰・ロック解除後の最初のサンプルを即時取得する（設計書 §4.5）
        void scheduler?.runNow();
      }
    });
  }
  // on-ac / on-battery は darwin/win32 のみ（Linux では発火しないので登録を省く）
  if (process.platform !== 'linux') {
    for (const evt of ['on-ac', 'on-battery']) {
      try {
        powerMonitor.on(evt, () => logger.info('powerMonitor', { event: evt }));
      } catch (e) {
        logger.warn('powerMonitor イベント登録に失敗', { event: evt, error: String(e && e.message ? e.message : e) });
      }
    }
  }
}

async function main() {
  const startedAt = Date.now();
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

  // 前回異常終了の検知（last-alive.json ベース。ログはパースしない）
  lastAlivePath = path.join(userData, 'last-alive.json');
  checkPreviousInstanceAlive();
  writeLastAlive(startedAt);
  lastAliveTimer = setInterval(() => writeLastAlive(startedAt), 60_000);

  // DB
  const dbFile = path.join(userData, 'quota-trail.sqlite');
  db = openDb(dbFile);
  logger.info('DB を開いた', { dbPath: dbFile, backend: db.backend });
  accountManager = createAccountManager({ db });

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

  // 初期画面の既定選択が別 account にならないよう、公開前に current/backfill を確定する。
  // profile が遅い・資格情報が無い場合でも 3 秒で unknown として先へ進む。
  const initialContext = { observedAt: Date.now(), intervalSec: cfg0.pollIntervalSec ?? 180 };
  const initialBatches = await Promise.all([
    resolveInitialIdentityWithinBudget(claude.fetchClaudeSamples(initialContext), INITIAL_IDENTITY_TIMEOUT_MS),
    resolveInitialIdentityWithinBudget(codex.fetchCodexSamples(initialContext), INITIAL_IDENTITY_TIMEOUT_MS),
  ]);
  for (const [provider, batch] of [['claude', initialBatches[0]], ['codex', initialBatches[1]]]) {
    accountManager.observe(provider, batch?.identity ?? null);
  }
  try {
    accountManager.finishBackfills();
  } catch {
    logger.warn('initial_backfill_failed');
  }

  // HTTP サーバ
  server = await startServer({
    db,
    accountManager,
    readConfig,
    appRoot,
    getAutostart: () => autostart.isEnabled(),
    onPort: (port) => {
      // 実際に bind したポートを書き戻す（次回同じ URL になるように）
      if (readConfig().port !== port) writeConfig({ port });
    },
  });

  // トレイ
  tray = createTray({
    appRoot,
    getUrl: () => server?.url ?? '',
    getLatest: () => (db ? db.latest({ accountIdsByProvider: accountManager?.currentAccountIds?.() }) : {}),
    getAccountDimensionAvailable: () => db?.accountDimensionAvailable !== false,
    onFetchNow: () => { void scheduler?.runNow(); },
    onQuit: () => { quitReason = 'tray-menu'; quitting = true; app.quit(); },
  });

  // スケジューラ
  scheduler = createScheduler({
    db,
    readConfig,
    onSamples: (_samples, batches) => {
      for (const batch of batches) {
        accountManager?.observeBatch(batch);
      }
      accountManager?.finishBackfills();
      tray?.refresh();
    },
  });
  scheduler.start();
  tray.refresh();

  registerPowerMonitorLogging();
}

app.on('before-quit', () => {
  quitting = true;
  logger.info('before-quit');
});

app.on('quit', (_event, exitCode) => {
  logger.info('quit', { exitCode, quitReason });
});

app.on('will-quit', () => {
  if (lastAliveTimer) { clearInterval(lastAliveTimer); lastAliveTimer = null; }
  try { scheduler?.stop(); } catch { /* noop */ }
  try { tray?.destroy(); } catch { /* noop */ }
  try { void server?.close(); } catch { /* noop */ }
  try { db?.close(); } catch { /* noop */ }
  logger.info('終了', { quitting, quitReason });
});

process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', { error: String(e && e.stack ? e.stack : e) });
});
process.on('unhandledRejection', (e) => {
  logger.error('unhandledRejection', { error: String(e) });
});

// exit は同期処理しか実行できない。logger は appendFileSync を使うため間に合う
process.on('exit', (code) => {
  logger.info('process exit', { code });
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    quitReason = `signal:${sig}`;
    logger.warn('シグナル受信', { signal: sig });
    app.quit();
  });
}
