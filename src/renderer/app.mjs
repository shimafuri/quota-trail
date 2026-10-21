/**
 * ダッシュボードの状態管理・データ取得・イベント処理（設計書 §7）。
 * アカウントメニューは匿名トリガーとカスタム listbox で構成する（アカウントメニュー設計書 §2 / §4 / §6）。
 * 実 ID は専用メモリキャッシュと、開いている listbox の option text node にだけ存在させる。
 * @module renderer/app
 */

import { computeGaps, computeAuthGaps } from '/shared/gaps.mjs';
import { formatDateTime, formatClockLabel } from '/shared/ticks.mjs';
import { chooseAccountSelection, isAccountSelectionChange } from '/shared/account-selection.mjs';
import { policyEventsForProvider } from '/shared/policy-events.mjs';
import {
  ACCOUNT_DIMENSION_UNAVAILABLE_TEXT,
  IDENTIFIER_PREPARING_TEXT,
  buildAccountMenuRows,
  buildClosedTriggerLabel,
  computeMenuPlacement,
  findTypeaheadIndex,
  isAnchorVisible,
  moveActiveIndex,
  updateTypeaheadBuffer,
} from '/shared/account-menu.mjs';
import { SERIES, SERIES_KEYS } from './theme.mjs';
import { drawChart, xToTime, nearestSample } from './chart.mjs';

/** @typedef {import('/shared/gaps.mjs').Sample} Sample */
/** @typedef {import('./theme.mjs').SeriesKey} SeriesKey */
/** @typedef {import('/shared/account-menu.mjs').AccountMenuRow} AccountMenuRow */

const STORAGE_KEY = 'quota-trail.ui.v2';
const LEGACY_STORAGE_KEY = 'quota-trail.ui.v1';
const PROVIDERS = ['claude', 'codex'];
const MIN_RANGE_MS = 60 * 1000;
const GAP_FACTOR = 2.5;
const FOLLOW_INTERVAL_MS = 60_000;
const FETCH_DEBOUNCE_MS = 150;

/** 実 ID の先読みを待つ上限（アカウントメニュー設計書 §3.6）。 */
const IDENTIFIER_PREFETCH_TIMEOUT_MS = 2_000;

/** 取得に失敗したとき直前の成功値を使い続けてよい上限（アカウントメニュー設計書 §3.6）。 */
const IDENTIFIER_STALE_LIMIT_MS = 5 * 60 * 1000;

/** 実 ID batch endpoint が要求するヘッダ名（アカウントメニュー設計書 §3.2）。 */
const IDENTIFIER_TOKEN_HEADER = 'X-Quota-Trail-Identifier-Token';

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
  /** サーバーが生データから計算した認証区間（設計書 §15.6）。無ければ null
   * @type {Record<string, import('/shared/gaps.mjs').AuthGap[]|null>} */
  authGaps: {},
  /** @type {Record<string, any>} */
  accountGroups: {},
  /** @type {Record<string, string|null>} */
  selectedAccounts: { claude: null, codex: null },
  /** @type {Record<string, string>} */
  savedSelections: {},
  /** @type {{pollIntervalSec:number,backend:string,accountDimensionAvailable:boolean,canRevealAccountIdentifiersInAccountMenu:boolean}|null} */
  meta: null,
  accountsAvailable: true,
  decimated: false,
  error: null,
};

for (const key of SERIES_KEYS) {
  state.panels[key] = { mode: 'line', points: true };
  state.data[key] = [];
  state.latest[key] = null;
  state.authGaps[key] = null;
}

/** 認証区間 overlay を出す系列（Claude 3 系列のみ） */
const AUTH_GAP_KEYS = new Set(['claude/5h', 'claude/weekly', 'claude/weekly-fable']);

/** 選択中 account の最新行がこれらなら現在値に理由を出す（設計書 §15.6） */
const AUTH_REASON_TEXT = Object.freeze({
  auth_expired_local: '認証期限切れ',
  auth_expiring: '期限間近',
  auth_expired: '認証エラー',
});

/**
 * アカウントメニュー 1 つ分の controller。
 * `rows` は listbox が開いている間だけ実 ID を含み、閉じるときに捨てる。
 * @typedef {Object} AccountMenu
 * @property {string} provider
 * @property {HTMLButtonElement} button
 * @property {HTMLElement} status
 * @property {string} labelId
 * @property {string} listboxId
 * @property {HTMLElement|null} listbox
 * @property {AccountMenuRow[]} rows
 * @property {number} activeIndex
 * @property {string} typeaheadBuffer
 * @property {number} typeaheadAt
 * @property {(() => void)|null} detach
 */

