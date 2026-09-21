/**
 * ダッシュボードの状態管理・データ取得・イベント処理（設計書 §7）。
 * @module renderer/app
 */

import { computeGaps } from '/shared/gaps.mjs';
import { formatDateTime, formatClockLabel } from '/shared/ticks.mjs';
import { chooseAccountSelection } from '/shared/account-selection.mjs';
import { SERIES, SERIES_KEYS } from './theme.mjs';
import { drawChart, xToTime, nearestSample } from './chart.mjs';

/** @typedef {import('/shared/gaps.mjs').Sample} Sample */
/** @typedef {import('./theme.mjs').SeriesKey} SeriesKey */

const STORAGE_KEY = 'quota-trail.ui.v2';
const LEGACY_STORAGE_KEY = 'quota-trail.ui.v1';
const PROVIDERS = ['claude', 'codex'];
const MIN_RANGE_MS = 60 * 1000;
const GAP_FACTOR = 2.5;
const FOLLOW_INTERVAL_MS = 60_000;
const FETCH_DEBOUNCE_MS = 150;

const PERIODS = /** @type {const} */ ([
  ['24h', '24時間', 24 * 60 * 60 * 1000],
  ['7d', '7日間', 7 * 24 * 60 * 60 * 1000],
  ['30d', '30日間', 30 * 24 * 60 * 60 * 1000],
  ['custom', 'カスタム', 0],
]);

/** @typedef {{mode:'line'|'bar',points:boolean}} PanelState */
/** @typedef {{key:SeriesKey,root:HTMLElement,canvas:HTMLCanvasElement,periodSel:HTMLSelectElement,modeSel:HTMLSelectElement,pointsSel:HTMLSelectElement,rect:{x:number,y:number,w:number,h:number}|null,hover:{x:number,y:number}|null}} Panel */

const state = {
  /** @type {'24h'|'7d'|'30d'|'custom'} */
  period: '24h',
  custom: { from: Date.now() - 24 * 60 * 60 * 1000, to: Date.now() },
  /** @type {Record<string, PanelState>} */
  panels: {},
  now: Date.now(),
  /** @type {Record<string, Sample[]>} */
  data: {},
  /** @type {Record<string, Sample|null>} */
  latest: {},
  /** @type {Record<string, any>} */
  accountGroups: {},
  /** @type {Record<string, string|null>} */
  selectedAccounts: { claude: null, codex: null },
  /** @type {Record<string, string>} */
  savedSelections: {},
  /** @type {{pollIntervalSec:number,backend:string,accountDimensionAvailable:boolean,canRevealAccountIdentifiers:boolean}|null} */
  meta: null,
  decimated: false,
  error: null,
};

for (const key of SERIES_KEYS) {
  state.panels[key] = { mode: 'line', points: true };
  state.data[key] = [];
  state.latest[key] = null;
}

/** @type {Panel[]} */
const panels = [];
/** @type {Record<string, HTMLSelectElement>} */
const accountSelects = {};
/** @type {Record<string, HTMLElement>} */
const currentAccountNotes = {};
/** @type {Record<string, HTMLButtonElement>} */
const revealButtons = {};
/** @type {Record<string, HTMLElement>} */
const providerGroups = {};
/** @type {{dialog:HTMLDialogElement|null, controller:AbortController|null, opener:HTMLButtonElement|null}|null} */
let activeIdentifierDialog = null;
let revealGeneration = 0;

// ---------------------------------------------------------------- 永続化

/** @param {any} prefs */
function applyPanelPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  if (PERIODS.some(([id]) => id === prefs.period)) state.period = prefs.period;
  if (prefs.custom && Number.isFinite(prefs.custom.from) && Number.isFinite(prefs.custom.to) && prefs.custom.to > prefs.custom.from) {
    state.custom = { from: prefs.custom.from, to: prefs.custom.to };
  }
  if (prefs.panels && typeof prefs.panels === 'object') {
    for (const key of SERIES_KEYS) {
      const panel = prefs.panels[key];
      if (!panel) continue;
      if (panel.mode === 'line' || panel.mode === 'bar') state.panels[key].mode = panel.mode;
      if (typeof panel.points === 'boolean') state.panels[key].points = panel.points;
    }
  }
}

