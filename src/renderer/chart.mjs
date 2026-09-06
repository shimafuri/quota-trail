/**
 * Canvas 2D によるチャート描画（設計 §7.4）。
 * devicePixelRatio 対応。DOM への副作用は canvas のサイズ属性のみ。
 *
 * @module renderer/chart
 */

import { pickTimeStep, timeTicks, formatTickLabel, formatDateTime } from '/shared/ticks.mjs';
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
 * @param {{symbol:'dot'|'band'|'dash', color:string, text:string}[]} items
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
  ];
  const lines = legendLineCount(ctx, cssW, legendItems);
  const r = plotRect(cssW, cssH, lines);

  const from = opts.from;
  const to = opts.to;
  if (!(to > from)) return r;

  drawYAxis(ctx, r);
  drawGaps(ctx, r, opts.gaps || [], from, to);
  drawXAxis(ctx, r, cssW, from, to);
  drawResets(ctx, r, opts.samples || [], from, to, opts.color);
  drawSeries(ctx, r, opts, from, to);
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
 * `resetsAt` が変わった位置に破線の縦線を引く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} r
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {string} color
 */
const RESET_JITTER_MS = 60_000;

function drawResets(ctx, r, samples, from, to, color) {
  const oks = samples.filter((s) => s.status === 'ok');
  if (oks.length < 2) return;
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
  for (let i = 1; i < oks.length; i++) {
    const a = oks[i - 1];
    const b = oks[i];
    // API の resetsAt は秒未満〜数秒ゆらぐことがあるので、許容幅未満の差はリセットと見なさない
    if (a.resetsAt == null || b.resetsAt == null || Math.abs(a.resetsAt - b.resetsAt) < RESET_JITTER_MS) continue;
    // 実際のリセット時刻（前の点の resetsAt）が 2 点の間にあればそこ、無ければ後の点の時刻
    const t =
      a.resetsAt > a.observedAt && a.resetsAt <= b.observedAt ? a.resetsAt : b.observedAt;
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
 * @param {{symbol:'dot'|'band'|'dash', color:string, text:string}[]} items
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
