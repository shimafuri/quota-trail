// `codex app-server` を spawn して account/rateLimits/read を 1 回だけ呼ぶ（設計書 §4.4）
// - 空の一時ディレクトリを cwd にする
// - JSON-RPC（1 行 1 JSON）で initialize → initialized 通知 → account/rateLimits/read
// - fs/* や command/* は呼ばない。stdout 上限 256 KiB、全体 20 秒
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOTAL_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 5_000;
const MAX_STDOUT_BYTES = 256 * 1024;

/**
 * @returns {Promise<{ok:true, result:any}|{ok:false, errorCode:string}>}
 */
export async function readRateLimitsViaAppServer({ version = '1.0.0' } = {}) {
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-trail-codex-'));
  } catch {
    tmpDir = os.tmpdir();
  }

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    if (process.platform === 'win32') {
      // codex は .cmd シムなので cmd.exe 経由で起動する
      child = spawn('cmd.exe', ['/d', '/s', '/c', 'codex app-server'], { cwd: tmpDir, windowsHide: true });
    } else {
      child = spawn('codex', ['app-server'], { cwd: tmpDir });
    }
  } catch {
    return { ok: false, errorCode: 'app_server_spawn' };
  }

  return await new Promise((resolve) => {
    let buf = '';
    let bytes = 0;
    let settled = false;
    let initialized = false;

    const cleanup = () => {
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* noop */ }
      try { child.kill(); } catch { /* noop */ }
      const hard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, KILL_GRACE_MS);
      hard.unref?.();
      if (tmpDir && tmpDir.includes('quota-trail-codex-')) {
        setTimeout(() => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
        }, 200).unref?.();
      }
    };

    /** @param {{ok:true,result:any}|{ok:false,errorCode:string}} v */
    const settle = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };

    const timer = setTimeout(() => settle({ ok: false, errorCode: 'app_server_timeout' }), TOTAL_TIMEOUT_MS);

    const send = (obj) => {
      try {
        child.stdin?.write(`${JSON.stringify(obj)}\n`);
      } catch {
        settle({ ok: false, errorCode: 'app_server_io' });
      }
    };

    child.on('error', () => settle({ ok: false, errorCode: 'app_server_spawn' }));
    child.on('close', () => settle({ ok: false, errorCode: 'app_server_closed' }));

    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        settle({ ok: false, errorCode: 'app_server_overflow' });
        return;
      }
      buf += chunk.toString('utf8');
      let idx;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === '') continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ログ行などは無視
        }
        if (msg.id === 1 && !initialized) {
          if (msg.error) { settle({ ok: false, errorCode: 'app_server_initialize' }); return; }
          initialized = true;
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) { settle({ ok: false, errorCode: 'app_server_rate_limits' }); return; }
          settle({ ok: true, result: msg.result });
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'quota-trail', title: 'quota-trail', version } },
    });
  });
}