function loadPrefs() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = current ? null : localStorage.getItem(LEGACY_STORAGE_KEY);
    const prefs = JSON.parse(current ?? legacy ?? 'null');
    applyPanelPrefs(prefs);
    if (current && prefs?.selectedAccounts && typeof prefs.selectedAccounts === 'object') {
      for (const provider of PROVIDERS) {
        if (typeof prefs.selectedAccounts[provider] === 'string') state.savedSelections[provider] = prefs.selectedAccounts[provider];
      }
    }
  } catch {
    /* 壊れた保存値は使わない。 */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      period: state.period,
      custom: state.custom,
      panels: state.panels,
      selectedAccounts: state.savedSelections,
    }));
  } catch {
    /* プライベートモード等では保存できなくても表示を続ける。 */
  }
}

// ---------------------------------------------------------------- 範囲

/** @returns {{from:number,to:number}} */
function currentRange() {
  if (state.period === 'custom') return { from: state.custom.from, to: state.custom.to };
  const definition = PERIODS.find(([id]) => id === state.period);
  const span = definition ? definition[2] : 24 * 60 * 60 * 1000;
  return { from: state.now - span, to: state.now };
}

/** @param {number} from @param {number} to */
function setCustomRange(from, to) {
  const span = Math.max(MIN_RANGE_MS, to - from);
  state.custom = { from, to: from + span };
  state.period = 'custom';
  for (const panel of panels) panel.periodSel.value = 'custom';
  savePrefs();
  scheduleDraw();
  scheduleFetch();
}

// ---------------------------------------------------------------- 取得

let fetchTimer = 0;
let fetchSeq = 0;
/** @type {AbortController|null} */
let fetchController = null;

function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = window.setTimeout(() => { void fetchData(); }, FETCH_DEBOUNCE_MS);
}

async function fetchMeta() {
  try {
    const response = await fetch('/api/meta', { cache: 'no-store' });
    if (!response.ok) throw new Error('meta');
    const json = await response.json();
    state.meta = {
      pollIntervalSec: json.pollIntervalSec,
      backend: String(json.backend ?? ''),
      accountDimensionAvailable: json.accountDimensionAvailable !== false,
      canRevealAccountIdentifiers: json.canRevealAccountIdentifiers === true,
    };
    if (Number.isFinite(json.now)) state.now = json.now;
    if (!state.meta.canRevealAccountIdentifiers) discardIdentifierDialog();
  } catch {
    state.meta = null;
    discardIdentifierDialog();
  }
  renderFooter();
}

/** @returns {string} */
function selectorQuery() {
  const query = new URLSearchParams();
  for (const provider of PROVIDERS) {
    const key = state.selectedAccounts[provider];
    if (key) query.set(provider, key);
  }
  return query.toString();
}

async function fetchAccounts() {
  const response = await fetch('/api/accounts', { cache: 'no-store' });
  if (!response.ok) throw new Error('accounts');
  const json = await response.json();
  if (json.available === false) {
    state.accountGroups = {};
    configureAccountSelectors(true);
    return;
  }
  state.accountGroups = json.providers && typeof json.providers === 'object' ? json.providers : {};
  if (Number.isFinite(json.now)) state.now = json.now;
  const before = { ...state.selectedAccounts };
  configureAccountSelectors(false);
  for (const provider of PROVIDERS) {
    if (before[provider] !== state.selectedAccounts[provider]) {
      discardIdentifierDialog();
      clearProvider(provider);
    }
  }
  renderHeader();
  scheduleDraw();
}

