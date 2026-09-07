/**
 * Canvas 2D によるチャート描画（設計 §7.4）。
 * devicePixelRatio 対応。DOM への副作用は canvas のサイズ属性のみ。
 *
 * @module renderer/chart
 */

import {
  pickTimeStep,
  timeTicks,
  formatTickLabel,
  formatDateTime,
  formatClockLabel,
  formatRemaining,
} from '/shared/ticks.mjs';
import { pastResets } from '/shared/resets.mjs';
import { COLORS, FONTS } from './theme.mjs';

/** @typedef {import('/shared/gaps.mjs').Sample} Sample */
/** @typedef {import('/shared/gaps.mjs').Gap} Gap */
/** @typedef {{x:number,y:number,w:number,h:number}} Rect */

export const PAD = Object.freeze({ left: 44, right: 12, top: 8, bottom: 28 });
const LEGEND_LINE_H = 17;
const LEGEND_GAP = 14;
const GAP_BAR_H = 4;
const DEFAULT_INTERVAL_SEC = 180;
const LINE_BREAK_FACTOR = 2.5;
const TAG_H = 16;
const TAG_PAD_X = 5;
const TAG_RADIUS = 3;

/**
 * @param {Sample} s
 */
function intervalMs(s) {
  const sec = Number(s && s.intervalSec);
  return (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_INTERVAL_SEC) * 1000;
}

/**
 * 凡例の行数を測る。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cssW
 * @param {{symbol:'dot'|'band'|'dash'|'tag', color:string, text:string}[]} items
 * @returns {number}
 */
function legendLineCount(ctx, cssW, items) {
  ctx.font = FONTS.legend;
  const maxW = Math.max(40, cssW - 16);
  let lines = 1;
  let x = 0;
  for (const it of items) {
    const w = 14 + ctx.measureText(it.text).width;
    if (x > 0 && x + w > maxW) {
      lines++;
      x = 0;
    }
    x += w + LEGEND_GAP;
  }
  return lines;
}

/**
 * プロット領域の矩形を求める。
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} legendLines
 * @returns {Rect}
 */
function plotRect(cssW, cssH, legendLines) {
  const legendH = legendLines * LEGEND_LINE_H + 4;
  return {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(10, cssW - PAD.left - PAD.right),
    h: Math.max(10, cssH - PAD.top - PAD.bottom - legendH),
  };
}

/**
 * @param {number} t
 * @param {number} from
 * @param {number} to
 * @param {Rect} r
 */
function timeToX(t, from, to, r) {
  return r.x + ((t - from) / (to - from)) * r.w;
}

/**
 * @param {number} x
 * @param {number} from
 * @param {number} to
 * @param {Rect} r
 */
export function xToTime(x, from, to, r) {
  return from + ((x - r.x) / r.w) * (to - from);
}

/**
 * @param {number} v 0..100
 * @param {Rect} r
 */
function valueToY(v, r) {
  return r.y + r.h * (1 - Math.max(0, Math.min(100, v)) / 100);
}

/**
 * @typedef {Object} DrawOptions
 * @property {Sample[]} samples observedAt 昇順。範囲外の前後 1 点を含んでよい
 * @property {number} from 表示範囲開始（ms）
 * @property {number} to 表示範囲終了（ms）
 * @property {number} now 現在時刻（ms）
 * @property {Gap[]} gaps 欠測区間
 * @property {string} color 系列色
 * @property {string} legendLabel 凡例の系列名
 * @property {'line'|'bar'} mode
 * @property {boolean} showPoints
 * @property {{x:number,y:number}|null} [hover] カーソル位置（CSS px、canvas 基準）
 * @property {number|null} [nextResetAt] 予定されているリセット時刻（ms）。無ければ null
 */

/**
 * チャートを描画し、プロット矩形を返す。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {DrawOptions} opts
 * @returns {Rect}
 */
