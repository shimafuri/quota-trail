/**
 * Anthropic 利用ポリシー改定の「発表」「発効」を、時刻が不確かな範囲として持つ定数と
 * その描画・吹き出し用の純粋関数（設計 §7.4「利用ポリシー改定の範囲」）。
 * renderer と node:test の両方から import されるため DOM / Node 固有 API には依存しない。
 *
 * 公式の表記はどちらも日付だけで、時刻・タイムゾーンの記載がない。そこで「その日付を
 * どのタイムゾーンで読んでも矛盾しない範囲」を [start, end] として持ち、グラフには
 * 1 本の線ではなく半透明の四角形で描く。各端の意味は個々のイベントのコメントを参照。
 * 公式に確認した日: 2026-10-21（利用規約変更の通知メールは発注者の Gmail で見つからなかった）。
 *
 * @module shared/policy-events
 */

import { formatRemaining } from './ticks.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 範囲が狭すぎるときに四角形を描く最小幅（CSS px） */
export const POLICY_MIN_WIDTH_PX = 3;

/** 凡例の文言 */
export const POLICY_LEGEND_TEXT = '利用ポリシー改定（時刻不明の範囲）';

/**
 * @typedef {Object} ReportedBound
 * @property {string} at 報道の時刻（ISO UTC）
 * @property {string} note 報道上の表記（元のタイムゾーンのまま）
 * @property {string} source 報道の URL
 */

/**
 * @typedef {Object} PolicyEvent
 * @property {string} id
 * @property {'announce'|'effective'} kind
 * @property {string} label 吹き出しの見出しに使う名前
 * @property {string} shortLabel グラフ上端のラベル（短く）
 * @property {string} title 英語の正式名（見出しの括弧書き）
 * @property {string} start 範囲の始まり（ISO UTC）
 * @property {string} end 範囲の終わり（ISO UTC）
 * @property {string} officialText 公式の表記（そのまま）
 * @property {string} officialDate 公式の日付を YYYY-MM-DD にしたもの（UTC / 太平洋時間の読み替えに使う）
 * @property {number} pacificUtcOffsetHours その日の米国太平洋時間の UTC オフセット（PDT −7 / PST −8）
 * @property {'PDT'|'PST'} pacificAbbr
 * @property {ReportedBound|null} reportedUpperBound 報道による上限（無ければ null）
 * @property {string} sourceNote 範囲の根拠の要約
 * @property {string[]} sources 一次情報・報道の URL
 * @property {string} checkedOn 公式に確認した日（YYYY-MM-DD）
 */

const NEWS_URL = 'https://www.anthropic.com/news/2026-usage-policy-update';
const AUP_URL = 'https://www.anthropic.com/legal/aup';
const MACRUMORS_URL = 'https://www.macrumors.com/2026/10/08/anthropic-user-guideline-update/';

