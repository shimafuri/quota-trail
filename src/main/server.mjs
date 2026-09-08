// localhost HTTP サーバ（設計書 §6）
// - 127.0.0.1 のみ bind、読み取り専用、CORS ヘッダは付けない
// - 静的: src/renderer/* と src/shared/*（/shared/ 配下）
// - API: /api/meta, /api/samples?from=&to=, /api/latest
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findPort } from './lib/ports.mjs';
import * as logger from './logger.mjs';

const HOST = '127.0.0.1';
const MAX_POINTS_PER_SERIES = 50_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 等間隔に間引く（先頭と末尾は必ず残す）。
 * @template T
 * @param {T[]} arr
 * @param {number} max
 * @returns {T[]}
 */
export function decimate(arr, max = MAX_POINTS_PER_SERIES) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * パストラバーサルを禁止した安全な解決。root 外なら null。
 * @param {string} root
 * @param {string} urlPath  先頭 '/' 付き
 * @returns {string|null}
 */
export function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * @param {Object} deps
 * @param {any} deps.db
 * @param {() => {pollIntervalSec:number, port:number}} deps.readConfig
 * @param {string} deps.appRoot   リポジトリ／アプリのルート
 * @param {(port:number) => void} [deps.onPort]  実際に bind したポートの通知
 * @param {() => boolean} [deps.getAutostart]  Windows 自動起動が有効かどうか（省略時は false）
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function startServer({ db, readConfig, appRoot, onPort, getAutostart }) {
  const rendererDir = path.join(appRoot, 'src', 'renderer');
  const sharedDir = path.join(appRoot, 'src', 'shared');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      logger.error('リクエスト処理で例外', { error: String(e && e.message ? e.message : e) });
      try { sendText(res, 500, 'internal error'); } catch { /* noop */ }
    });
  });

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const pathname = url.pathname;

    if (pathname === '/api/meta') {
      const cfg = readConfig();
      /** 読み取り専用。トレイの「Windows 起動時に実行する」の現在値 */
      let autostart = false;
      try { autostart = getAutostart ? getAutostart() === true : false; } catch { autostart = false; }
      sendJson(res, 200, {
        providers: ['claude', 'codex'],
        windows: ['5h', 'weekly'],
        pollIntervalSec: cfg.pollIntervalSec,
        now: Date.now(),
        dbPath: db.dbPath,
        backend: db.backend,
        autostart,
      });
      return;
    }

    if (pathname === '/api/latest') {
      sendJson(res, 200, { series: db.latest(), now: Date.now() });
      return;
    }

    if (pathname === '/api/samples') {
      const fromRaw = url.searchParams.get('from');
      const toRaw = url.searchParams.get('to');
      const from = Number(fromRaw);
      const to = Number(toRaw);
      if (fromRaw === null || toRaw === null || fromRaw.trim() === '' || toRaw.trim() === '' || !Number.isFinite(from) || !Number.isFinite(to)) {
        sendJson(res, 400, { error: 'from と to（epoch ms）が必要です' });
        return;
      }
      if (to < from) {
        sendJson(res, 400, { error: 'to は from 以上である必要があります' });
        return;
      }
      const raw = db.queryAllSeries({ from, to });
      /** @type {Record<string, any[]>} */
      const series = {};
      let decimated = false;
      for (const [k, v] of Object.entries(raw)) {
        if (v.length > MAX_POINTS_PER_SERIES) decimated = true;
        series[k] = decimate(v);
      }
      const payload = { series, now: Date.now() };
      if (decimated) payload.decimated = true;
      sendJson(res, 200, payload);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // --- 静的配信 ---------------------------------------------------------
    let root = rendererDir;
    let rel = pathname;
    if (pathname === '/shared' || pathname.startsWith('/shared/')) {
      root = sharedDir;
      rel = pathname.slice('/shared'.length) || '/';
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    const abs = resolveStatic(root, rel);
    if (!abs) {
      sendText(res, 400, 'bad path');
      return;
    }
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      sendText(res, 404, 'not found');
      return;
    }
    if (st.isDirectory()) {
      sendText(res, 404, 'not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(abs).pipe(res);
  }

  const cfg = readConfig();
  const port = await findPort({ preferred: cfg.port });
  const bound = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
    });
  });

  onPort?.(bound);
  logger.info('HTTP サーバ起動', { url: `http://${HOST}:${bound}/` });

  return {
    port: bound,
    url: `http://${HOST}:${bound}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