/** @type {Panel[]} */
const panels = [];
/** @type {Record<string, AccountMenu>} */
const accountMenus = {};
/** @type {Record<string, HTMLElement>} */
const currentAccountNotes = {};
/** @type {Record<string, HTMLElement>} */
const providerGroups = {};

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
      canRevealAccountIdentifiersInAccountMenu: json.canRevealAccountIdentifiersInAccountMenu === true,
    };
    if (Number.isFinite(json.now)) state.now = json.now;
    if (!state.meta.canRevealAccountIdentifiersInAccountMenu) {
      purgeIdentifierCache();
    }
  } catch {
    state.meta = null;
    purgeIdentifierCache();
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
  // listbox を開いている間は account DTO の反映を保留する（アカウントメニュー設計書 §3.6）。
  if (openMenuProvider !== null) {
    pendingAccountsPayload = json;
    return;
  }
  applyAccountsPayload(json);
}

/**
 * `/api/accounts` の匿名応答を画面へ反映する。
 * nonce を受け取った時点で実 ID の先読みを始める（アカウントメニュー設計書 §3.6）。
 * @param {any} json  `/api/accounts` の応答
 * @returns {void}
 */
function applyAccountsPayload(json) {
  if (json?.available === false) {
    state.accountsAvailable = false;
    state.accountGroups = {};
    purgeIdentifierCache();
    renderAccountControls();
    return;
  }
  state.accountsAvailable = true;
  state.accountGroups = json?.providers && typeof json.providers === 'object' ? json.providers : {};
  if (Number.isFinite(json?.now)) state.now = json.now;
  const token = typeof json?.identifierAccessToken === 'string' ? json.identifierAccessToken : null;
  const before = { ...state.selectedAccounts };
  chooseAccountSelections();
  dropUnknownIdentifierKeys();
  renderAccountControls();
  for (const provider of PROVIDERS) {
    if (before[provider] !== state.selectedAccounts[provider]) {
      clearProvider(provider);
    }
  }
  updateIdentifierAccessToken(token);
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
      state.authGaps[key] = Array.isArray(samplesJson.authGaps?.[key]) ? samplesJson.authGaps[key] : null;
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
    state.authGaps[key] = null;
    const panel = panels.find((candidate) => candidate.key === key);
    if (panel) panel.hover = null;
  }
}

/** @param {string} provider @param {string} key */
function selectAccount(provider, key) {
  if (!isAccountSelectionChange(state.selectedAccounts[provider], key)) return;
  clearProvider(provider);
  state.selectedAccounts[provider] = key;
  state.savedSelections[provider] = key;
  savePrefs();
  fetchController?.abort();
  fetchSeq += 1;
  renderAccountControls();
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
  const labelId = `${provider}-account-label`;
  const listboxId = `${provider}-account-listbox`;
  const buttonId = `${provider}-account-trigger`;
  const label = el('label', 'account-control-label', '表示アカウント:');
  label.id = labelId;
  // 閉じたトリガーは匿名 button であり、実 ID を持つ DOM は一切作らない。
  const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  button.type = 'button';
  button.id = buttonId;
  button.className = 'account-trigger';
  button.disabled = true;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', listboxId);
  button.setAttribute('aria-labelledby', `${labelId} ${buttonId}`);
  const status = el('span', 'account-status');
  status.setAttribute('aria-live', 'polite');
  const currentNote = el('span', 'current-account-note');
  currentNote.setAttribute('aria-live', 'polite');
  accountControl.append(label, button, status, currentNote);
  header.append(heading, accountControl);
  accountMenus[provider] = {
    provider,
    button,
    status,
    labelId,
    listboxId,
    listbox: null,
    rows: [],
    activeIndex: -1,
    typeaheadBuffer: '',
    typeaheadAt: 0,
    detach: null,
  };
  button.addEventListener('click', () => toggleAccountMenu(provider));
  button.addEventListener('keydown', (event) => onTriggerKeyDown(provider, event));
  button.addEventListener('focus', () => { void retryIdentifiersIfNeeded(); });
  const chartGrid = el('div', 'provider-chart-grid');
  for (const key of SERIES_KEYS.filter((seriesKey) => seriesKey.startsWith(`${provider}/`))) {
    const panel = buildPanel(key);
    panels.push(panel);
    chartGrid.appendChild(panel.root);
  }
  section.append(header, chartGrid);
  currentAccountNotes[provider] = currentNote;
  providerGroups[provider] = section;
  return section;
}

// ---------------------------------------------------------------- 実 ID 専用キャッシュ

/**
 * 実 ID の専用メモリキャッシュ（アカウントメニュー設計書 §3.6 / §4.1）。
 * 中央の `state`、panel state、永続化対象からは完全に分離する。
 * 鍵は匿名 `accountKey` だけとする。
 * @type {Map<string, {kind:'email'|'uuid', value:string}>}
 */
