// 空きポート探索（設計書 §6）
import net from 'node:net';

export const DEFAULT_PORT = 47811;
export const PORT_RANGE_END = 47899;

/**
 * 指定ポートで listen できるか試す。成功したら即 close して true。
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * preferred → preferred+1..rangeEnd → 0（動的） の順に空きポートを探す。
 * 実際に listen するのは呼び出し側なので、ここでは「候補」を返す。
 * @param {Object} [opts]
 * @param {number} [opts.preferred]
 * @param {number} [opts.rangeStart]
 * @param {number} [opts.rangeEnd]
 * @param {string} [opts.host]
 * @returns {Promise<number>} 空きポート番号。見つからなければ 0（OS 任せ）
 */
export async function findPort({ preferred = DEFAULT_PORT, rangeStart = DEFAULT_PORT, rangeEnd = PORT_RANGE_END, host = '127.0.0.1' } = {}) {
  /** @type {number[]} */
  const candidates = [];
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536) candidates.push(preferred);
  for (let p = rangeStart; p <= rangeEnd; p += 1) {
    if (p !== preferred) candidates.push(p);
  }
  for (const p of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p, host)) return p;
  }
  return 0;
}
