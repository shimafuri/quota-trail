#!/usr/bin/env node
// postinstall: better-sqlite3 のネイティブバイナリを
//   - Electron ABI 用 (build/Release/better_sqlite3-electron.node)
//   - Node ABI 用     (build/Release/better_sqlite3-node.node)
// の 2 つ確保する。db.mjs が実行時 ABI に応じて nativeBinding で選ぶ。
// electron が未インストールでも失敗しない（初回 npm i -D electron の途中でも動く）。
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'node_modules', 'better-sqlite3');
const relDir = path.join(pkgDir, 'build', 'Release');
const mainBin = path.join(relDir, 'better_sqlite3.node');
const nodeBin = path.join(relDir, 'better_sqlite3-node.node');
const electronBin = path.join(relDir, 'better_sqlite3-electron.node');

/** @param {string} msg */
const log = (msg) => process.stdout.write(`[prepare-native] ${msg}\n`);

if (!fs.existsSync(pkgDir)) {
  log('better-sqlite3 が未インストールのためスキップ');
  process.exit(0);
}

const require_ = createRequire(import.meta.url);

/** 現在の build/Release/better_sqlite3.node がこの Node で読めるか */
function loadableByNode() {
  if (!fs.existsSync(mainBin)) return false;
  try {
    // process.dlopen を直接使うと better-sqlite3 の JS 側を通さずに ABI 判定できる
    const m = { exports: {} };
    process.dlopen(m, mainBin);
    return true;
  } catch {
    return false;
  }
}

function copy(from, to) {
  fs.copyFileSync(from, to);
  log(`${path.basename(from)} -> ${path.basename(to)}`);
}

// --- 1. Node ABI 版を確保 -------------------------------------------------
if (!fs.existsSync(nodeBin)) {
  if (loadableByNode()) {
    copy(mainBin, nodeBin);
  } else {
    // prebuild-install で Node ABI の prebuilt を取り直す
    let ok = false;
    try {
      const cli = require_.resolve('prebuild-install/bin.js', { paths: [pkgDir, root] });
      const r = spawnSync(process.execPath, [cli, '--runtime', 'node', '--target', process.versions.node], {
        cwd: pkgDir,
        stdio: 'inherit',
      });
      ok = r.status === 0;
    } catch (e) {
      log(`prebuild-install を解決できず: ${e.message}`);
    }
    if (ok && loadableByNode()) copy(mainBin, nodeBin);
    else log('Node ABI 版の取得に失敗（npm test の db.test.mjs はスキップされます）');
  }
}

// --- 2. Electron ABI 版を確保 --------------------------------------------
const electronDir = path.join(root, 'node_modules', 'electron');
if (!fs.existsSync(electronDir)) {
  log('electron が未インストールのため electron-rebuild をスキップ');
  process.exit(0);
}

const rebuildBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
if (!fs.existsSync(rebuildBin)) {
  log('@electron/rebuild が未インストールのためスキップ');
  process.exit(0);
}

log('electron-rebuild -f -w better-sqlite3 を実行中…');
const r = spawnSync(rebuildBin, ['-f', '-w', 'better-sqlite3'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) {
  log('electron-rebuild に失敗。Electron 側は node:sqlite フォールバックを使います');
  process.exit(0);
}
if (fs.existsSync(mainBin) && !loadableByNode()) {
  // Node で読めない = Electron ABI になった
  copy(mainBin, electronBin);
} else if (fs.existsSync(mainBin)) {
  log('警告: electron-rebuild 後もバイナリが Node ABI のまま');
}
