#!/usr/bin/env node
/**
 * renderer 開発用のスタンドアロンサーバ（Electron 不要）。
 *
 *   node scripts/dev-renderer.mjs [--port 47899]
 *
 * - `src/renderer/` を `/` に、`src/shared/*.mjs` を `/shared/<file>` に配信
 * - `/api/meta`, `/api/samples`, `/api/latest` を生成データで模擬（設計 §6 の契約に一致）
 *
 * 生成データ（直近 30 日 / 既定 180 秒間隔）には次を含む:
 * - 5h 系列: 5 時間ごとにリセットして 0 に戻るのこぎり波
 * - weekly 系列: 週をかけてゆっくり上昇し、週次でリセット
 * - いくつかの欠測（20〜90 分）
 * - status:'error' が連続する区間
 * - intervalSec が 60 になっている区間
 *
 * 本番の main プロセスとは無関係（開発時の目視確認専用）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const SHARED_DIR = path.join(ROOT, 'src', 'shared');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const args = process.argv.slice(2);
const portArgIdx = args.indexOf('--port');
const PORT = portArgIdx >= 0 ? Number(args[portArgIdx + 1]) : 47899;
const POLL_INTERVAL_SEC = 180;

// ---------------------------------------------------------------- 疑似乱数

/**
 * 32bit の決定的ハッシュから 0..1 の乱数列を作る。
 * @param {number} seed
 * @returns {() => number}
 */
function rng(seed) {
  let s = (seed | 0) ^ 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const CURVE_BUCKETS = 120;
/** @type {Map<string, number[]>} */
const curveCache = new Map();

/**
 * 1 ウィンドウ分の「使用率の伸び方」（0..1 の単調増加、末尾 1）。
 * バースト的に増える形にして現実味を出す。
 * @param {string} cacheKey
 * @param {number} seed
 * @returns {number[]}
 */
function windowCurve(cacheKey, seed) {
  const hit = curveCache.get(cacheKey);
  if (hit) return hit;
  const rand = rng(seed);
  const bursts = 2 + Math.floor(rand() * 3);
  /** @type {{at:number,width:number,weight:number}[]} */
  const segs = [];
  for (let i = 0; i < bursts; i++) {
    segs.push({ at: rand(), width: 0.05 + rand() * 0.25, weight: 0.3 + rand() });
  }
  const inc = new Array(CURVE_BUCKETS).fill(0);
  for (let b = 0; b < CURVE_BUCKETS; b++) {
    const p = b / CURVE_BUCKETS;
    let v = 0.05; // 常時の緩やかな消費
    for (const s of segs) {
      const d = Math.abs(p - s.at) / s.width;
      if (d < 1) v += s.weight * (1 - d * d);
    }
    inc[b] = v;
  }
  const total = inc.reduce((a, b) => a + b, 0) || 1;
  const cum = [];
  let acc = 0;
  for (let b = 0; b < CURVE_BUCKETS; b++) {
    acc += inc[b] / total;
    cum.push(acc);
  }
  curveCache.set(cacheKey, cum);
  return cum;
}

// ---------------------------------------------------------------- データ生成

const SERIES_KEYS = ['claude/5h', 'claude/weekly', 'codex/5h', 'codex/weekly'];

/** @type {Record<string, {windowMs:number, seed:number, peakMin:number, peakMax:number}>} */
const SERIES_SPEC = {
  'claude/5h': { windowMs: 5 * HOUR, seed: 11, peakMin: 25, peakMax: 98 },
  'claude/weekly': { windowMs: 7 * DAY, seed: 23, peakMin: 45, peakMax: 92 },
  'codex/5h': { windowMs: 5 * HOUR, seed: 37, peakMin: 20, peakMax: 88 },
  'codex/weekly': { windowMs: 7 * DAY, seed: 53, peakMin: 35, peakMax: 80 },
};

/**
 * @param {string} key
 * @param {number} t
 * @returns {{usedPercent:number, resetsAt:number}}
 */
function valueAt(key, t) {
  const spec = SERIES_SPEC[key];
  const idx = Math.floor(t / spec.windowMs);
  const start = idx * spec.windowMs;
  const resetsAt = start + spec.windowMs;
  const rand = rng(spec.seed * 7919 + idx);
  const peak = spec.peakMin + rand() * (spec.peakMax - spec.peakMin);
  const curve = windowCurve(`${key}:${idx}`, spec.seed * 104729 + idx);
  const p = (t - start) / spec.windowMs;
  const b = Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(p * CURVE_BUCKETS)));
  const jitter = (rng(idx * 31 + Math.floor(t / MIN))() - 0.5) * 0.6;
  const v = Math.max(0, Math.min(100, peak * curve[b] + jitter));
  return { usedPercent: Math.round(v * 10) / 10, resetsAt };
}

const NOW = Math.floor(Date.now() / (POLL_INTERVAL_SEC * 1000)) * (POLL_INTERVAL_SEC * 1000);
const RANGE_START = NOW - 30 * DAY;

/** 欠測（サンプルそのものが無い）区間。now からの経過日で指定 */
const GAP_WINDOWS = [
  { at: NOW - 26 * DAY, minutes: 90 },
  { at: NOW - 18.4 * DAY, minutes: 45 },
  { at: NOW - 9 * DAY, minutes: 25 },
  { at: NOW - 3.2 * DAY, minutes: 60 },
  { at: NOW - 8 * HOUR, minutes: 21 },
];