export function drawChart(canvas, opts) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = Math.max(80, Math.round(canvas.clientWidth));
  const cssH = Math.max(80, Math.round(canvas.clientHeight));
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;

  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = COLORS.panelBg;
  ctx.fillRect(0, 0, cssW, cssH);

  const legendItems = [
    { symbol: /** @type {'dot'} */ ('dot'), color: opts.color, text: opts.legendLabel },
    { symbol: /** @type {'band'} */ ('band'), color: COLORS.gapBar, text: '欠測' },
    { symbol: /** @type {'dash'} */ ('dash'), color: opts.color, text: 'リセット' },
    { symbol: /** @type {'tag'} */ ('tag'), color: opts.color, text: 'リセット予定' },
  ];
  const lines = legendLineCount(ctx, cssW, legendItems);
  const r = plotRect(cssW, cssH, lines);

  const from = opts.from;
  const to = opts.to;
  if (!(to > from)) return r;

  drawYAxis(ctx, r);
  drawGaps(ctx, r, opts.gaps || [], from, to);
  drawNowLine(ctx, r, opts.now, from, to);
  drawXAxis(ctx, r, cssW, from, to);
  drawResets(ctx, r, opts.samples || [], from, to, opts.color);
  drawSeries(ctx, r, opts, from, to);
  drawNextReset(ctx, r, opts.nextResetAt ?? null, from, to, opts.now, opts.color, opts.samples || [], opts.mode);
  drawFrame(ctx, r);
  drawLegend(ctx, cssW, cssH, lines, legendItems);
  if (opts.hover) drawTooltip(ctx, r, cssW, cssH, opts, from, to);
  return r;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 */
