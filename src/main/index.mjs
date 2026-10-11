// Electron エントリ（設計書 §3 / §8）
// single-instance lock → config → logger → db → Claude 認証監視 → 初回 identity/backfill → server → tray → scheduler
import { app, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import * as logger from './logger.mjs';
import { initConfig, readConfig, writeConfig, saveClaudeExpiredUsageProbeOff } from './config.mjs';
import { openDb } from './db.mjs';
import { startServer } from './server.mjs';
import { createScheduler } from './scheduler.mjs';
import { createAccountManager } from './account-manager.mjs';
import { createTray, createElectronNotifier } from './tray.mjs';
import * as autostart from './autostart.mjs';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';
import { resolveInitialIdentityWithinBudget } from './lib/startup-identity.mjs';
import { createClaudeAuthMonitor } from './claude-auth-monitor.mjs';
import { sleepInclusiveElapsedMs } from './lib/elapsed-clock.mjs';
import { handleClaudePowerEvent } from './lib/power-events.mjs';

/** @type {ReturnType<typeof openDb>|null} */
let db = null;
/** @type {{port:number, url:string, close:()=>Promise<void>}|null} */
let server = null;
/** @type {ReturnType<typeof createScheduler>|null} */
let scheduler = null;
/** @type {ReturnType<typeof createTray>|null} */
let tray = null;
let accountManager = null;
/** @type {ReturnType<typeof createClaudeAuthMonitor>|null} */
let claudeAuthMonitor = null;
/** @type {ReturnType<typeof claude.createClaudeProvider>|null} */
let claudeProvider = null;
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
      // ロック中は OS 通知だけを保留する。監視と tick は止めない（H-002 / 設計書 §15.6）。
      // suspend/resume は確認送信の予約に記録し、resume の gate 再評価を即時 tick より先に済ませる（§15.12）
      handleClaudePowerEvent(evt, {
        provider: claudeProvider,
        monitor: claudeAuthMonitor,
        runNow: () => scheduler?.runNow(),
      });
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

  // Claude provider。起動 probe・scheduler・認証監視で同じインスタンスを使い、401 / 期限切れ latch と
  // 期限超過後の確認送信の予算台帳を共有する（設計書 §15.4 / §15.12）。確認送信は config の
  // claudeExpiredUsageProbe が 'once' のときだけで、429・期間/予算上限・台帳上限では設定を off に保存する。
  claudeProvider = claude.createClaudeProvider({
    readConfig,
    logger,
    elapsedNow: sleepInclusiveElapsedMs,
    saveProbeOff: () => saveClaudeExpiredUsageProbeOff(),
  });

  // Claude 認証監視（設計書 §15.4 / §15.6）。30 秒ごとのローカル再読込のみで HTTP / DB は使わない。
  claudeAuthMonitor = createClaudeAuthMonitor({
    readSnapshot: () => claude.readCredentialSnapshot(),
    provider: claudeProvider,
    readConfig,
    notifier: createElectronNotifier(),
    openDashboard: () => tray?.openDashboard(),
    onStatusChange: () => tray?.refresh(),
    // blocked だった token が新 token に切り替わったときだけ、次の予定 tick を待たず即時 tick する
    // （発注者指示 2026-10-03）。scheduler は後で作られるため module 内 let 変数を閉包で参照する
    // （tray の onFetchNow と同じ形）。single-flight は scheduler.runNow() 自身が保証する
    requestImmediateTick: () => { void scheduler?.runNow(); },
  });
  claudeAuthMonitor.start();

  // 初期画面の既定選択が別 account にならないよう、公開前に current/backfill を確定する。
  // profile が遅い・資格情報が無い場合でも 3 秒で unknown として先へ進む。
  // Claude は期限 gate を通した profile/cache だけを参照し、usage は取得しない（設計書 §15.4）。
  // 予算を超えた profile は通常 tick と共有されるため二重要求しない。
  const initialContext = { observedAt: Date.now(), intervalSec: cfg0.pollIntervalSec ?? 180 };
  const initialBatches = await Promise.all([
    resolveInitialIdentityWithinBudget(
      claudeProvider.resolveInitialIdentity().then((identity) => ({ provider: 'claude', identity })),
      INITIAL_IDENTITY_TIMEOUT_MS,
    ),
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
    getClaudeAuth: () => claudeAuthMonitor?.publicStatus() ?? null,
    onFetchNow: () => { void scheduler?.runNow(); },
    onQuit: () => { quitReason = 'tray-menu'; quitting = true; app.quit(); },
  });

  // スケジューラ
  scheduler = createScheduler({
    db,
    readConfig,
    claudeProvider,
    authObserver: claudeAuthMonitor,
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
  try { claudeAuthMonitor?.stop(); } catch { /* noop */ }
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
