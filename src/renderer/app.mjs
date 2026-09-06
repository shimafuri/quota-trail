/**
 * ダッシュボードの状態管理・データ取得・イベント処理（設計 §7.1〜§7.3）。
 * @module renderer/app
 */

import { computeGaps } from '/shared/gaps.mjs';
import { formatDateTime } from '/shared/ticks.mjs';
import { SERIES, SERIES_KEYS } from './theme.mjs';
import { drawChart, xToTime, nearestSample } from './chart.mjs';

/** @typedef {import('/shared/gaps.mjs').Sample} Sample */
/** @typedef {import('./theme.mjs').SeriesKey} SeriesKey */

const STORAGE_KEY = 'quota-trail.ui.v1';
const MIN_RANGE_MS = 30 * 60 * 1000; // 30 分
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 日
const GAP_FACTOR = 2.5;
const FOLLOW_INTERVAL_MS = 60_000;
const FETCH_DEBOUNCE_MS = 150;

const PERIODS = /** @type {const} */ ([
  ['24h', '24時間', 24 * 60 * 60 * 1000],
  ['7d', '7日間', 7 * 24 * 60 * 60 * 1000],
  ['30d', '30日間', 30 * 24 * 60 * 60 * 1000],
  ['custom', 'カスタム', 0],
]);

/**
 * @typedef {Object} PanelState
 * @property {'line'|'bar'} mode
 * @property {boolean} points
 */

/**
 * @typedef {Object} Panel
 * @property {SeriesKey} key
 * @property {HTMLElement} root
 * @property {HTMLCanvasElement} canvas
 * @property {HTMLSelectElement} periodSel
 * @property {HTMLSelectElement} modeSel
 * @property {HTMLSelectElement} pointsSel
 * @property {{x:number,y:number,w:number,h:number}|null} rect 最後に描いたプロット矩形
 * @property {{x:number,y:number}|null} hover
 */

const state = {
  /** @type {'24h'|'7d'|'30d'|'custom'} */
  period: '24h',
  /** @type {{from:number,to:number}} */
  custom: { from: Date.now() - 24 * 60 * 60 * 1000, to: Date.now() },
  /** @type {Record<string, PanelState>} */
  panels: {},
  now: Date.now(),
  /** @type {Record<string, Sample[]>} */
  data: {},
  /** @type {Record<string, Sample|null>} */
  latest: {},
  /** @type {{pollIntervalSec:number, dbPath:string}|null} */
  meta: null,
  decimated: false,
  /** @type {string|null} */
  error: null,
};

for (const key of SERIES_KEYS) {
  state.panels[key] = { mode: 'line', points: true };
  state.data[key] = [];
  state.latest[key] = null;
}

/** @type {Panel[]} */
const panels = [];

// ---------------------------------------------------------------- 永続化

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (PERIODS.some(([id]) => id === o.period)) state.period = o.period;
      if (
        o.custom &&
        Number.isFinite(o.custom.from) &&
        Number.isFinite(o.custom.to) &&
        o.custom.to > o.custom.from
      ) {
        state.custom = { from: o.custom.from, to: o.custom.to };
      }
      if (o.panels && typeof o.panels === 'object') {
        for (const key of SERIES_KEYS) {
          const p = o.panels[key];
          if (!p) continue;
          if (p.mode === 'line' || p.mode === 'bar') state.panels[key].mode = p.mode;
          if (typeof p.points === 'boolean') state.panels[key].points = p.points;
        }
      }
    }
  } catch {
    /* 壊れていれば既定値のまま */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ period: state.period, custom: state.custom, panels: state.panels }),
    );
  } catch {
    /* プライベートモード等では無視 */
  }
}

// ---------------------------------------------------------------- 範囲

/** @returns {{from:number,to:number}} */
function currentRange() {
  if (state.period === 'custom') return { from: state.custom.from, to: state.custom.to };
  const def = PERIODS.find(([id]) => id === state.period);
  const span = def ? def[2] : 24 * 60 * 60 * 1000;
  return { from: state.now - span, to: state.now };
}

/**
 * ズーム / パンの結果を「カスタム」として 4 パネルに反映する。
 * @param {number} from
 * @param {number} to
 */
function setCustomRange(from, to) {
  let span = Math.max(MIN_RANGE_MS, Math.min(MAX_RANGE_MS, to - from));
  let t = from + span;
  const maxTo = Date.now() + span * 0.05;
  if (t > maxTo) t = maxTo;
  state.custom = { from: t - span, to: t };
  state.period = 'custom';
  for (const p of panels) p.periodSel.value = 'custom';
  savePrefs();
  scheduleDraw();
  scheduleFetch();
}

// ---------------------------------------------------------------- 取得

/** @type {number} */
let fetchTimer = 0;
let fetchSeq = 0;