function drawYAxis(ctx, r) {
  ctx.font = FONTS.axis;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let v = 0; v <= 100; v += 10) {
    const y = Math.round(valueToY(v, r)) + 0.5;
    ctx.strokeStyle = v === 50 ? COLORS.gridMid : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.axisLabel;
    ctx.fillText(`${v}%`, r.x - 6, y);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {Gap[]} gaps
 * @param {number} from
 * @param {number} to
 */
function drawGaps(ctx, r, gaps, from, to) {
  if (!gaps.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  for (const g of gaps) {
    const x0 = timeToX(g.from, from, to, r);
    const x1 = timeToX(g.to, from, to, r);
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = COLORS.gapFill;
    ctx.fillRect(x0, r.y, w, r.h);
    ctx.fillStyle = COLORS.gapBar;
    ctx.fillRect(x0, r.y, w, GAP_BAR_H);
  }
  ctx.restore();
}

/**
 * 表示範囲を未来側へパンして `now` が範囲内に入ったとき、現在時刻を示す薄い灰色の
 * 縦破線と「現在」ラベルを描く（発注者指示 2026-09-08: パン/ズームは無制限のため、
 * 未来を見ているときに現在地がわかるようにする）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {number} now
 * @param {number} from
 * @param {number} to
 */
function drawNowLine(ctx, r, now, from, to) {
  if (!Number.isFinite(now) || now <= from || now >= to) return;
  const x = Math.round(timeToX(now, from, to, r)) + 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = COLORS.axisLabel;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, r.y);
  ctx.lineTo(x, r.y + r.h);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = COLORS.axisLabel;
  ctx.font = FONTS.axis;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lx = x;
  const w = ctx.measureText('現在').width;
  if (lx - w / 2 < r.x) lx = r.x + w / 2;
  if (lx + w / 2 > r.x + r.w) lx = r.x + r.w - w / 2;
  ctx.fillText('現在', lx, r.y + 2);
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {number} cssW
 * @param {number} from
 * @param {number} to
 */
function drawXAxis(ctx, r, cssW, from, to) {
  const step = pickTimeStep(to - from, r.w, 50);
  const ticks = timeTicks(from, to, step);
  ctx.font = FONTS.axis;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  let lastRight = -Infinity;
  let prev = null;
  for (const t of ticks) {
    const x = Math.round(timeToX(t, from, to, r)) + 0.5;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();

    const label = formatTickLabel(t, step, prev);
    prev = t;
    const w = ctx.measureText(label).width;
    let lx = x - w / 2;
    if (lx < 2) lx = 2;
    if (lx + w > cssW - 2) lx = cssW - 2 - w;
    // ラベルが重なるなら描かない
    if (lx < lastRight + 6) continue;
    lastRight = lx + w;
    ctx.fillStyle = COLORS.axisLabel;
    ctx.fillText(label, lx, r.y + r.h + 7);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 */
function drawFrame(ctx, r) {
  ctx.strokeStyle = COLORS.gridMid;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
}

/**
 * `pastResets`（`shared/resets.mjs`）が検出した実際のリセット時刻に破線の縦線を引く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {string} color
 */
function drawResets(ctx, r, samples, from, to, color) {
  const times = pastResets(samples);
  if (!times.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  // 30日表示などでリセット線が密集して読めなくなるのを避ける（最低 6px 間隔）
  let lastX = -Infinity;
  for (const t of times) {
    if (t < from || t > to) continue;
    const x = Math.round(timeToX(t, from, to, r)) + 0.5;
    if (x - lastX < 6) continue;
    lastX = x;
    ctx.beginPath();
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 表示中の（範囲外の前後 1 点を含みうる）サンプルのうち、一番新しい ok 点の usedPercent。
 * 無ければ null。
 * @param {Sample[]} samples
 * @returns {number|null}
 */
function newestOkUsedPercent(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.status === 'ok' && s.usedPercent != null) return s.usedPercent;
  }
  return null;
}

/**
 * 「次回リセット予定」マーカーを描く（Chrome DevTools Performance パネルの
 * Nav/FCP/DCL タグ風）。プロット上部から下部までの縦線 + 塗りつぶしタグ（上下は
 * `drawTag` が衝突の少ない側を選ぶ）。表示範囲より先（右）にあるのが通常ケース
 * （24h/7d/30d は `to = now` のため）で、その場合は右端に固定して残り時間を添える。
 * 最新 ok サンプルの使用率が 0% のときは（リセットする対象が無いので）描かない。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {number|null} nextResetAt 次回リセット予定時刻（ms）。無ければ null
 * @param {number} from
 * @param {number} to
 * @param {number} now
 * @param {string} color 系列色
 * @param {Sample[]} samples
 * @param {'line'|'bar'} mode
 */
function drawNextReset(ctx, r, nextResetAt, from, to, now, color, samples, mode) {
  if (nextResetAt == null || !Number.isFinite(nextResetAt) || nextResetAt < from) return;
  if (newestOkUsedPercent(samples) === 0) return;

  const already = nextResetAt < now;
  const drawColor = already ? COLORS.gapBar : color;
  const prefix = already ? 'リセット済み' : 'リセット';
  const clock = formatClockLabel(nextResetAt, now);

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  if (nextResetAt <= to) {
    // 表示範囲内: 縦線 + 線の位置に左寄せしたタグ
    const x = timeToX(nextResetAt, from, to, r);
    ctx.strokeStyle = drawColor;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const text = `${prefix} ${clock}`;
    drawTag(ctx, r, {
      anchorX: x,
      align: 'left',
      arrow: false,
      text,
      color: drawColor,
      samples,
      mode,
      from,
      to,
    });
  } else {
    // 表示範囲より先: プロット右端に固定し、残り時間を添える
    const text = already
      ? `${prefix} ${clock}`
      : `${prefix} ${clock}（あと ${formatRemaining(nextResetAt - now)}）`;
    drawTag(ctx, r, {
      anchorX: r.x + r.w,
      align: 'right',
      arrow: !already,
      text,
      color: drawColor,
      samples,
      mode,
      from,
      to,
    });
  }

  ctx.restore();
}

/**
 * タグ候補位置（プロット下端 or 上端）それぞれについて、データ点との「衝突」数を数える。
 * 折れ線モードは点の y がタグ矩形（3px 拡張）に入れば衝突。棒グラフモードは常に 0% から
 * 生えるため下端タグには常に衝突し、上端タグには y が矩形に入る（＝値が非常に高い）ときだけ衝突する。
 *
 * @param {Sample[]} samples
 * @param {'line'|'bar'} mode
 * @param {number} from
 * @param {number} to
 * @param {Rect} r
 * @param {number} top タグ候補の上端 y
 * @param {boolean} isBottom 下端候補（棒グラフで常に衝突する側）かどうか
 * @param {number} left タグの左端 x
 * @param {number} w タグの幅
 * @returns {number}
 */
function tagCollisions(samples, mode, from, to, r, top, isBottom, left, w) {
  const xLo = left - 2;
  const xHi = left + w + 2;
  const yLo = top - 3;
  const yHi = top + TAG_H + 3;
  let n = 0;
  for (const s of samples) {
    if (s.status !== 'ok' || s.usedPercent == null) continue;
    const x = timeToX(s.observedAt, from, to, r);
    if (x < xLo || x > xHi) continue;
    if (mode === 'bar' && isBottom) {
      n++;
      continue;
    }
    const y = valueToY(s.usedPercent, r);
    if (y >= yLo && y <= yHi) n++;
  }
  return n;
}

/**
 * DevTools 風のタグ（角丸の塗りつぶし矩形 + 白いテキスト、白い外枠）を描く。
 * `align:'left'` は `anchorX` を左端にし、右端がプロットをはみ出すなら右端を
 * `anchorX` に付け替える。`align:'right'` は常に `anchorX` を右端にする。
 * 上下位置は `tagCollisions` の結果が少ない側を選ぶ（同数ならプロット下端）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {{anchorX:number, align:'left'|'right', arrow:boolean, text:string, color:string, samples:Sample[], mode:'line'|'bar', from:number, to:number}} opt
 */
function drawTag(ctx, r, opt) {
  ctx.font = FONTS.tag;
  const label = opt.arrow ? `▸ ${opt.text}` : opt.text;
  const tw = ctx.measureText(label).width;
  const w = tw + TAG_PAD_X * 2;

  let left = opt.align === 'left' ? opt.anchorX : opt.anchorX - w;
  if (opt.align === 'left' && left + w > r.x + r.w) left = opt.anchorX - w;

  const topBottom = r.y + r.h - TAG_H;
  const topTop = r.y;
  const collBottom = tagCollisions(opt.samples, opt.mode, opt.from, opt.to, r, topBottom, true, left, w);
  const collTop = tagCollisions(opt.samples, opt.mode, opt.from, opt.to, r, topTop, false, left, w);
  const top = collTop < collBottom ? topTop : topBottom;

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = opt.color;
  roundRect(ctx, left, top, w, TAG_H, TAG_RADIUS);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1;
  roundRect(ctx, left + 0.5, top + 0.5, w - 1, TAG_H - 1, TAG_RADIUS);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, left + TAG_PAD_X, top + TAG_H / 2 + 0.5);
}

/**
 * 典型的な 1 サンプルあたりの px 幅。
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {Rect} r
 */
function pxPerInterval(samples, from, to, r) {
  let iv = DEFAULT_INTERVAL_SEC * 1000;
  const ok = samples.find((s) => s.status === 'ok');
  if (ok) iv = intervalMs(ok);
  return (iv / (to - from)) * r.w;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {DrawOptions} opts
 * @param {number} from
 * @param {number} to
 */
function drawSeries(ctx, r, opts, from, to) {
  const samples = opts.samples || [];
  if (!samples.length) return;
  const perInterval = pxPerInterval(samples, from, to, r);

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  if (opts.mode === 'bar') {
    const bw = Math.max(1, Math.min(12, perInterval * 0.7));
    ctx.fillStyle = opts.color;
    const y0 = valueToY(0, r);
    for (const s of samples) {
      if (s.status !== 'ok' || s.usedPercent == null) continue;
      const x = timeToX(s.observedAt, from, to, r);
      if (x < r.x - bw || x > r.x + r.w + bw) continue;
      const y = valueToY(s.usedPercent, r);
      ctx.fillRect(x - bw / 2, y, bw, Math.max(1, y0 - y));
    }
  } else {
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    let started = false;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.status !== 'ok' || s.usedPercent == null) {
        if (started) {
          ctx.stroke();
          started = false;
        }
        continue;
      }
      const x = timeToX(s.observedAt, from, to, r);
      const y = valueToY(s.usedPercent, r);
      if (!started) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      // 次の点との間が閾値を超えるなら線を切る
      const nxt = samples[i + 1];
      if (
        nxt &&
        nxt.status === 'ok' &&
        nxt.observedAt - s.observedAt > intervalMs(s) * LINE_BREAK_FACTOR
      ) {
        ctx.stroke();
        started = false;
      }
    }
    if (started) ctx.stroke();
  }

  if (opts.showPoints) {
    const rad = perInterval < 2 ? 1.5 : 3;
    ctx.fillStyle = opts.color;
    for (const s of samples) {
      if (s.status !== 'ok' || s.usedPercent == null) continue;
      const x = timeToX(s.observedAt, from, to, r);
      if (x < r.x - rad || x > r.x + r.w + rad) continue;
      const y = valueToY(s.usedPercent, r);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} lines
 * @param {{symbol:'dot'|'band'|'dash'|'tag', color:string, text:string}[]} items
 */
function drawLegend(ctx, cssW, cssH, lines, items) {
  ctx.font = FONTS.legend;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const maxW = Math.max(40, cssW - 16);
  const top = cssH - lines * LEGEND_LINE_H - 2;
  let x = 8;
  let line = 0;
  for (const it of items) {
    const tw = ctx.measureText(it.text).width;
    const w = 14 + tw;
    if (x > 8 && x - 8 + w > maxW) {
      line++;
      x = 8;
    }
    const y = top + line * LEGEND_LINE_H + LEGEND_LINE_H / 2;
    ctx.fillStyle = it.color;
    ctx.strokeStyle = it.color;
    if (it.symbol === 'dot') {
      ctx.beginPath();
      ctx.arc(x + 4, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (it.symbol === 'band') {
      ctx.fillStyle = COLORS.gapFill;
      ctx.fillRect(x, y - 4, 9, 8);
      ctx.fillStyle = COLORS.gapBar;
      ctx.fillRect(x, y - 4, 9, 2);
    } else if (it.symbol === 'tag') {
      ctx.fillStyle = it.color;
      roundRect(ctx, x, y - 4.5, 14, 9, 2);
      ctx.fill();
    } else {
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 4.5, y - 5);
      ctx.lineTo(x + 4.5, y + 5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(it.text, x + 14, y);
    x += w + LEGEND_GAP;
  }
}

/**
 * カーソルに最も近い ok 点を返す。
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {Rect} r
 * @param {number} mouseX CSS px
 * @param {number} [maxDistPx=40]
 * @returns {Sample|null}
 */
export function nearestSample(samples, from, to, r, mouseX, maxDistPx = 40) {
  let best = null;
  let bestD = Infinity;
  for (const s of samples) {
    if (s.status !== 'ok' || s.usedPercent == null) continue;
    const x = timeToX(s.observedAt, from, to, r);
    const d = Math.abs(x - mouseX);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return bestD <= maxDistPx ? best : null;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {number} cssW
 * @param {number} cssH
 * @param {DrawOptions} opts
 * @param {number} from
 * @param {number} to
 */
function drawTooltip(ctx, r, cssW, cssH, opts, from, to) {
  const hover = opts.hover;
  if (!hover) return;
  const s = nearestSample(opts.samples || [], from, to, r, hover.x);
  if (!s || s.usedPercent == null) return;
  const px = timeToX(s.observedAt, from, to, r);
  const py = valueToY(s.usedPercent, r);

  // ハイライト
  ctx.save();
  ctx.strokeStyle = opts.color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, r.y);
  ctx.lineTo(px, r.y + r.h);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = opts.color;
  ctx.beginPath();
  ctx.arc(px, py, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  let text = `${formatDateTime(s.observedAt)}  ${s.usedPercent.toFixed(1)}%`;
  if (s.resetsAt != null) text += `  リセット ${formatDateTime(s.resetsAt)}`;

  ctx.font = FONTS.tooltip;
  const tw = ctx.measureText(text).width;
  const bw = tw + 16;
  const bh = 22;
  let bx = px + 10;
  if (bx + bw > cssW - 4) bx = px - 10 - bw;
  if (bx < 4) bx = 4;
  let by = py - bh - 8;
  if (by < r.y + 2) by = py + 10;
  if (by + bh > r.y + r.h) by = Math.max(r.y + 2, r.y + r.h - bh - 2);

  ctx.fillStyle = COLORS.tooltipBg;
  roundRect(ctx, bx, by, bw, bh, 4);
  ctx.fill();
  ctx.fillStyle = COLORS.tooltipText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 8, by + bh / 2);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} rad
 */
function roundRect(ctx, x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
