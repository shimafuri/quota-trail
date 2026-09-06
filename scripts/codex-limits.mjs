#!/usr/bin/env node
/*
 * Codex CLI の利用枠（5h limit / Weekly limit）を表示する（2026-09-04 追加）。
 *
 * Codex CLI は各 turn の token_count イベントに rate_limits（primary = 5 時間窓、
 * secondary = 7 日窓）を含めて ~/.codex/sessions/**\/rollout-*.jsonl に記録する。
 * このスクリプトは最新の rollout ファイルから最後の rate_limits を読み、人が読める
 * 1〜2 行にして出力する。Codex 自体は呼ばないのでトークンを消費しない。
 *
 * 注意: `codex exec --ephemeral` は rollout を書かないため、この確認をしたい呼び出しでは
 * --ephemeral を付けないこと。
 *
 * 使い方: node scripts/codex-limits.mjs [--json] [--max-age-minutes N]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const maxAgeIdx = args.indexOf('--max-age-minutes');
const maxAgeMinutes = maxAgeIdx >= 0 ? Number(args[maxAgeIdx + 1]) : null;

const sessionsRoot = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield p;
  }
}

function lastRateLimits(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const obj = JSON.parse(line);
      const rl = obj?.payload?.rate_limits;
      if (rl && (rl.primary || rl.secondary)) return { at: obj.timestamp ?? null, rl };
    } catch { /* 途中書き込み中の行は無視 */ }
  }
  return null;
}

const files = [...walk(sessionsRoot)]
  .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

let found = null;
for (const { f, mtime } of files) {
  const hit = lastRateLimits(f);
  if (hit) { found = { ...hit, file: f, mtime }; break; }
}

if (!found) {
  console.log('Codex limits: rollout に rate_limits が見つかりません（まだ Codex を呼んでいない、または --ephemeral のみ）');
  process.exit(0);
}

const ageMinutes = (Date.now() - found.mtime) / 60000;
const stale = maxAgeMinutes !== null && ageMinutes > maxAgeMinutes;

function fmtReset(epochSec) {
  if (!epochSec) return '不明';
  const d = new Date(epochSec * 1000);
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function windowLabel(w) {
  if (!w) return '?';
  if (w.window_minutes === 300) return '5h limit';
  if (w.window_minutes === 10080) return 'Weekly limit';
  return `${w.window_minutes}min limit`;
}
function line(w) {
  if (!w) return null;
  const used = Number(w.used_percent ?? 0);
  return `${windowLabel(w)}: 残り ${Math.max(0, 100 - used).toFixed(0)}%（使用 ${used.toFixed(0)}%、リセット ${fmtReset(w.resets_at)}）`;
}

if (asJson) {
  console.log(JSON.stringify({ observedAt: found.at, ageMinutes: Math.round(ageMinutes), stale, primary: found.rl.primary ?? null, secondary: found.rl.secondary ?? null, file: found.file }));
} else {
  const parts = [line(found.rl.primary), line(found.rl.secondary)].filter(Boolean);
  console.log(`Codex ${parts.join(' / ')}（観測 ${Math.round(ageMinutes)} 分前${stale ? '、古い可能性あり' : ''}）`);
}