const identifierCache = new Map();

/** 直近に成功した batch 取得の時刻。 */
let identifierUpdatedAt = 0;

/** 一度でも batch 取得に成功したか。 */
let identifiersLoaded = false;

/** `/api/accounts` から受け取った process-scoped nonce。 */
let identifierAccessToken = null;

/** @type {AbortController|null} */
let identifierController = null;

/** 古い応答を捨てるための世代番号。 */
let identifierFetchSeq = 0;

/** 起動時先読みを始めたか。 */
let identifierPrefetchStarted = false;

/** 先読みが決着し、メニューを開いてよいか。 */
let identifierReady = false;

/** 先読みの 2 秒打ち切りタイマー。 */
let identifierDeadlineTimer = 0;

/** 現在開いている listbox の provider。一度に一つだけ開く。 */
let openMenuProvider = null;

/** listbox を開いている間に届いた `/api/accounts` の応答。 */
let pendingAccountsPayload = null;

/** listbox を開いている間に届いた実 ID batch の応答。 */
let pendingIdentifierPayload = null;

/**
 * 実 ID キャッシュと nonce をすべて捨てる（アカウントメニュー設計書 §4.2 不変条件 11）。
 * 設定無効化、account dimension の縮退、ページ unload で呼ぶ。
 * @returns {void}
 */
function purgeIdentifierCache() {
  identifierController?.abort();
  identifierController = null;
  identifierFetchSeq += 1;
  identifierCache.clear();
  identifierUpdatedAt = 0;
  identifiersLoaded = false;
  identifierAccessToken = null;
  pendingIdentifierPayload = null;
}

/**
 * `/api/accounts` が返した nonce を反映し、必要なら先読みを始める。
 * @param {string|null} token  process-scoped nonce。設定無効時は null
 * @returns {void}
 */
function updateIdentifierAccessToken(token) {
  if (token === null || state.meta?.canRevealAccountIdentifiersInAccountMenu !== true) {
    purgeIdentifierCache();
    identifierReady = true;
    renderAccountControls();
    return;
  }
  identifierAccessToken = token;
  if (!identifierPrefetchStarted) {
    startIdentifierPrefetch();
    return;
  }
  void refreshAccountIdentifiers();
}

/**
 * 起動時の先読みを始める（アカウントメニュー設計書 §3.6）。
 * 2 秒で決着しない場合は失敗扱いにして操作自体は可能にする。
 * @returns {void}
 */
function startIdentifierPrefetch() {
  identifierPrefetchStarted = true;
  identifierDeadlineTimer = window.setTimeout(() => {
    identifierDeadlineTimer = 0;
    identifierReady = true;
    renderAccountControls();
  }, IDENTIFIER_PREFETCH_TIMEOUT_MS);
  renderAccountControls();
  void refreshAccountIdentifiers();
}

/**
 * 先読みの待ちを解除する。
 * @returns {void}
 */
function settleIdentifierPrefetch() {
  if (identifierDeadlineTimer) {
    clearTimeout(identifierDeadlineTimer);
    identifierDeadlineTimer = 0;
  }
  identifierReady = true;
  renderAccountControls();
}

/**
 * 実 ID を batch で取得する（アカウントメニュー設計書 §3.2 / §3.6）。
 * 失敗しても chart の取得結果には影響させない。
 * @returns {Promise<void>}
 */
async function refreshAccountIdentifiers() {
  if (!identifierAccessToken || state.meta?.canRevealAccountIdentifiersInAccountMenu !== true) {
    settleIdentifierPrefetch();
    return;
  }
  const sequence = ++identifierFetchSeq;
  identifierController?.abort();
  const controller = new AbortController();
  identifierController = controller;
  try {
    const response = await fetch('/api/account-identifiers', {
      cache: 'no-store',
      signal: controller.signal,
      headers: { [IDENTIFIER_TOKEN_HEADER]: identifierAccessToken },
    });
    if (!response.ok) {
      throw new Error('identifiers');
    }
    const json = await response.json();
    if (sequence !== identifierFetchSeq) {
      return;
    }
    applyIdentifierPayload(json.providers);
  } catch (error) {
    if (sequence !== identifierFetchSeq || error?.name === 'AbortError') {
      return;
    }
    // 一時的な失敗では直前の成功値を 5 分まで使い、超えたら捨てる。
    expireStaleIdentifiers();
  } finally {
    if (sequence === identifierFetchSeq) {
      settleIdentifierPrefetch();
    }
  }
}

/**
 * batch 応答を専用キャッシュへ atomic に差し替える。
 * listbox を開いている間は反映を保留する（アカウントメニュー設計書 §3.6）。
 * @param {any} providers  provider ごとの実 ID
 * @returns {void}
 */
