import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY_EVENTS,
  POLICY_MIN_WIDTH_PX,
  policyEventsForProvider,
  policyEventTimes,
  policyDayInterpretations,
  policyEventSpanX,
  policyEventAt,
  nextPolicyEventAfter,
  policyAheadLabel,
  formatJst,
  formatJstRange,
  policyEventTooltipLines,
} from '../src/shared/policy-events.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ANNOUNCE = /** @type {any} */ (POLICY_EVENTS.find((e) => e.kind === 'announce'));
const EFFECTIVE = /** @type {any} */ (POLICY_EVENTS.find((e) => e.kind === 'effective'));
const RECT = { x: 44, y: 8, w: 600, h: 200 };

test('データ定数: 発表・発効が 1 件ずつあり、start < end、id が重複しない', () => {
  assert.equal(POLICY_EVENTS.length, 2);
  assert.ok(ANNOUNCE && EFFECTIVE);
  assert.equal(new Set(POLICY_EVENTS.map((e) => e.id)).size, POLICY_EVENTS.length);
  for (const ev of POLICY_EVENTS) {
    const { start, end } = policyEventTimes(ev);
    assert.ok(Number.isFinite(start) && Number.isFinite(end), ev.id);
    assert.ok(start < end, ev.id);
    assert.ok(ev.sources.length >= 1, ev.id);
    for (const url of ev.sources) assert.match(url, /^https:\/\//);
    assert.equal(ev.checkedOn, '2026-10-21');
    assert.ok(Object.isFrozen(ev), ev.id);
  }
});

test('データ定数: 日本時間の端が確定値どおり（発表 10/8 09:00〜10/9 06:53、発効 11/12 09:00〜11/13 17:00）', () => {
  const a = policyEventTimes(ANNOUNCE);
  assert.equal(ANNOUNCE.start, '2026-10-08T00:00:00Z');
  assert.equal(ANNOUNCE.end, '2026-10-08T21:53:00Z');
  assert.equal(formatJst(a.start), '10/8 09:00');
  assert.equal(formatJst(a.end), '10/9 06:53');

  const e = policyEventTimes(EFFECTIVE);
  assert.equal(EFFECTIVE.start, '2026-11-12T00:00:00Z');
  assert.equal(EFFECTIVE.end, '2026-11-13T08:00:00Z');
  assert.equal(formatJst(e.start), '11/12 09:00');
  assert.equal(formatJst(e.end), '11/13 17:00');
});

test('データ定数: 各端が根拠どおり（UTC 読みの最早 / 報道の上限 / 太平洋時間読みの終わり）', () => {
  for (const ev of POLICY_EVENTS) {
    const { start } = policyEventTimes(ev);
    const { utc } = policyDayInterpretations(ev);
    // 始まり = 公式の日付を UTC と読んだ場合の最早
    assert.equal(start, utc.start, ev.id);
  }
  // 発表の終わり = MacRumors の報道時刻（2:53 pm PDT = 21:53Z）
  assert.ok(ANNOUNCE.reportedUpperBound);
  assert.equal(Date.parse(ANNOUNCE.reportedUpperBound.at), policyEventTimes(ANNOUNCE).end);
  assert.ok(ANNOUNCE.sources.includes(ANNOUNCE.reportedUpperBound.source));
  // 発効の終わり = 11/12 を PST（UTC−8）と読んだ場合の 11/12 の終わり
  assert.equal(EFFECTIVE.pacificUtcOffsetHours, -8);
  assert.equal(policyDayInterpretations(EFFECTIVE).pacific.end, policyEventTimes(EFFECTIVE).end);
  // AUP の機械可読値 effectiveDate（CMS の入力値と判断して採らなかった）も範囲内に収まる
  const cms = Date.parse('2026-11-12T20:41:00Z');
  const e = policyEventTimes(EFFECTIVE);
  assert.ok(cms > e.start && cms < e.end);
});

test('policyEventsForProvider: Claude だけに出し、Codex には出さない', () => {
  assert.equal(policyEventsForProvider('claude'), POLICY_EVENTS);
  assert.equal(policyEventsForProvider('codex'), null);
  assert.equal(policyEventsForProvider(''), null);
});

test('policyEventSpanX: 範囲内なら時刻どおりの x を返す', () => {
  const { start, end } = policyEventTimes(EFFECTIVE);
  const from = start - 10 * DAY;
  const to = end + 10 * DAY;
  const span = policyEventSpanX(EFFECTIVE, from, to, RECT);
  assert.ok(span);
  const scale = RECT.w / (to - from);
  assert.ok(Math.abs(span.x0 - (RECT.x + (start - from) * scale)) < 1e-9);
  assert.ok(Math.abs(span.x1 - (RECT.x + (end - from) * scale)) < 1e-9);
  assert.equal(span.visX0, span.x0);
  assert.equal(span.visX1, span.x1);
});

test('policyEventSpanX: 3px 未満の範囲は中心を保って最小幅に広げる', () => {
  const { start, end } = policyEventTimes(ANNOUNCE);
  // 1 年を 600px に描くと 22 時間弱は 1.5px 程度
  const from = start - 180 * DAY;
  const to = from + 365 * DAY;
  const span = policyEventSpanX(ANNOUNCE, from, to, RECT);
  assert.ok(span);
  assert.ok(Math.abs(span.x1 - span.x0 - POLICY_MIN_WIDTH_PX) < 1e-9);
  const scale = RECT.w / (to - from);
  const mid = RECT.x + ((start + end) / 2 - from) * scale;
  assert.ok(Math.abs((span.x0 + span.x1) / 2 - mid) < 1e-9);
});

test('policyEventSpanX: 一部だけ見えるときは見える部分を切り詰め、完全に外なら null', () => {
  const { start, end } = policyEventTimes(EFFECTIVE);
  const mid = (start + end) / 2;
  const span = policyEventSpanX(EFFECTIVE, mid, mid + 2 * DAY, RECT);
  assert.ok(span);
  assert.ok(span.x0 < RECT.x);
  assert.equal(span.visX0, RECT.x);
  assert.ok(span.visX1 > RECT.x && span.visX1 < RECT.x + RECT.w);

  assert.equal(policyEventSpanX(EFFECTIVE, end + HOUR, end + DAY, RECT), null);
  assert.equal(policyEventSpanX(EFFECTIVE, start - 2 * DAY, start - HOUR, RECT), null);
  assert.equal(policyEventSpanX(EFFECTIVE, start, start, RECT), null);
});

test('policyEventAt: 四角形の上だけで当たり、プロットの外や範囲外では null', () => {
  const { start, end } = policyEventTimes(EFFECTIVE);
  const from = start - 2 * DAY;
  const to = end + 2 * DAY;
  const span = /** @type {any} */ (policyEventSpanX(EFFECTIVE, from, to, RECT));
  const inside = (span.visX0 + span.visX1) / 2;
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, inside), EFFECTIVE);
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, span.visX0), EFFECTIVE);
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, span.visX0 - 1), null);
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, RECT.x - 1), null);
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, RECT.x + RECT.w + 1), null);
  assert.equal(policyEventAt([], from, to, RECT, inside), null);
});