/** @type {ReadonlyArray<Readonly<PolicyEvent>>} */
export const POLICY_EVENTS = Object.freeze([
  // 発表: 公式告知の表記は「Oct 8, 2026」のみで時刻・TZ の記載なし。HTML の datePublished
  // "2026-10-08T00:00:00.000Z" は日付だけを入力したときの既定値と判断し、時刻の根拠にしない。
  // 始まり = 10/8 を UTC と読んだ場合の最早（日本時間 10/8 09:00）。
  // 終わり = 報道による上限。MacRumors が 2026-10-08 2:53 pm PDT（= 21:53Z、日本時間 10/9 06:53）に報道済み。
  Object.freeze({
    id: 'anthropic-usage-policy-2026-announce',
    kind: 'announce',
    label: '利用ポリシー改定 発表',
    shortLabel: '規約発表',
    title: 'Anthropic 2026 Usage Policy update',
    start: '2026-10-08T00:00:00Z',
    end: '2026-10-08T21:53:00Z',
    officialText: 'Oct 8, 2026',
    officialDate: '2026-10-08',
    pacificUtcOffsetHours: -7,
    pacificAbbr: 'PDT',
    reportedUpperBound: Object.freeze({
      at: '2026-10-08T21:53:00Z',
      note: '10/8 2:53 pm PDT',
      source: MACRUMORS_URL,
    }),
    sourceNote:
      '公式告知の表記は「Oct 8, 2026」のみ（時刻・TZ なし）。始まり = UTC と読んだ場合の最早、終わり = MacRumors の報道時刻（2:53 pm PDT）',
    sources: Object.freeze([NEWS_URL, MACRUMORS_URL]),
    checkedOn: '2026-10-21',
  }),
  // 発効: 公式告知の "The updated policy takes effect on November 12." と、利用ポリシー本体の
  // 「Effective Nov 12, 2026」。どちらも時刻・TZ の記載なし。
  // 始まり = 11/12 を UTC と読んだ場合の最早（日本時間 11/12 09:00）。
  // 終わり = 米国太平洋時間と読んだ場合の 11/12 の終わり（11/12 は夏時間終了後で PST = UTC−8。
  // 11/13 08:00Z、日本時間 11/13 17:00）。
  // 参考: AUP の HTML の機械可読値 effectiveDate は 2026-11-12T20:41:00Z（日本時間 11/13 05:41）だが、
  // 過去版の値が 2025-09-15T16:00Z / 2024-06-06T07:00Z / 2023-09-15T07:00Z とばらばらで、
  // 告知された時刻ではなく CMS の入力値と判断した。この範囲に収まることだけを記す。
  Object.freeze({
    id: 'anthropic-usage-policy-2026-effective',
    kind: 'effective',
    label: '利用ポリシー改定 発効',
    shortLabel: '規約発効',
    title: 'Anthropic 2026 Usage Policy update',
    start: '2026-11-12T00:00:00Z',
    end: '2026-11-13T08:00:00Z',
    officialText: 'Nov 12, 2026',
    officialDate: '2026-11-12',
    pacificUtcOffsetHours: -8,
    pacificAbbr: 'PST',
    reportedUpperBound: null,
    sourceNote:
      '公式告知「takes effect on November 12」と AUP「Effective Nov 12, 2026」（時刻・TZ なし）。始まり = UTC と読んだ場合の最早、終わり = 米国太平洋時間（PST）と読んだ場合の 11/12 の終わり',
    sources: Object.freeze([NEWS_URL, AUP_URL]),
    checkedOn: '2026-10-21',
  }),
]);

/**
 * provider のグラフに描くイベント。Claude 以外は null（凡例にも出さない）。
 * @param {string} provider
 * @returns {ReadonlyArray<Readonly<PolicyEvent>>|null}
 */
export function policyEventsForProvider(provider) {
  return provider === 'claude' ? POLICY_EVENTS : null;
}

/**
 * イベントの範囲を epoch ms で返す。
 * @param {PolicyEvent} event
 * @returns {{start:number, end:number}}
 */
export function policyEventTimes(event) {
  return { start: Date.parse(event.start), end: Date.parse(event.end) };
}

/**
 * 公式の日付を UTC と読んだ場合・米国太平洋時間と読んだ場合の、それぞれ 1 日分の範囲（ms、終わりは排他）。
 * @param {PolicyEvent} event
 * @returns {{utc:{start:number,end:number}, pacific:{start:number,end:number}}}
 */
export function policyDayInterpretations(event) {
  const utcStart = Date.parse(`${event.officialDate}T00:00:00Z`);
  const pacificStart = utcStart - event.pacificUtcOffsetHours * HOUR;
  return {
    utc: { start: utcStart, end: utcStart + DAY },
    pacific: { start: pacificStart, end: pacificStart + DAY },
  };
}

/**
 * イベントの範囲をプロットの x 座標に切り出す。範囲が `minWidthPx` 未満なら中心を保って広げる。
 * 広げた後でもプロットの横幅と重ならなければ null。
 *
 * @param {PolicyEvent} event
 * @param {number} from 表示範囲開始（ms）
 * @param {number} to 表示範囲終了（ms）
 * @param {{x:number, w:number}} rect プロット矩形（CSS px）
 * @param {number} [minWidthPx=POLICY_MIN_WIDTH_PX]
 * @returns {{x0:number, x1:number, visX0:number, visX1:number}|null}
 *   x0/x1 は（最小幅で広げた後の）範囲そのもの、visX0/visX1 はプロット内に切り詰めた部分
 */
export function policyEventSpanX(event, from, to, rect, minWidthPx = POLICY_MIN_WIDTH_PX) {
  if (!(to > from) || !(rect.w > 0)) return null;
  const { start, end } = policyEventTimes(event);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const scale = rect.w / (to - from);
  let x0 = rect.x + (start - from) * scale;
  let x1 = rect.x + (end - from) * scale;
  if (x1 - x0 < minWidthPx) {
    const mid = (x0 + x1) / 2;
    x0 = mid - minWidthPx / 2;
    x1 = mid + minWidthPx / 2;
  }
  const right = rect.x + rect.w;
  if (x1 < rect.x || x0 > right) return null;
  return { x0, x1, visX0: Math.max(x0, rect.x), visX1: Math.min(x1, right) };
}