function applyIdentifierPayload(providers) {
  if (openMenuProvider !== null) {
    pendingIdentifierPayload = providers;
    return;
  }
  /** @type {[string, {kind:'email'|'uuid', value:string}][]} */
  const entries = [];
  for (const provider of PROVIDERS) {
    const rows = providers?.[provider];
    if (!rows || typeof rows !== 'object') {
      continue;
    }
    for (const [accountKey, entry] of Object.entries(rows)) {
      if (!entry || typeof entry.value !== 'string' || entry.value === '') {
        continue;
      }
      entries.push([accountKey, { kind: entry.kind === 'email' ? 'email' : 'uuid', value: entry.value }]);
    }
  }
  identifierCache.clear();
  for (const [accountKey, entry] of entries) {
    identifierCache.set(accountKey, entry);
  }
  identifierUpdatedAt = Date.now();
  identifiersLoaded = true;
  pendingIdentifierPayload = null;
}

/**
 * 5 分を超えた古い値を捨てる（アカウントメニュー設計書 §3.6）。
 * @returns {void}
 */
function expireStaleIdentifiers() {
  if (!identifiersLoaded) {
    return;
  }
  if (Date.now() - identifierUpdatedAt <= IDENTIFIER_STALE_LIMIT_MS) {
    return;
  }
  identifierCache.clear();
  identifierUpdatedAt = 0;
  identifiersLoaded = false;
}

/**
 * `/api/accounts` から消えた account key を即時破棄する（アカウントメニュー設計書 §3.6）。
 * @returns {void}
 */
function dropUnknownIdentifierKeys() {
  const known = new Set();
  for (const provider of PROVIDERS) {
    for (const account of state.accountGroups[provider]?.accounts ?? []) {
      known.add(account.accountKey);
    }
  }
  for (const accountKey of [...identifierCache.keys()]) {
    if (!known.has(accountKey)) {
      identifierCache.delete(accountKey);
    }
  }
}

/**
 * 識別情報の取得状態を返す。
 * @returns {'ready'|'unavailable'|'disabled'} option へ出す文言の決め方
 */
function identifierState() {
  if (state.meta?.canRevealAccountIdentifiersInAccountMenu !== true || !state.accountsAvailable) {
    return 'disabled';
  }
  expireStaleIdentifiers();
  return identifiersLoaded ? 'ready' : 'unavailable';
}

/**
 * listbox を組み立てるときだけ使う、provider 分の実 ID スナップショット。
 * @param {string} provider  provider 名
 * @returns {Record<string, {kind:'email'|'uuid', value:string}>} accountKey を鍵にした実 ID
 */
function identifierSnapshot(provider) {
  /** @type {Record<string, {kind:'email'|'uuid', value:string}>} */
  const snapshot = {};
  for (const account of state.accountGroups[provider]?.accounts ?? []) {
    const entry = identifierCache.get(account.accountKey);
    if (entry) {
      snapshot[account.accountKey] = entry;
    }
  }
  return snapshot;
}

/**
 * まだ識別情報が揃っていなければ再取得する（アカウントメニュー設計書 §3.6）。
 * メニューを開く操作とトリガーのフォーカス取得時に呼ぶ。
 * @returns {Promise<void>}
 */
async function retryIdentifiersIfNeeded() {
  if (identifierState() === 'ready' || !identifierAccessToken) {
    return;
  }
  await refreshAccountIdentifiers();
}

// ---------------------------------------------------------------- 閉じたトリガー

/**
 * provider ごとの選択値を匿名 DTO から決め直す。
 * @returns {void}
 */
function chooseAccountSelections() {
  for (const provider of PROVIDERS) {
    const group = state.accountGroups[provider] ?? { resolution: 'pending', currentAccountKey: null, accounts: [] };
    state.selectedAccounts[provider] = chooseAccountSelection(group, state.savedSelections[provider]);
  }
}

/**
 * 閉じたトリガーの text node を作る（アカウントメニュー設計書 §4.2 不変条件 1・2）。
 * 入力は匿名 `/api/accounts` DTO の `label` だけであり、実 ID キャッシュは参照しない。
 * current marker も付けない。
 * @param {string} provider  provider 名
 * @returns {void}
 */
function renderAccountTrigger(provider) {
  const menu = accountMenus[provider];
  if (!menu) {
    return;
  }
  const group = state.accountGroups[provider] ?? null;
  menu.button.textContent = buildClosedTriggerLabel(group, state.selectedAccounts[provider]);
}

/**
 * 全 provider のアカウント操作部を描き直す。
 * @returns {void}
 */
function renderAccountControls() {
  for (const provider of PROVIDERS) {
    renderAccountControl(provider);
  }
}

