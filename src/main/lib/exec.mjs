// 小さな子プロセス実行ヘルパ（CLI の --version 取得などに使う）
import { spawn } from 'node:child_process';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export function runCommand(command, args, { timeoutMs = 8000, cwd } = {}) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: process.platform === 'win32', // Windows の .cmd シム対策
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}