function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = window.setTimeout(fetchSamples, FETCH_DEBOUNCE_MS);
}

async function fetchMeta() {
  try {
    const res = await fetch('/api/meta', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.meta = { pollIntervalSec: json.pollIntervalSec, dbPath: json.dbPath };
    if (Number.isFinite(json.now)) state.now = json.now;
  } catch (e) {
    state.meta = null;
  }
  renderFooter();
}

async function fetchSamples() {
  const seq = ++fetchSeq;
  const { from, to } = currentRange();
  try {
    const res = await fetch(
      `/api/samples?from=${Math.round(from)}&to=${Math.round(to)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (seq !== fetchSeq) return; // 古い応答は捨てる
    for (const key of SERIES_KEYS) {
      const rows = (json.series && json.series[key]) || [];
      rows.sort((/** @type {Sample} */ a, /** @type {Sample} */ b) => a.observedAt - b.observedAt);
      state.data[key] = rows;
    }
    state.decimated = Boolean(json.decimated);
    state.error = null;
  } catch (e) {
    if (seq !== fetchSeq) return;
    state.error = String((e && /** @type {Error} */ (e).message) || e);
  }
  renderFooter();
  scheduleDraw();
}

async function fetchLatest() {
  try {
    const res = await fetch('/api/latest', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    for (const key of SERIES_KEYS) {
      state.latest[key] = (json.series && json.series[key]) || null;
    }
  } catch {
    /* ヘッダの表示だけなので握りつぶす */
  }
  renderHeader();
}

// ---------------------------------------------------------------- DOM 構築

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {{label:string, options:[string,string][], value:string}} spec
 */
function makeControl(spec) {
  const wrap = el('label', 'ctrl');
  wrap.appendChild(el('span', undefined, spec.label));
  const sel = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  sel.title = spec.label;
  for (const [value, text] of spec.options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    sel.appendChild(opt);
  }
  sel.value = spec.value;
  wrap.appendChild(sel);
  return { wrap, sel };
}

/**
 * @param {SeriesKey} key
 * @returns {Panel}
 */
function buildPanel(key) {
  const def = SERIES[key];
  const ps = state.panels[key];

  const root = el('section', 'panel');
  const head = el('div', 'panel-head');

  const title = el('div', 'panel-title');
  const dot = el('span', 'dot');
  dot.style.background = def.color;
  title.appendChild(dot);
  title.appendChild(el('span', 't', def.title));
  head.appendChild(title);

  const ctrls = el('div', 'panel-ctrls');
  const period = makeControl({
    label: '集計期間',
    options: PERIODS.map(([id, label]) => [id, label]),
    value: state.period,
  });
  const mode = makeControl({
    label: 'グラフ形式',
    options: [
      ['line', '折れ線'],
      ['bar', '棒グラフ'],
    ],
    value: ps.mode,
  });
  const points = makeControl({
    label: 'プロットの表示',
    options: [
      ['on', 'あり'],
      ['off', 'なし'],
    ],
    value: ps.points ? 'on' : 'off',
  });
  ctrls.append(period.wrap, mode.wrap, points.wrap);
  head.appendChild(ctrls);
  root.appendChild(head);

  root.appendChild(el('div', 'panel-sub', '使用率（使った割合）%　0〜100'));

  const wrap = el('div', 'canvas-wrap');
  const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
  wrap.appendChild(canvas);
  root.appendChild(wrap);

  /** @type {Panel} */
  const panel = {
    key,
    root,
    canvas,
    periodSel: period.sel,
    modeSel: mode.sel,
    pointsSel: points.sel,
    rect: null,
    hover: null,
  };

  period.sel.addEventListener('change', () => {
    const v = /** @type {'24h'|'7d'|'30d'|'custom'} */ (period.sel.value);
    if (v === 'custom') {
      // 直接「カスタム」を選んだときは現在の範囲をそのまま固定する
      const r = currentRange();
      state.custom = { from: r.from, to: r.to };
    }
    state.period = v;
    for (const p of panels) p.periodSel.value = v; // 全パネル連動
    savePrefs();
    scheduleDraw();
    scheduleFetch();
  });
  mode.sel.addEventListener('change', () => {
    state.panels[key].mode = /** @type {'line'|'bar'} */ (mode.sel.value);
    savePrefs();
    scheduleDraw();
  });
  points.sel.addEventListener('change', () => {
    state.panels[key].points = points.sel.value === 'on';
    savePrefs();
    scheduleDraw();
  });

  attachInteractions(panel);
  return panel;
}

/**
 * ホイールズーム / ドラッグパン / ホバー。
 * @param {Panel} panel
 */
function attachInteractions(panel) {
  const canvas = panel.canvas;

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = panel.rect;
      if (!rect) return;
      const box = canvas.getBoundingClientRect();
      const mx = Math.max(rect.x, Math.min(rect.x + rect.w, ev.clientX - box.left));
      const { from, to } = currentRange();
      const anchor = xToTime(mx, from, to, rect);
      const factor = ev.deltaY < 0 ? 0.8 : 1.25;
      const span = Math.max(MIN_RANGE_MS, Math.min(MAX_RANGE_MS, (to - from) * factor));
      const ratio = (anchor - from) / (to - from);
      const nf = anchor - ratio * span;
      setCustomRange(nf, nf + span);
    },
    { passive: false },
  );

  /** @type {{x:number, from:number, to:number, moved:boolean}|null} */
  let drag = null;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !panel.rect) return;
    const r = currentRange();
    drag = { x: ev.clientX, from: r.from, to: r.to, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (ev) => {
    const box = canvas.getBoundingClientRect();
    if (drag && panel.rect) {
      const dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 2) drag.moved = true;
      if (drag.moved) {
        const span = drag.to - drag.from;
        const shift = (dx / panel.rect.w) * span;
        panel.hover = null;
        setCustomRange(drag.from - shift, drag.to - shift);
        return;
      }
    }
    panel.hover = { x: ev.clientX - box.left, y: ev.clientY - box.top };
    scheduleDraw();
  });

  const endDrag = (/** @type {PointerEvent} */ ev) => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'crosshair';
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    panel.hover = null;
    scheduleDraw();
  });
}

// ---------------------------------------------------------------- 描画

let rafId = 0;

function scheduleDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    drawAll();
  });
}

function drawAll() {
  const { from, to } = currentRange();
  const now = state.period === 'custom' ? Math.max(state.now, Date.now()) : state.now;
  for (const panel of panels) {
    const def = SERIES[panel.key];
    const samples = state.data[panel.key] || [];
    const ps = state.panels[panel.key];
    const gaps = computeGaps(samples, { from, to, now, factor: GAP_FACTOR });
    panel.rect = drawChart(panel.canvas, {
      samples,
      from,
      to,
      now,
      gaps,
      color: def.color,
      legendLabel: def.legend,
      mode: ps.mode,
      showPoints: ps.points,
      hover: panel.hover,
    });
  }
}

function renderHeader() {
  const box = document.getElementById('currentValues');
  const lf = document.getElementById('lastFetch');
  if (!box || !lf) return;
  box.textContent = '';
  let newest = 0;
  for (const key of SERIES_KEYS) {
    const def = SERIES[key];
    const s = state.latest[key];
    const item = el('span', 'current-value');
    const dot = el('span', 'dot');
    dot.style.background = def.color;
    item.appendChild(dot);
    item.appendChild(el('span', undefined, def.short));
    if (s && s.status === 'ok' && s.usedPercent != null) {
      const b = el('b', undefined, `${Math.round(s.usedPercent)}%`);
      item.appendChild(b);
    } else {
      item.classList.add('is-error');
      item.appendChild(el('b', undefined, '--'));
      if (s && s.errorCode) item.title = s.errorCode;
    }
    if (s && Number.isFinite(s.observedAt)) newest = Math.max(newest, s.observedAt);
    box.appendChild(item);
  }
  lf.textContent = newest ? `最終取得 ${formatDateTime(newest)}` : '最終取得 —';
}

function renderFooter() {
  const info = document.getElementById('footerInfo');
  const note = document.getElementById('footerNote');
  if (!info || !note) return;
  if (state.meta) {
    info.textContent = `取得間隔 ${state.meta.pollIntervalSec} 秒　DB: ${state.meta.dbPath}`;
  } else {
    info.textContent = 'メタ情報を取得できません';
  }
  const notes = [];
  if (state.decimated) notes.push('表示件数が多いため間引き表示中');
  if (state.error) notes.push(`取得エラー: ${state.error}`);
  note.textContent = notes.join('　');
}

// ---------------------------------------------------------------- 起動

function main() {
  loadPrefs();

  const grid = /** @type {HTMLElement} */ (document.getElementById('grid'));
  for (const key of SERIES_KEYS) {
    const panel = buildPanel(key);
    panels.push(panel);
    grid.appendChild(panel.root);
  }

  const ro = new ResizeObserver(() => scheduleDraw());
  for (const p of panels) ro.observe(p.canvas.parentElement || p.canvas);
  window.addEventListener('resize', scheduleDraw);

  renderHeader();
  renderFooter();
  scheduleDraw();

  fetchMeta();
  fetchSamples();
  fetchLatest();

  // 24h / 7d / 30d は now に追従（カスタムは固定）
  setInterval(() => {
    state.now = Date.now();
    if (state.period !== 'custom') {
      fetchSamples();
    }
    fetchLatest();
  }, FOLLOW_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

// デバッグ用（Chrome の devtools から状態を覗けるように）
// @ts-ignore
window.__quotaTrail = { state, panels, nearestSample };