/**
 * 1 provider 分のトリガー、status、current note を描き直す。
 * @param {string} provider  provider 名
 * @returns {void}
 */
function renderAccountControl(provider) {
  const menu = accountMenus[provider];
  const note = currentAccountNotes[provider];
  if (!menu || !note) {
    return;
  }
  if (!state.accountsAvailable) {
    // migration 縮退では listbox を開かず、実 ID endpoint も呼ばない。
    menu.button.textContent = ACCOUNT_DIMENSION_UNAVAILABLE_TEXT;
    menu.button.disabled = true;
    menu.status.textContent = '';
    note.textContent = 'DB移行未完了のためアカウント別表示は無効';
    return;
  }
  renderAccountTrigger(provider);
  const group = state.accountGroups[provider] ?? { currentAccountKey: null, accounts: [] };
  const selected = state.selectedAccounts[provider];
  const waiting = Boolean(selected) && !identifierReady;
  menu.button.disabled = !selected || waiting;
  menu.status.textContent = waiting ? IDENTIFIER_PREPARING_TEXT : '';
  const current = (group.accounts ?? []).find((account) => account.accountKey === group.currentAccountKey);
  note.textContent = current && selected !== current.accountKey ? `現在ログイン中: ${current.label}` : '';
}

/**
 * listbox を閉じている間に溜めた更新を反映する（アカウントメニュー設計書 §3.6 / §7.3）。
 * @returns {void}
 */
function applyPendingAccountUpdates() {
  if (openMenuProvider !== null) {
    return;
  }
  const identifiers = pendingIdentifierPayload;
  pendingIdentifierPayload = null;
  if (identifiers) {
    applyIdentifierPayload(identifiers);
  }
  const accounts = pendingAccountsPayload;
  pendingAccountsPayload = null;
  if (accounts) {
    applyAccountsPayload(accounts);
  }
}

// ---------------------------------------------------------------- listbox

/**
 * トリガーの click で listbox を開閉する。
 * @param {string} provider  provider 名
 * @returns {void}
 */
function toggleAccountMenu(provider) {
  if (openMenuProvider === provider) {
    closeAccountMenu(provider, { focusTrigger: true });
    return;
  }
  openAccountMenu(provider, 'selected');
}

/**
 * listbox を組み立てて `document.body` 直下へ追加する（アカウントメニュー設計書 §2.4 / §6）。
 * 実 ID を含む DOM node はこの関数でだけ作る。
 * @param {string} provider  provider 名
 * @param {'selected'|'next'|'previous'|'first'|'last'} initial  開いた直後の active option
 * @returns {void}
 */
function openAccountMenu(provider, initial) {
  const menu = accountMenus[provider];
  if (!menu || menu.button.disabled || !state.accountsAvailable) {
    return;
  }
  if (openMenuProvider !== null && openMenuProvider !== provider) {
    closeAccountMenu(openMenuProvider, { focusTrigger: false });
  }
  if (openMenuProvider === provider) {
    return;
  }
  void retryIdentifiersIfNeeded();
  const rows = buildAccountMenuRows({
    provider,
    accounts: state.accountGroups[provider]?.accounts ?? [],
    identifiers: identifierSnapshot(provider),
    identifierState: identifierState(),
    selectedAccountKey: state.selectedAccounts[provider],
  });
  if (rows.length === 0) {
    return;
  }
  menu.rows = rows;
  menu.typeaheadBuffer = '';
  menu.typeaheadAt = 0;
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.isSelected));
  menu.activeIndex = initialActiveIndex(initial, selectedIndex, rows.length);

  const listbox = el('div', 'account-listbox');
  listbox.id = menu.listboxId;
  listbox.setAttribute('role', 'listbox');
  listbox.tabIndex = 0;
  listbox.setAttribute('aria-labelledby', menu.labelId);
  rows.forEach((row, index) => {
    listbox.appendChild(buildAccountOption(provider, row, index));
  });
  document.body.appendChild(listbox);
  menu.listbox = listbox;
  openMenuProvider = provider;
  menu.button.setAttribute('aria-expanded', 'true');
  placeAccountMenu(menu);
  if (!menu.listbox) {
    // anchor が画面外だった場合は placeAccountMenu が既に閉じている。
    return;
  }
  attachAccountMenuListeners(menu);
  listbox.focus();
  setActiveIndex(provider, menu.activeIndex);
}

/**
 * 開いた直後の active index を決める（アカウントメニュー設計書 §6.2）。
 * @param {'selected'|'next'|'previous'|'first'|'last'} initial  開き方
 * @param {number} selectedIndex  選択中の index
 * @param {number} count  行数
 * @returns {number} active index
 */