async function fetchData() {
  const sequence = ++fetchSeq;
  fetchController?.abort();
  const controller = new AbortController();
  fetchController = controller;
  const { from, to } = currentRange();
  const query = selectorQuery();
  const suffix = query ? `&${query}` : '';
  for (const group of Object.values(providerGroups)) group.setAttribute('aria-busy', 'true');
  try {
    const [samplesResponse, latestResponse] = await Promise.all([
      fetch(`/api/samples?from=${Math.round(from)}&to=${Math.round(to)}${suffix}`, { cache: 'no-store', signal: controller.signal }),
      fetch(`/api/latest?${query}`, { cache: 'no-store', signal: controller.signal }),
    ]);
    if (!samplesResponse.ok || !latestResponse.ok) throw new Error('data');
    const [samplesJson, latestJson] = await Promise.all([samplesResponse.json(), latestResponse.json()]);
    if (sequence !== fetchSeq) return;
    for (const key of SERIES_KEYS) {
      const rows = Array.isArray(samplesJson.series?.[key]) ? samplesJson.series[key] : [];
      rows.sort((left, right) => left.observedAt - right.observedAt);
      state.data[key] = rows;
      state.latest[key] = latestJson.series?.[key] ?? null;
    }
    state.decimated = Boolean(samplesJson.decimated);
    state.error = null;
  } catch (error) {
    if (sequence !== fetchSeq || error?.name === 'AbortError') return;
    state.error = '取得に失敗しました';
  }
  if (sequence === fetchSeq) {
    for (const group of Object.values(providerGroups)) group.setAttribute('aria-busy', 'false');
    renderHeader();
    renderFooter();
    scheduleDraw();
  }
}

/** @param {string} provider */
function clearProvider(provider) {
  for (const key of SERIES_KEYS) {
    if (!key.startsWith(`${provider}/`)) continue;
    state.data[key] = [];
    state.latest[key] = null;
    const panel = panels.find((candidate) => candidate.key === key);
    if (panel) panel.hover = null;
  }
}

/** @param {string} provider @param {string} key */
function selectAccount(provider, key) {
  if (state.selectedAccounts[provider] === key) return;
  discardIdentifierDialog();
  clearProvider(provider);
  state.selectedAccounts[provider] = key;
  state.savedSelections[provider] = key;
  savePrefs();
  fetchController?.abort();
  fetchSeq += 1;
  renderHeader();
  scheduleDraw();
  void fetchData();
}

// ---------------------------------------------------------------- DOM 構築

/** @param {string} tag @param {string} [className] @param {string} [content] */
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