test('policyEventAt: 最小幅に広げた細い四角形にも当たる', () => {
  const { start } = policyEventTimes(ANNOUNCE);
  const from = start - 180 * DAY;
  const to = from + 365 * DAY;
  const span = /** @type {any} */ (policyEventSpanX(ANNOUNCE, from, to, RECT));
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, span.x0 + 0.2), ANNOUNCE);
  assert.equal(policyEventAt(POLICY_EVENTS, from, to, RECT, span.x1 - 0.2), ANNOUNCE);
});

test('nextPolicyEventAfter: 右に外れたうち最も近いものだけ。左に外れたものは返さない', () => {
  const now = Date.parse('2026-10-21T03:00:00Z');
  // 24h 表示（to = now）: 発表は左、発効は右 → 発効
  assert.equal(nextPolicyEventAfter(POLICY_EVENTS, now - DAY, now), EFFECTIVE);
  // 9 月だけを見ている: 両方とも右 → 近い発表
  const sep = Date.parse('2026-09-10T00:00:00Z');
  assert.equal(nextPolicyEventAfter(POLICY_EVENTS, sep - DAY, sep), ANNOUNCE);
  // 12 月を見ている: 両方とも左 → 出さない
  const dec = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(nextPolicyEventAfter(POLICY_EVENTS, dec - DAY, dec), null);
  // 発効が範囲内に入っていれば右の印は出さない
  assert.equal(nextPolicyEventAfter(POLICY_EVENTS, now, Date.parse('2026-11-20T00:00:00Z')), null);
});