/** status:'error' が並ぶ区間 */
const ERROR_WINDOWS = [
  { at: NOW - 12.5 * DAY, minutes: 150, code: 'auth_expired' },
  { at: NOW - 30 * HOUR, minutes: 42, code: 'network' },
  { at: NOW - 15 * HOUR, minutes: 33, code: 'http_429' },
];

/** intervalSec が 60 になっている区間 */
const DENSE_WINDOW = { from: NOW - 2.5 * DAY, to: NOW - 2.1 * DAY };

/**
 * @param {number} t
 * @returns {{skip:boolean, error:string|null, intervalSec:number}}
 */
function tickShape(t) {
  for (const g of GAP_WINDOWS) {
    if (t >= g.at && t < g.at + g.minutes * MIN) return { skip: true, error: null, intervalSec: 180 };
  }
  let error = null;
  for (const e of ERROR_WINDOWS) {
    if (t >= e.at && t < e.at + e.minutes * MIN) error = e.code;
  }
  const intervalSec = t >= DENSE_WINDOW.from && t < DENSE_WINDOW.to ? 60 : 180;
  return { skip: false, error, intervalSec };
}

/** @type {Record<string, any[]>} */
const DB = {};
for (const k of SERIES_KEYS) DB[k] = [];

(function generate() {
  let t = RANGE_START;
  let guard = 0;
  while (t <= NOW && guard++ < 200000) {
    const shape = tickShape(t);
    if (!shape.skip) {
      for (const key of SERIES_KEYS) {
        const [provider, win] = key.split('/');
        if (shape.error) {
          DB[key].push({
            observedAt: t,
            provider,
            window: win,
            usedPercent: null,
            resetsAt: null,
            status: 'error',
            errorCode: shape.error,
            intervalSec: shape.intervalSec,
          });
        } else {
          const v = valueAt(key, t);
          DB[key].push({
            observedAt: t,
            provider,
            window: win,
            usedPercent: v.usedPercent,
            resetsAt: v.resetsAt,
            status: 'ok',
            errorCode: null,
            intervalSec: shape.intervalSec,
          });
        }
      }
    }
    // 次の tick までの間隔（密な区間は 60 秒）
    t += (t >= DENSE_WINDOW.from && t < DENSE_WINDOW.to ? 60 : 180) * 1000;
  }
})();

const MAX_ROWS = 50000;

/**
 * 範囲外の直前 1 点・直後 1 点を含めて返す。
 * @param {any[]} rows
 * @param {number} from
 * @param {number} to
 */
function sliceWithNeighbors(rows, from, to) {
  let lo = 0;
  while (lo < rows.length && rows[lo].observedAt < from) lo++;
  let hi = rows.length;
  while (hi > lo && rows[hi - 1].observedAt > to) hi--;
  const start = Math.max(0, lo - 1);
  const end = Math.min(rows.length, hi + 1);
  return rows.slice(start, end);
}

/**
 * @param {any[]} rows
 */
function decimate(rows) {
  if (rows.length <= MAX_ROWS) return { rows, decimated: false };
  const stride = Math.ceil(rows.length / MAX_ROWS);
  const out = rows.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return { rows: out, decimated: true };
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} baseDir
 * @param {string} rel
 */
function sendFile(res, baseDir, rel) {
  const safe = path.normalize(rel).replace(/^([/\\]|\.\.[/\\])+/, '');
  const full = path.join(baseDir, safe);
  if (!full.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/meta') {
    sendJson(res, 200, {
      providers: ['claude', 'codex'],
      windows: ['5h', 'weekly'],
      pollIntervalSec: POLL_INTERVAL_SEC,
      now: Date.now(),
      dbPath: 'C:\\Users\\dev\\AppData\\Roaming\\quota-trail\\quota-trail.sqlite (dev fake)',
    });
    return;
  }

  if (pathname === '/api/samples') {
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      sendJson(res, 400, { error: 'from/to required' });
      return;
    }
    /** @type {Record<string, any[]>} */
    const series = {};
    let decimated = false;
    for (const key of SERIES_KEYS) {
      const d = decimate(sliceWithNeighbors(DB[key], from, to));
      series[key] = d.rows;
      decimated = decimated || d.decimated;
    }
    sendJson(res, 200, { series, now: Date.now(), decimated });
    return;
  }

  if (pathname === '/api/latest') {
    /** @type {Record<string, any>} */
    const series = {};
    for (const key of SERIES_KEYS) {
      const rows = DB[key];
      series[key] = rows.length ? rows[rows.length - 1] : null;
    }
    sendJson(res, 200, { series, now: Date.now() });
    return;
  }

  if (pathname.startsWith('/shared/')) {
    sendFile(res, SHARED_DIR, pathname.slice('/shared/'.length));
    return;
  }

  sendFile(res, RENDERER_DIR, pathname === '/' ? 'index.html' : pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  const total = SERIES_KEYS.reduce((n, k) => n + DB[k].length, 0);
  process.stdout.write(
    `quota-trail dev renderer\n` +
      `  URL   : http://127.0.0.1:${PORT}/\n` +
      `  データ : ${total} 行 / 4 系列（${new Date(RANGE_START).toLocaleString()} 〜 ${new Date(NOW).toLocaleString()}）\n` +
      `  欠測  : ${GAP_WINDOWS.length} 箇所, error 区間 ${ERROR_WINDOWS.length} 箇所, intervalSec=60 の区間 1 箇所\n`,
  );
});