/** @param {{label:string,options:[string,string][],value:string}} spec */
function makeControl(spec) {
  const wrap = el('label', 'ctrl');
  wrap.appendChild(el('span', undefined, spec.label));
  const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  for (const [value, text] of spec.options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = spec.value;
  wrap.appendChild(select);
  return { wrap, select };
}

/** @param {SeriesKey} key @returns {Panel} */
function buildPanel(key) {
  const definition = SERIES[key];
  const panelState = state.panels[key];
  const root = el('section', 'panel');
  const head = el('div', 'panel-head');
  const title = el('div', 'panel-title');
  const dot = el('span', 'dot');
  dot.style.background = definition.color;
  title.append(dot, el('span', 't', definition.title));
  head.appendChild(title);
  const controls = el('div', 'panel-ctrls');
  const period = makeControl({ label: '集計期間', options: PERIODS.map(([id, label]) => [id, label]), value: state.period });
  const mode = makeControl({ label: 'グラフ形式', options: [['line', '折れ線'], ['bar', '棒グラフ']], value: panelState.mode });
  const points = makeControl({ label: 'プロットの表示', options: [['on', 'あり'], ['off', 'なし']], value: panelState.points ? 'on' : 'off' });
  controls.append(period.wrap, mode.wrap, points.wrap);
  head.appendChild(controls);
  root.append(head, el('div', 'panel-sub', '使用率（使った割合）%　0〜100'));
  const canvasWrap = el('div', 'canvas-wrap');
  const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
  canvasWrap.appendChild(canvas);
  root.appendChild(canvasWrap);
  const panel = { key, root, canvas, periodSel: period.select, modeSel: mode.select, pointsSel: points.select, rect: null, hover: null };
  period.select.addEventListener('change', () => {
    const value = /** @type {'24h'|'7d'|'30d'|'custom'} */ (period.select.value);
    if (value === 'custom') state.custom = currentRange();
    state.period = value;
    for (const other of panels) other.periodSel.value = value;
    savePrefs();
    scheduleDraw();
    scheduleFetch();
  });
  mode.select.addEventListener('change', () => {
    state.panels[key].mode = /** @type {'line'|'bar'} */ (mode.select.value);
    savePrefs();
    scheduleDraw();
  });
  points.select.addEventListener('change', () => {
    state.panels[key].points = points.select.value === 'on';
    savePrefs();
    scheduleDraw();
  });
  attachInteractions(panel);
  return panel;
}

/** @param {string} provider @returns {HTMLElement} */
function buildProviderGroup(provider) {
  const title = provider === 'claude' ? 'Claude Code' : 'Codex CLI';
  const section = el('section', 'provider-group');
  const headingId = `${provider}-heading`;
  section.setAttribute('aria-labelledby', headingId);
  const header = el('div', 'provider-header');
  const heading = el('h2', undefined, title);
  heading.id = headingId;
  const accountControl = el('div', 'account-control');
  const selectId = `${provider}-account`;
  const label = el('label', undefined, '表示アカウント:');
  label.htmlFor = selectId;
  const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  select.id = selectId;
  select.addEventListener('change', () => selectAccount(provider, select.value));
  const currentNote = el('span', 'current-account-note');
  currentNote.setAttribute('aria-live', 'polite');
  const reveal = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  reveal.type = 'button';
  reveal.className = 'reveal-button';
  reveal.textContent = '実IDを確認';
  reveal.hidden = true;
  reveal.addEventListener('click', () => { void revealIdentifier(provider, reveal); });
  accountControl.append(label, select, currentNote, reveal);
  header.append(heading, accountControl);
  const chartGrid = el('div', 'provider-chart-grid');
  for (const key of SERIES_KEYS.filter((seriesKey) => seriesKey.startsWith(`${provider}/`))) {
    const panel = buildPanel(key);
    panels.push(panel);
    chartGrid.appendChild(panel.root);
  }
  section.append(header, chartGrid);
  accountSelects[provider] = select;
  currentAccountNotes[provider] = currentNote;
  revealButtons[provider] = reveal;
  providerGroups[provider] = section;
  return section;
}

/** @param {boolean} unavailable */
function configureAccountSelectors(unavailable) {
  if (unavailable || !state.meta?.canRevealAccountIdentifiers) discardIdentifierDialog();
  for (const provider of PROVIDERS) {
    const select = accountSelects[provider];
    const note = currentAccountNotes[provider];
    const reveal = revealButtons[provider];
    if (!select || !note || !reveal) continue;
    select.textContent = '';
    if (unavailable) {
      const option = document.createElement('option');
      option.textContent = 'アカウント情報を利用できません';
      option.value = '';
      select.appendChild(option);
      select.disabled = true;
      note.textContent = 'DB移行未完了のためアカウント別表示は無効';
      reveal.hidden = true;
      continue;
    }
    const group = state.accountGroups[provider] ?? { resolution: 'pending', currentAccountKey: null, accounts: [] };
    const selected = chooseAccountSelection(group, state.savedSelections[provider]);
    state.selectedAccounts[provider] = selected;
    for (const account of group.accounts ?? []) {
      const option = document.createElement('option');
      option.value = account.accountKey;
      option.textContent = account.isCurrent ? `${account.label}（現在ログイン中）` : account.label;
      select.appendChild(option);
    }
    if (select.options.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'アカウントを確認中';
      select.appendChild(option);
    }
    select.disabled = !selected;
    select.value = selected ?? '';
    const current = (group.accounts ?? []).find((account) => account.accountKey === group.currentAccountKey);
    note.textContent = current && selected !== current.accountKey ? `現在ログイン中: ${current.label}` : '';
    reveal.hidden = !(state.meta?.canRevealAccountIdentifiers && selected && !selected.endsWith(':unknown'));
  }
}

// ---------------------------------------------------------------- 実 ID 確認

/** 設定変更・meta 失敗・世代変更時に実 ID の request と DOM を破棄する。 */
function discardIdentifierDialog() {
  revealGeneration += 1;
  const active = activeIdentifierDialog;
  activeIdentifierDialog = null;
  active?.controller?.abort();
  if (active?.dialog) {
    try {
      active.dialog.close();
    } catch {
      active.dialog.remove();
    }
    active.dialog.remove();
  }
}

/** @param {string} provider @param {HTMLButtonElement} opener */
async function revealIdentifier(provider, opener) {
  const account = state.selectedAccounts[provider];
  if (!account || !window.confirm('選択中のアカウントの実IDを確認しますか？')) return;
  discardIdentifierDialog();
  const generation = revealGeneration;
  const controller = new AbortController();
  activeIdentifierDialog = { dialog: null, controller, opener };
  try {
    const query = new URLSearchParams({ provider, account });
    const response = await fetch(`/api/account-identifier?${query}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('identifier');
    const json = await response.json();
    if (generation !== revealGeneration || !state.meta?.canRevealAccountIdentifiers) return;
    showIdentifierDialog(json.account, opener, controller);
  } catch {
    /* 実 ID が無い失敗を通常画面には出さない。 */
  } finally {
    if (generation === revealGeneration && activeIdentifierDialog?.dialog === null) {
      activeIdentifierDialog = null;
    }
  }
}

/** @param {{uuid?:string|null,email?:string|null}} account @param {HTMLButtonElement} opener @param {AbortController} controller */
function showIdentifierDialog(account, opener, controller) {
  const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
  dialog.className = 'identifier-dialog';
  const title = el('h2', undefined, '実IDの確認');
  const body = el('div', 'identifier-values');
  body.appendChild(el('p', undefined, account.uuid || 'UUID はありません'));
  body.appendChild(el('p', undefined, account.email || 'メールアドレスはありません'));
  const close = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  close.type = 'button';
  close.textContent = '閉じる';
  const dispose = () => {
    dialog.remove();
    if (activeIdentifierDialog?.dialog === dialog) activeIdentifierDialog = null;
    opener.focus();
  };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', dispose, { once: true });
  dialog.append(title, body, close);
  document.body.appendChild(dialog);
  activeIdentifierDialog = { dialog, controller, opener };
  dialog.showModal();
}

// ---------------------------------------------------------------- 操作

/** @param {Panel} panel */
function attachInteractions(panel) {
  const canvas = panel.canvas;
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!panel.rect) return;
    const bounds = canvas.getBoundingClientRect();
    const mouseX = Math.max(panel.rect.x, Math.min(panel.rect.x + panel.rect.w, event.clientX - bounds.left));
    const range = currentRange();
    const anchor = xToTime(mouseX, range.from, range.to, panel.rect);
    const span = Math.max(MIN_RANGE_MS, (range.to - range.from) * (event.deltaY < 0 ? 0.8 : 1.25));
    const ratio = (anchor - range.from) / (range.to - range.from);
    setCustomRange(anchor - ratio * span, anchor + (1 - ratio) * span);
  }, { passive: false });
  /** @type {{x:number,from:number,to:number,moved:boolean}|null} */
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !panel.rect) return;
    const range = currentRange();
    drag = { x: event.clientX, from: range.from, to: range.to, moved: false };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (event) => {
    const bounds = canvas.getBoundingClientRect();
    if (drag && panel.rect) {
      const deltaX = event.clientX - drag.x;
      if (Math.abs(deltaX) > 2) drag.moved = true;
      if (drag.moved) {
        const shift = (deltaX / panel.rect.w) * (drag.to - drag.from);
        panel.hover = null;
        setCustomRange(drag.from - shift, drag.to - shift);
        return;
      }
    }
    panel.hover = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    scheduleDraw();
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'crosshair';
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer が既に解放済みでも問題にしない。 */
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    panel.hover = null;
    scheduleDraw();
  });
}

/** @param {SeriesKey} key @returns {number|null} */
function nextResetAtFor(key) {
  const latest = state.latest[key];
  if (latest?.status === 'ok' && Number.isFinite(latest.resetsAt)) return latest.resetsAt;
  for (const sample of [...(state.data[key] ?? [])].reverse()) {
    if (sample.status === 'ok' && Number.isFinite(sample.resetsAt)) return sample.resetsAt;
  }
  return null;
}

// ---------------------------------------------------------------- 描画

let frame = 0;

function scheduleDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const range = currentRange();
    const now = state.period === 'custom' ? Math.max(state.now, Date.now()) : state.now;
    for (const panel of panels) {
      const definition = SERIES[panel.key];
      const samples = state.data[panel.key] ?? [];
      panel.rect = drawChart(panel.canvas, {
        samples,
        from: range.from,
        to: range.to,
        now,
        gaps: computeGaps(samples, { from: range.from, to: range.to, now, factor: GAP_FACTOR }),
        color: definition.color,
        legendLabel: definition.legend,
        mode: state.panels[panel.key].mode,
        showPoints: state.panels[panel.key].points,
        hover: panel.hover,
        nextResetAt: nextResetAtFor(panel.key),
      });
    }
  });
}

function renderHeader() {
  const box = document.getElementById('currentValues');
  const lastFetch = document.getElementById('lastFetch');
  if (!box || !lastFetch) return;
  box.textContent = '';
  let newest = 0;
  for (const key of SERIES_KEYS) {
    const definition = SERIES[key];
    const sample = state.latest[key];
    const item = el('span', 'current-value');
    const dot = el('span', 'dot');
    dot.style.background = definition.color;
    item.append(dot, el('span', undefined, definition.short));
    item.appendChild(el('b', undefined, sample?.status === 'ok' && sample.usedPercent != null ? `${Math.round(sample.usedPercent)}%` : '--'));
    if (sample?.status !== 'ok') item.classList.add('is-error');
    const resetAt = nextResetAtFor(key);
    if (resetAt != null) item.appendChild(el('span', 'reset-suffix', ` · リセット ${formatClockLabel(resetAt, state.now)}`));
    if (Number.isFinite(sample?.observedAt)) newest = Math.max(newest, sample.observedAt);
    box.appendChild(item);
  }
  lastFetch.textContent = newest ? `最終取得 ${formatDateTime(newest)}` : '最終取得 —';
}

function renderFooter() {
  const info = document.getElementById('footerInfo');
  const note = document.getElementById('footerNote');
  if (!info || !note) return;
  if (state.meta) {
    info.textContent = `取得間隔 ${state.meta.pollIntervalSec} 秒　DB: quota-trail.sqlite　${state.meta.backend}`;
  } else {
    info.textContent = 'メタ情報を取得できません';
  }
  const notes = [];
  if (state.decimated) notes.push('表示件数が多いため間引き表示中');
  if (state.error) notes.push(state.error);
  note.textContent = notes.join('　');
}

async function main() {
  loadPrefs();
  const groups = document.getElementById('providerGroups');
  if (!groups) return;
  for (const provider of PROVIDERS) groups.appendChild(buildProviderGroup(provider));
  const observer = new ResizeObserver(() => scheduleDraw());
  for (const panel of panels) observer.observe(panel.canvas.parentElement ?? panel.canvas);
  window.addEventListener('resize', scheduleDraw);
  renderHeader();
  renderFooter();
  scheduleDraw();
  await fetchMeta();
  try {
    await fetchAccounts();
  } catch {
    configureAccountSelectors(false);
  }
  void fetchData();
  setInterval(() => {
    void (async () => {
      await fetchMeta();
      try {
        await fetchAccounts();
      } catch {
        /* 一時的な一覧取得失敗では現在の選択を残す。 */
      }
      await fetchData();
    })();
  }, FOLLOW_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void main(); });
} else {
  void main();
}

// @ts-ignore
window.__quotaTrail = { state, panels, nearestSample };
