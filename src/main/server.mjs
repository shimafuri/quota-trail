// localhost HTTP サーバ（設計書 §6 / アカウントメニュー設計書 §3）
// - 127.0.0.1 のみ bind、読み取り専用、CORS ヘッダは付けない
// - 静的: src/renderer/* と src/shared/*（/shared/ 配下）
// - API: /api/meta, /api/samples?from=&to=, /api/latest, /api/accounts
// - 実 ID は /api/account-identifiers だけが返し、process-scoped nonce と設定 gate を要求する
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findPort } from './lib/ports.mjs';
import * as logger from './logger.mjs';

const HOST = '127.0.0.1';
const MAX_POINTS_PER_SERIES = 50_000;

/** 実 ID batch endpoint が要求するヘッダ名（アカウントメニュー設計書 §3.2）。 */
const IDENTIFIER_TOKEN_HEADER = 'x-quota-trail-identifier-token';

/**
 * main process 起動時に一度だけ作る nonce（アカウントメニュー設計書 §3.3）。
 * 実 ID ではないため匿名 DTO の性質を壊さない。
 * URL、localStorage、ログへは入れない。
 */
const IDENTIFIER_ACCESS_TOKEN = crypto.randomBytes(32).toString('base64url');

/**
 * 長さの違いを漏らさずに nonce を比較する。
 * @param {unknown} candidate  リクエストヘッダの値
 * @returns {boolean} 一致すれば true
 */
function matchesIdentifierToken(candidate) {
  if (typeof candidate !== 'string') {
    return false;
  }
  const given = Buffer.from(candidate, 'utf8');
  const expected = Buffer.from(IDENTIFIER_ACCESS_TOKEN, 'utf8');
  if (given.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(given, expected);
}

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

/**
 * 実 ID を含む応答を送る（アカウントメニュー設計書 §3.2）。
 * 保存も referrer 送出もさせない。
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} obj
 * @returns {void}
 */
function sendPrivateJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
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
 * @param {() => {pollIntervalSec:number, port:number, revealAccountIdentifiersInAccountMenu?:boolean}} deps.readConfig
 * @param {any} [deps.accountManager]
 * @param {string} deps.appRoot   リポジトリ／アプリのルート
 * @param {(port:number) => void} [deps.onPort]  実際に bind したポートの通知
 * @param {() => boolean} [deps.getAutostart]  Windows 自動起動が有効かどうか（省略時は false）
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function startServer({ db, readConfig, appRoot, onPort, getAutostart, accountManager }) {
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
        accountDimensionAvailable: db.accountDimensionAvailable !== false,
        canRevealAccountIdentifiersInAccountMenu: cfg.revealAccountIdentifiersInAccountMenu !== false,
      });
      return;
    }

    if (pathname === '/api/accounts') {
      if (db.accountDimensionAvailable === false) {
        sendJson(res, 200, { available: false, now: Date.now() });
        return;
      }
      const revealEnabled = readConfig().revealAccountIdentifiersInAccountMenu !== false;
      const accounts = accountManager?.accounts?.() ?? (db.listAccounts?.() ?? []);
      /** @type {Record<string, any>} */
      const providers = {};
      for (const provider of ['claude', 'codex']) {
        const current = accountManager?.current?.(provider) ?? {
          status: 'unknown', accountKey: null,
        };
        const resolution = ['pending', 'known', 'unknown'].includes(current.status)
          ? current.status
          : 'unknown';
        const currentAccountKey = resolution === 'unknown'
          ? `${provider}:unknown`
          : current.accountKey ?? null;
        const rows = accounts
          .filter((account) => account.provider === provider)
          .map((account) => ({
            accountKey: account.accountKey,
            label: account.label,
            isCurrent: account.accountKey === currentAccountKey,
            kind: 'known',
          }));
        if (resolution === 'unknown' || db.hasUnknownSamples?.(provider) === true) {
          rows.push({
            accountKey: `${provider}:unknown`,
            label: '不明なアカウント',
            isCurrent: currentAccountKey === `${provider}:unknown`,
            kind: 'unknown',
          });
        }
        providers[provider] = { resolution, currentAccountKey, accounts: rows };
      }
      // 行には DB と account manager が作る匿名 DTO だけを含める。
      // nonce は実 ID ではないため、設定が有効なときだけ top-level へ添える。
      const payload = { providers, now: Date.now() };
      if (revealEnabled) {
        payload.identifierAccessToken = IDENTIFIER_ACCESS_TOKEN;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/account-identifiers') {
      // 条件不成立の理由は区別せず、常に同じ 404 を返す（アカウントメニュー設計書 §3.3）。
      const cfg = readConfig();
      const allowed = req.method === 'GET'
        && cfg.revealAccountIdentifiersInAccountMenu !== false
        && db.accountDimensionAvailable !== false
        && matchesIdentifierToken(req.headers[IDENTIFIER_TOKEN_HEADER]);
      if (!allowed) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      /** @type {Record<string, Record<string, {kind:string, value:string}>>} */
      const providers = {};
      for (const row of db.listAccountIdentifiers?.() ?? []) {
        if (!providers[row.provider]) {
          providers[row.provider] = {};
        }
        providers[row.provider][row.accountKey] = { kind: row.kind, value: row.value };
      }
      sendPrivateJson(res, 200, { providers, now: Date.now() });
      return;
    }

    const selectors = () => {
      if (db.accountDimensionAvailable === false) {
        return { claude: null, codex: null };
      }
      const out = {};
      for (const provider of ['claude', 'codex']) {
        const key = url.searchParams.get(provider);
        if (key === null) { out[provider] = accountManager?.current?.(provider)?.accountId ?? null; continue; }
        const id = db.resolveAccountKey?.(provider, key);
        if (id === 'invalid') return null;
        out[provider] = id;
      }
      return out;
    };

    if (pathname === '/api/latest') {
      const accountIdsByProvider = selectors();
      if (!accountIdsByProvider) { sendJson(res, 400, { error: 'invalid account selector' }); return; }
      sendJson(res, 200, { series: db.latest({ accountIdsByProvider }), now: Date.now() });
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
      const accountIdsByProvider = selectors();
      if (!accountIdsByProvider) { sendJson(res, 400, { error: 'invalid account selector' }); return; }
      const raw = db.queryAllSeries({ from, to, accountIdsByProvider });
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
