/**
 * 色と系列定義（設計 §7.5）。
 * @module renderer/theme
 */

/**
 * @typedef {'claude/5h'|'claude/weekly'|'claude/weekly-fable'|'codex/5h'|'codex/weekly'} SeriesKey
 */

/**
 * @typedef {Object} SeriesDef
 * @property {SeriesKey} key
 * @property {'claude'|'codex'} provider
 * @property {'5h'|'weekly'|'weekly-fable'} window
 * @property {string} color 系列色
 * @property {string} title パネルタイトル
 * @property {string} legend 凡例の系列名
 * @property {string} short ページ上部の要約表示名
 */

/** @type {ReadonlyArray<SeriesKey>} */
export const SERIES_KEYS = Object.freeze([
  'claude/5h',
  'claude/weekly',
  'claude/weekly-fable',
  'codex/5h',
  'codex/weekly',
]);

/** @type {Record<SeriesKey, SeriesDef>} */
export const SERIES = {
  'claude/5h': {
    key: 'claude/5h',
    provider: 'claude',
    window: '5h',
    color: '#D97757',
    title: 'Claude Code · 5h limit',
    legend: 'Claude Code 5h limit 使用率',
    short: 'Claude 5h',
  },
  'claude/weekly': {
    key: 'claude/weekly',
    provider: 'claude',
    window: 'weekly',
    color: '#B4532F',
    title: 'Claude Code · Weekly limit',
    legend: 'Claude Code Weekly limit 使用率',
    short: 'Claude W',
  },
  'claude/weekly-fable': {
    key: 'claude/weekly-fable',
    provider: 'claude',
    window: 'weekly-fable',
    color: '#8E3B63',
    title: 'Claude Code · Weekly Fable limit',
    legend: 'Claude Code Weekly Fable limit 使用率',
    short: 'Claude Fable W',
  },
  'codex/5h': {
    key: 'codex/5h',
    provider: 'codex',
    window: '5h',
    color: '#10A37F',
    title: 'Codex CLI · 5h limit',
    legend: 'Codex CLI 5h limit 使用率',
    short: 'Codex 5h',
  },
  'codex/weekly': {
    key: 'codex/weekly',
    provider: 'codex',
    window: 'weekly',
    color: '#0B7A5E',
    title: 'Codex CLI · Weekly limit',
    legend: 'Codex CLI Weekly limit 使用率',
    short: 'Codex W',
  },
};

export const COLORS = Object.freeze({
  pageBg: '#F5F6F8',
  panelBg: '#FFFFFF',
  panelBorder: '#E3E5E9',
  grid: '#E5E7EB',
  gridMid: '#CBD5E1',
  axisLabel: '#4B5563',
  text: '#1F2933',
  muted: '#6B7280',
  gapFill: 'rgba(120,120,128,0.18)',
  gapBar: '#8E8E93',
  /** 認証更新待ち（設計 §15.6）。欠測帯の上端バーに重ねる琥珀色 */
  authBar: '#F59E0B',
  tooltipBg: 'rgba(31,41,51,0.92)',
  tooltipText: '#FFFFFF',
});

export const FONTS = Object.freeze({
  axis: '11px system-ui, "Segoe UI", "Meiryo", sans-serif',
  legend: '11px system-ui, "Segoe UI", "Meiryo", sans-serif',
  tooltip: '12px system-ui, "Segoe UI", "Meiryo", sans-serif',
  tag: 'bold 11px system-ui, "Segoe UI", "Meiryo", sans-serif',
});