test('policyAheadLabel: 暦日差で「N 日」、同じ日なら残り時間、始まっていれば矢印だけ', () => {
  const start = policyEventTimes(EFFECTIVE).start;
  const d = new Date(start);
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // ローカルの暦日で 22 日前の正午
  const before22 = new Date(startDay);
  before22.setDate(before22.getDate() - 22);
  before22.setHours(12, 0, 0, 0);
  assert.equal(policyAheadLabel(EFFECTIVE, before22.getTime()), '規約発効まで 22 日 →');
  // 前日の 23:59 は 1 日
  assert.equal(policyAheadLabel(EFFECTIVE, startDay - MIN), '規約発効まで 1 日 →');
  // 同じ暦日で始まりの 3h12m 前（始まりがローカル 3:12 以降のときだけ成り立つので条件付き）
  if (start - startDay >= 3 * HOUR + 12 * MIN) {
    assert.equal(policyAheadLabel(EFFECTIVE, start - (3 * HOUR + 12 * MIN)), '規約発効まで 3h12m →');
  }
  assert.equal(policyAheadLabel(EFFECTIVE, start), '規約発効 →');
  assert.equal(policyAheadLabel(ANNOUNCE, start), '規約発表 →');
});

test('formatJst / formatJstRange: OS のタイムゾーンに依存せず日本時間で整形する', () => {
  assert.equal(formatJst(Date.parse('2026-01-01T15:00:00Z')), '1/2 00:00');
  assert.equal(formatJst(Date.parse('2026-12-31T14:59:00Z')), '12/31 23:59');
  assert.equal(formatJst(Date.parse('2026-10-08T21:53:00Z')), '10/9 06:53');
  assert.equal(
    formatJstRange(Date.parse('2026-10-08T00:00:00Z'), Date.parse('2026-10-08T21:53:00Z')),
    '10/8 09:00 〜 10/9 06:53 JST',
  );
});

test('policyEventTooltipLines: 見出し・日本時間の範囲・公式表記・UTC と太平洋時間の読み・報道の上限', () => {
  const eff = policyEventTooltipLines(EFFECTIVE);
  assert.deepEqual(eff, [
    '利用ポリシー改定 発効（Anthropic 2026 Usage Policy update）',
    '日本時間の範囲: 11/12 09:00 〜 11/13 17:00 JST',
    '公式表記: Nov 12, 2026（時刻・タイムゾーンの記載なし）',
    'UTC と読んだ場合: 11/12 09:00 〜 11/13 09:00 JST',
    '米国太平洋時間（PST）と読んだ場合: 11/12 17:00 〜 11/13 17:00 JST',
  ]);
  const ann = policyEventTooltipLines(ANNOUNCE);
  assert.deepEqual(ann, [
    '利用ポリシー改定 発表（Anthropic 2026 Usage Policy update）',
    '日本時間の範囲: 10/8 09:00 〜 10/9 06:53 JST',
    '公式表記: Oct 8, 2026（時刻・タイムゾーンの記載なし）',
    'UTC と読んだ場合: 10/8 09:00 〜 10/9 09:00 JST',
    '米国太平洋時間（PDT）と読んだ場合: 10/8 16:00 〜 10/9 16:00 JST',
    '報道による上限: 10/8 2:53 pm PDT（10/9 06:53 JST）',
  ]);
});