function initialActiveIndex(initial, selectedIndex, count) {
  if (initial === 'next') {
    return moveActiveIndex(selectedIndex, 'down', count);
  }
  if (initial === 'previous') {
    return moveActiveIndex(selectedIndex, 'up', count);
  }
  if (initial === 'first') {
    return moveActiveIndex(selectedIndex, 'home', count);
  }
  if (initial === 'last') {
    return moveActiveIndex(selectedIndex, 'end', count);
  }
  return selectedIndex;
}

/**
 * option の DOM を作る。
 * 実 ID は可視 text node にだけ置き、`title`・`data-*`・`aria-label` へは複製しない。
 * @param {string} provider  provider 名
 * @param {AccountMenuRow} row  行モデル
 * @param {number} index  行の位置
 * @returns {HTMLElement} option 要素
 */
function buildAccountOption(provider, row, index) {
  const option = el('div', 'account-option');
  option.id = row.optionId;
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', row.isSelected ? 'true' : 'false');
  option.appendChild(el('span', 'account-option-label', row.label));
  if (row.identifierText !== '') {
    const dash = el('span', 'account-option-dash', '—');
    dash.setAttribute('aria-hidden', 'true');
    option.appendChild(dash);
    option.appendChild(el('span', 'account-option-identifier', row.identifierText));
  }
  option.appendChild(el('span', 'account-option-current', row.currentText));
  option.addEventListener('pointerenter', () => setActiveIndex(provider, index));
  option.addEventListener('click', (event) => {
    if (event.button !== 0) {
      return;
    }
    commitAccountMenu(provider, index);
  });
  return option;
}

/**
 * listbox を viewport 内へ配置する（アカウントメニュー設計書 §5.2）。
 * @param {AccountMenu} menu  対象の controller
 * @returns {void}
 */
function placeAccountMenu(menu) {
  const listbox = menu.listbox;
  if (!listbox) {
    return;
  }
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const anchor = menu.button.getBoundingClientRect();
  if (!isAnchorVisible(anchor, viewport)) {
    closeAccountMenu(menu.provider, { focusTrigger: false });
    return;
  }
  // 幅は内容高に依存しないため、先に幅だけ決めて内容高を測る。
  const first = computeMenuPlacement({ anchor, viewport });
  listbox.style.width = `${first.width}px`;
  listbox.style.maxHeight = 'none';
  const contentHeight = listbox.scrollHeight;
  const placement = computeMenuPlacement({ anchor, viewport, contentHeight });
  listbox.style.width = `${placement.width}px`;
  listbox.style.maxHeight = `${placement.maxHeight}px`;
  listbox.style.left = `${Math.round(placement.left)}px`;
  listbox.style.top = `${Math.round(placement.top)}px`;
}

/**
 * listbox を開いている間だけ必要な listener を張る（アカウントメニュー設計書 §6.3）。
 * @param {AccountMenu} menu  対象の controller
 * @returns {void}
 */
function attachAccountMenuListeners(menu) {
  const provider = menu.provider;
  const onKeyDown = (event) => onListboxKeyDown(provider, event);
  const onPointerDown = (event) => {
    if (menu.listbox?.contains(event.target) || menu.button.contains(event.target)) {
      return;
    }
    // 外側クリックでは閉じるだけとし、クリック先の操作は妨げない。
    closeAccountMenu(provider, { focusTrigger: false });
  };
  const onWindowBlur = () => closeAccountMenu(provider, { focusTrigger: false });
  const onReposition = () => placeAccountMenu(menu);
  menu.listbox?.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onReposition);
  window.addEventListener('scroll', onReposition, true);
  menu.detach = () => {
    menu.listbox?.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', onReposition);
    window.removeEventListener('scroll', onReposition, true);
  };
}

/**
 * listbox を閉じる（アカウントメニュー設計書 §4.2 不変条件 3・4）。
 * 実 ID を含む node は `hidden` にせず remove し、行モデルも同時に捨てる。
 * @param {string} provider  provider 名
 * @param {{focusTrigger?:boolean}} [options]  トリガーへフォーカスを戻すか
 * @returns {void}
 */
function closeAccountMenu(provider, { focusTrigger = true } = {}) {
  const menu = accountMenus[provider];
  if (!menu || !menu.listbox) {
    return;
  }
  menu.detach?.();
  menu.detach = null;
  menu.listbox.remove();
  menu.listbox = null;
  menu.rows = [];
  menu.activeIndex = -1;
  menu.typeaheadBuffer = '';
  menu.typeaheadAt = 0;
  menu.button.setAttribute('aria-expanded', 'false');
  if (openMenuProvider === provider) {
    openMenuProvider = null;
  }
  if (focusTrigger && !menu.button.disabled) {
    menu.button.focus();
  }
  applyPendingAccountUpdates();
}