/**
 * カーソル位置の四角形に当たるイベントを返す（複数あれば先のもの）。プロットの外なら null。
 * @param {ReadonlyArray<PolicyEvent>} events
 * @param {number} from
 * @param {number} to
 * @param {{x:number, w:number}} rect
 * @param {number} mouseX CSS px
 * @returns {PolicyEvent|null}
 */
export function policyEventAt(events, from, to, rect, mouseX) {
  if (!Number.isFinite(mouseX) || mouseX < rect.x || mouseX > rect.x + rect.w) return null;
  for (const ev of events) {
    const span = policyEventSpanX(ev, from, to, rect);
    if (span && mouseX >= span.visX0 && mouseX <= span.visX1) return ev;
  }
  return null;
}

/**
 * ローカルカレンダー上の通し日番号（ticks.mjs と同じ考え方）。
 * @param {number} t
 */
function localDayIndex(t) {
  const d = new Date(t);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/**
 * 表示範囲より右（未来側）にあるイベントのうち、最も近いもの。無ければ null。
 * 左（過去側）に外れたイベントは出さない（うるさくしないため）。
 * @param {ReadonlyArray<PolicyEvent>} events
 * @param {number} from
 * @param {number} to
 * @returns {PolicyEvent|null}
 */
export function nextPolicyEventAfter(events, from, to) {
  if (!(to > from)) return null;
  /** @type {PolicyEvent|null} */
  let best = null;
  let bestStart = Infinity;
  for (const ev of events) {
    const { start } = policyEventTimes(ev);
    if (start > to && start < bestStart) {
      best = ev;
      bestStart = start;
    }
  }
  return best;
}

/**
 * 範囲外（右側）表示の短い文言。始まり（最早）までの残りを、ローカルの暦日差で「N 日」と出す。
 * - 暦日で 1 日以上先: `規約発効まで 22 日 →`
 * - 同じ日のうちに始まる: `規約発効まで 3h12m →`（`formatRemaining`）
 * - 既に始まっている（過去を見ているとき）: `規約発効 →`
 *
 * @param {PolicyEvent} event
 * @param {number} now
 * @returns {string}
 */
export function policyAheadLabel(event, now) {
  const { start } = policyEventTimes(event);
  if (!(start > now)) return `${event.shortLabel} →`;
  const days = localDayIndex(start) - localDayIndex(now);
  if (days >= 1) return `${event.shortLabel}まで ${days} 日 →`;
  return `${event.shortLabel}まで ${formatRemaining(start - now)} →`;
}

const JST_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * 日本時間の `M/D HH:mm`。OS のタイムゾーンに依存しない。
 * @param {number} t epoch ms
 * @returns {string}
 */
export function formatJst(t) {
  /** @type {Record<string,string>} */
  const p = {};
  for (const part of JST_FORMAT.formatToParts(new Date(t))) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.month}/${p.day} ${hour}:${p.minute}`;
}

/**
 * 日本時間の範囲 `10/8 09:00 〜 10/9 06:53 JST`。
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function formatJstRange(start, end) {
  return `${formatJst(start)} 〜 ${formatJst(end)} JST`;
}

/**
 * 吹き出しの行。
 * @param {PolicyEvent} event
 * @returns {string[]}
 */
export function policyEventTooltipLines(event) {
  const { start, end } = policyEventTimes(event);
  const { utc, pacific } = policyDayInterpretations(event);
  const lines = [
    `${event.label}（${event.title}）`,
    `日本時間の範囲: ${formatJstRange(start, end)}`,
    `公式表記: ${event.officialText}（時刻・タイムゾーンの記載なし）`,
    `UTC と読んだ場合: ${formatJstRange(utc.start, utc.end)}`,
    `米国太平洋時間（${event.pacificAbbr}）と読んだ場合: ${formatJstRange(pacific.start, pacific.end)}`,
  ];
  const ub = event.reportedUpperBound;
  if (ub) lines.push(`報道による上限: ${ub.note}（${formatJst(Date.parse(ub.at))} JST）`);
  return lines;
}
