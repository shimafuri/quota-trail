// `codex app-server` を spawn して account/rateLimits/read を 1 回だけ呼ぶ（設計書 §4.4）
// - 空の一時ディレクトリを cwd にする
// - JSON-RPC（1 行 1 JSON）で initialize → initialized 通知 → account/rateLimits/read
// - fs/* や command/* は呼ばない。stdout 上限 256 KiB、全体 20 秒
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexIdentityFromAuth, identity } from '../lib/account-identity.mjs';

const TOTAL_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 5_000;
const MAX_STDOUT_BYTES = 256 * 1024;

/** app-server 実行前後の auth.json から、token を保持せず identity だけを読む。 */
function readAuthIdentitySnapshot() {
  const dir = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ''
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    return codexIdentityFromAuth(auth).identity;
  } catch {
    return null;
  }
}

/** @param {any} left @param {any} right @returns {boolean} */
function sameCanonicalIdentity(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.uuid || right.uuid) {
    return Boolean(left.uuid && right.uuid && left.uuid === right.uuid);
  }
  return Boolean(left.email && right.email && left.email === right.email);
}

/** app-server と前後 auth snapshot の一致だけから帰属先を選ぶ。 */
export function resolveAppServerIdentity(before, after, account) {
  if (account?.uuid) {
    return account;
  }
  if (!before || !after) {
    return null;
  }
  if (account?.email) {
    if (before.email !== account.email || after.email !== account.email) {
      return null;
    }
    return identity({
      provider: 'codex',
      uuid: before.uuid ?? after.uuid,
      email: account.email,
      source: 'codex_app_server',
      assurance: 'authoritative',
    });
  }
  return sameCanonicalIdentity(before, after) ? before : null;
}

/**
 * @returns {Promise<{ok:true, result:any, identity:any}|{ok:false, errorCode:string}>}
 */
export async function readRateLimitsViaAppServer({ version = '1.0.0' } = {}) {
  const beforeIdentity = readAuthIdentitySnapshot();
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
    let rateLimits = null;
    let accountIdentity = null;
    let grace = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
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
      if (v.ok) {
        const afterIdentity = readAuthIdentitySnapshot();
        resolve({ ...v, identity: resolveAppServerIdentity(beforeIdentity, afterIdentity, accountIdentity) });
      } else {
        resolve(v);
      }
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
          // account/read はバージョン差があり、rate limits と失敗境界を分ける。
          send({ jsonrpc: '2.0', id: 3, method: 'account/read', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) { settle({ ok: false, errorCode: 'app_server_rate_limits' }); return; }
          rateLimits = msg.result;
          // 任意メソッドのためにプロセス全体の 20 秒 timeout を使い切らない。
          grace = setTimeout(() => settle({ ok: true, result: rateLimits, identity: accountIdentity }), 2000);
        } else if (msg.id === 3) {
          if (!msg.error) {
            const a = msg.result?.account ?? msg.result;
            accountIdentity = identity({ provider: 'codex', uuid: a?.uuid ?? a?.id ?? a?.accountId, email: a?.email, source: 'codex_app_server', assurance: 'authoritative' });
          }
          if (rateLimits !== null) settle({ ok: true, result: rateLimits, identity: accountIdentity });
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