/**
 * active option を移す（アカウントメニュー設計書 §6.1）。
 * selected とは別状態であり、ここでは account を切り替えない。
 * @param {string} provider  provider 名
 * @param {number} index  新しい active index
 * @returns {void}
 */
function setActiveIndex(provider, index) {
  const menu = accountMenus[provider];
  const listbox = menu?.listbox;
  if (!menu || !listbox) {
    return;
  }
  const next = Math.min(Math.max(index, 0), menu.rows.length - 1);
  menu.activeIndex = next;
  const options = listbox.children;
  for (let position = 0; position < options.length; position += 1) {
    options[position].classList.toggle('is-active', position === next);
  }
  const active = /** @type {HTMLElement|undefined} */ (options[next]);
  if (!active) {
    return;
  }
  listbox.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

/**
 * active option を確定する（アカウントメニュー設計書 §7.2）。
 * listbox を先に remove してから clear と再取得を行う。
 * @param {string} provider  provider 名
 * @param {number} index  確定する行の位置
 * @returns {void}
 */
function commitAccountMenu(provider, index) {
  const menu = accountMenus[provider];
  const accountKey = menu?.rows[index]?.accountKey ?? null;
  closeAccountMenu(provider, { focusTrigger: true });
  if (accountKey) {
    selectAccount(provider, accountKey);
  }
}

// ---------------------------------------------------------------- キーボード

/**
 * typeahead として扱う文字入力かどうかを判定する。
 * @param {KeyboardEvent} event  キーイベント
 * @returns {boolean} typeahead なら true
 */
function isTypeaheadKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  return typeof event.key === 'string' && event.key.length === 1 && event.key !== ' ';
}

/**
 * キーから active option の移動種別を求める。
 * @param {KeyboardEvent} event  キーイベント
 * @returns {'up'|'down'|'home'|'end'|'pageup'|'pagedown'|null} 移動種別
 */
function moveActionForKey(event) {
  if (event.key === 'ArrowDown') {
    return 'down';
  }
  if (event.key === 'ArrowUp') {
    return 'up';
  }
  if (event.key === 'Home') {
    return 'home';
  }
  if (event.key === 'End') {
    return 'end';
  }
  if (event.key === 'PageDown') {
    return 'pagedown';
  }
  if (event.key === 'PageUp') {
    return 'pageup';
  }
  return null;
}

/**
 * PageUp / PageDown の移動量を可視 option 数から求める。
 * @param {AccountMenu} menu  対象の controller
 * @returns {number} 1 回で動かす行数
 */
function visibleOptionCount(menu) {
  const listbox = menu.listbox;
  const first = /** @type {HTMLElement|undefined} */ (listbox?.children[0]);
  if (!listbox || !first || first.offsetHeight === 0) {
    return 1;
  }
  return Math.max(1, Math.floor(listbox.clientHeight / first.offsetHeight));
}

/**
 * 閉じたトリガー上のキー操作（アカウントメニュー設計書 §6.2）。
 * @param {string} provider  provider 名
 * @param {KeyboardEvent} event  キーイベント
 * @returns {void}
 */
function onTriggerKeyDown(provider, event) {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'F4' || (event.altKey && event.key === 'ArrowDown')) {
    event.preventDefault();
    openAccountMenu(provider, 'selected');
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openAccountMenu(provider, 'next');
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    openAccountMenu(provider, 'previous');
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    openAccountMenu(provider, 'first');
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    openAccountMenu(provider, 'last');
    return;
  }
  if (isTypeaheadKey(event)) {
    event.preventDefault();
    openAccountMenu(provider, 'selected');
    applyTypeahead(provider, event.key);
  }
}

/**
 * 開いた listbox 上のキー操作（アカウントメニュー設計書 §6.2）。
 * @param {string} provider  provider 名
 * @param {KeyboardEvent} event  キーイベント
 * @returns {void}
 */
function onListboxKeyDown(provider, event) {
  const menu = accountMenus[provider];
  if (!menu || !menu.listbox) {
    return;
  }
  if (event.key === 'Escape' || event.key === 'F4' || (event.altKey && event.key === 'ArrowUp')) {
    event.preventDefault();
    closeAccountMenu(provider, { focusTrigger: true });
    return;
  }
  if (event.key === 'Tab') {
    // 既定の Tab 移動はトリガーを起点に続けさせる。
    closeAccountMenu(provider, { focusTrigger: true });
    return;
  }
  const action = moveActionForKey(event);
  if (action) {
    event.preventDefault();
    setActiveIndex(provider, moveActiveIndex(menu.activeIndex, action, menu.rows.length, visibleOptionCount(menu)));
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    commitAccountMenu(provider, menu.activeIndex);
    return;
  }
  if (isTypeaheadKey(event)) {
    event.preventDefault();
    applyTypeahead(provider, event.key);
  }
}

/**
 * typeahead の 1 文字を処理する（アカウントメニュー設計書 §6.2）。
 * 匿名 label と現在表示中の識別情報へ先頭一致させる。
 * @param {string} provider  provider 名
 * @param {string} character  入力された 1 文字
 * @returns {void}
 */
function applyTypeahead(provider, character) {
  const menu = accountMenus[provider];
  if (!menu || !menu.listbox) {
    return;
  }
  const now = Date.now();
  const elapsed = menu.typeaheadAt === 0 ? Number.POSITIVE_INFINITY : now - menu.typeaheadAt;
  menu.typeaheadBuffer = updateTypeaheadBuffer(menu.typeaheadBuffer, character, elapsed);
  menu.typeaheadAt = now;
  const start = menu.typeaheadBuffer.length > 1 ? menu.activeIndex : menu.activeIndex + 1;
  const index = findTypeaheadIndex(menu.rows, menu.typeaheadBuffer, start);
  if (index >= 0) {
    setActiveIndex(provider, index);
  }
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

/**
 * 選択中 account の最新行が Claude の認証 error なら理由文字列を返す。
 * @param {SeriesKey} key
 * @returns {string|null}
 */
function authReasonFor(key) {
  if (!AUTH_GAP_KEYS.has(key)) return null;
  const latest = state.latest[key];
  if (latest?.status !== 'error') return null;
  return AUTH_REASON_TEXT[latest.errorCode ?? ''] ?? null;
}

/**
 * 描画に渡す認証区間。サーバーの overlay を優先し、無ければ手元の samples から計算する。
 * 間引き表示中で overlay が無いときは推測せず灰色だけにする（設計書 §15.6）。
 * @param {SeriesKey} key
 * @param {Sample[]} samples
 * @param {{from:number,to:number}} range
 * @param {number} now
 * @returns {import('/shared/gaps.mjs').AuthGap[]|undefined}
 */
function authGapsFor(key, samples, range, now) {
  if (!AUTH_GAP_KEYS.has(key)) return undefined;
  const fromServer = state.authGaps[key];
  if (Array.isArray(fromServer)) return fromServer;
  if (state.decimated) return [];
  return computeAuthGaps(samples, { from: range.from, to: range.to, now, factor: GAP_FACTOR });
}

/** @param {SeriesKey} key @returns {number|null} */
function nextResetAtFor(key) {
  const latest = state.latest[key];
  if (latest?.status === 'ok' && Number.isFinite(latest.resetsAt)) return latest.resetsAt;
  if (key === 'claude/weekly-fable' && latest?.status === 'error') return null;
  // Claude の認証更新待ち中は過去の ok 行からリセット予定を復活させない（設計書 §15.6）
  if (authReasonFor(key) !== null) return null;
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
        authGaps: authGapsFor(panel.key, samples, range, now),
        color: definition.color,
        legendLabel: definition.legend,
        mode: state.panels[panel.key].mode,
        showPoints: state.panels[panel.key].points,
        hover: panel.hover,
        nextResetAt: nextResetAtFor(panel.key),
        policyEvents: policyEventsForProvider(definition.provider),
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
    const authReason = authReasonFor(key);
    const valueText = sample?.status === 'ok' && sample.usedPercent != null
      ? `${Math.round(sample.usedPercent)}%`
      : (authReason ?? '--');
    item.appendChild(el('b', undefined, valueText));
    if (sample?.status !== 'ok') item.classList.add('is-error');
    if (authReason !== null) {
      item.classList.add('is-auth');
      // 過去 account を選択中なら現在の認証状態と混同しないよう「最終記録時」と明示する
      const group = state.accountGroups.claude;
      const selected = state.selectedAccounts.claude;
      const isCurrent = !group || !selected || group.currentAccountKey === selected;
      item.title = isCurrent
        ? `${authReason}: Claude Code を通常起動して認証を更新してください（回復しない場合は再ログイン）`
        : `最終記録時: ${authReason}（現在の認証状態ではありません）`;
    }
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
  // ページを離れるときは実 ID キャッシュを丸ごと捨てる（アカウントメニュー設計書 §3.6）。
  window.addEventListener('pagehide', () => {
    if (openMenuProvider !== null) closeAccountMenu(openMenuProvider, { focusTrigger: false });
    purgeIdentifierCache();
  });
  renderAccountControls();
  renderHeader();
  renderFooter();
  scheduleDraw();
  await fetchMeta();
  try {
    await fetchAccounts();
  } catch {
    // 一覧を取れないときも匿名トリガーだけは描いておく。
    renderAccountControls();
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
