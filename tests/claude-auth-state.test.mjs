import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPIRY_SAFETY_MS,
  MIN_VALID_EXPIRES_AT_MS,
  classifyClaudeAuth,
  parseExpiresAt,
  shouldNotifyClaudeAuth,
  EXPIRY_PROBE_STAGES,
  EXPIRY_PROBE_WINDOW_SEC,
  MAX_EXPIRY_PROBES_PER_TOKEN,
  EXPIRY_PROBE_TOTAL_BUDGET,
  isPreexpiryBaselineLead,
  probeWindowPosition,
  checkProbeClock,
  pickProbeStage,
  summarizeProbeStage,
} from '../src/main/lib/claude-auth-state.mjs';

const NOW = Date.UTC(2026, 9, 2, 0, 0, 0);

test('parseExpiresAt: 有限の epoch ms だけを有効にし、欠落・null・文字列・NaN・秒値を暗黙変換しない', () => {
  assert.deepEqual(parseExpiresAt(NOW + 3_600_000), { expiresAt: NOW + 3_600_000, reason: null });
  assert.deepEqual(parseExpiresAt(undefined), { expiresAt: null, reason: 'missing_expiry' });
  assert.deepEqual(parseExpiresAt(null), { expiresAt: null, reason: 'missing_expiry' });
  assert.deepEqual(parseExpiresAt(String(NOW)), { expiresAt: null, reason: 'invalid_expiry' });
  assert.deepEqual(parseExpiresAt(Number.NaN), { expiresAt: null, reason: 'invalid_expiry' });
  assert.deepEqual(parseExpiresAt(Infinity), { expiresAt: null, reason: 'invalid_expiry' });
  // 秒らしい値（2026 年の epoch 秒）は 2000-01-01 の ms 未満なので不正メタデータ
  assert.deepEqual(parseExpiresAt(Math.floor(NOW / 1000)), { expiresAt: null, reason: 'invalid_expiry' });
  assert.deepEqual(parseExpiresAt(MIN_VALID_EXPIRES_AT_MS - 1), { expiresAt: null, reason: 'invalid_expiry' });
  assert.deepEqual(parseExpiresAt(MIN_VALID_EXPIRES_AT_MS), { expiresAt: MIN_VALID_EXPIRES_AT_MS, reason: null });
  assert.deepEqual(parseExpiresAt(-5), { expiresAt: null, reason: 'invalid_expiry' });
});

test('classifyClaudeAuth: 境界 now と now+30 秒', () => {
  const base = { now: NOW, hasToken: true };
  assert.equal(classifyClaudeAuth({ ...base, expiresAt: NOW }).state, 'expired');
  assert.equal(classifyClaudeAuth({ ...base, expiresAt: NOW }).errorCode, 'auth_expired_local');
  assert.equal(classifyClaudeAuth({ ...base, expiresAt: NOW - 1 }).blocked, true);
  const expiring = classifyClaudeAuth({ ...base, expiresAt: NOW + 1 });
  assert.deepEqual(expiring, { state: 'expiring', blocked: true, errorCode: 'auth_expiring', source: 'local' });
  assert.equal(classifyClaudeAuth({ ...base, expiresAt: NOW + EXPIRY_SAFETY_MS }).state, 'expiring');
  const valid = classifyClaudeAuth({ ...base, expiresAt: NOW + EXPIRY_SAFETY_MS + 1 });
  assert.deepEqual(valid, { state: 'valid', blocked: false, errorCode: null, source: null });
});

test('classifyClaudeAuth: 期限不明は通常取得、資格情報なし・破損は従来の code', () => {
  assert.deepEqual(classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt: null }), {
    state: 'unknown_expiry', blocked: false, errorCode: null, source: null,
  });
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: false, credentialError: 'no_credentials' }).errorCode, 'no_credentials');
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: false, credentialError: 'parse' }).errorCode, 'parse');
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: false, credentialError: 'parse' }).state, 'invalid');
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: false }).state, 'missing');
});

test('classifyClaudeAuth: local expiry と server 401 を区別し、401 は期限より優先する', () => {
  const rejected = classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt: NOW + 3_600_000, rejected: true });
  assert.deepEqual(rejected, { state: 'rejected', blocked: true, errorCode: 'auth_expired', source: 'cached_401' });
  const unknownRejected = classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt: null, rejected: true });
  assert.equal(unknownRejected.errorCode, 'auth_expired');
  const local = classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt: NOW - 1 });
  assert.equal(local.errorCode, 'auth_expired_local');
  assert.notEqual(local.errorCode, rejected.errorCode);
});

test('classifyClaudeAuth: 時刻の後退では expired latch を解除しない。expiring は時計補正で再評価できる', () => {
  const expiresAt = NOW + 60_000;
  assert.equal(classifyClaudeAuth({ now: NOW + 120_000, hasToken: true, expiresAt }).state, 'expired');
  // 時計が戻っても、呼び出し側が渡す latch で expired のまま
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt, expiredLatched: true }).state, 'expired');
  // latch がなければ前進・後退に応じて判定する（expiring は latch しない）
  assert.equal(classifyClaudeAuth({ now: NOW + 40_000, hasToken: true, expiresAt }).state, 'expiring');
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt }).state, 'valid');
});

test('shouldNotifyClaudeAuth: 期限前 threshold と期限切れ/401 を世代ごとに一度だけ', () => {
  const expiresAt = NOW + 600_000;
  const leadSec = 600;
  assert.equal(shouldNotifyClaudeAuth({ now: NOW - 1, state: 'valid', expiresAt, leadSec }), null);
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'valid', expiresAt, leadSec }), 'lead');
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'valid', expiresAt, leadSec, notified: { lead: true } }), null);
  assert.equal(shouldNotifyClaudeAuth({ now: expiresAt - 10_000, state: 'expiring', expiresAt, leadSec }), 'lead');
  assert.equal(shouldNotifyClaudeAuth({ now: expiresAt, state: 'expired', expiresAt, leadSec, notified: { lead: true } }), 'blocked');
  assert.equal(shouldNotifyClaudeAuth({ now: expiresAt, state: 'expired', expiresAt, leadSec, notified: { lead: true, blocked: true } }), null);
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'rejected', expiresAt: null, leadSec }), 'blocked');
  // 期限不明・資格情報なしは期限前の案内をしない
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'unknown_expiry', expiresAt: null, leadSec }), null);
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'missing', expiresAt: null, leadSec }), null);
  // 案内秒は設定値に従う
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'valid', expiresAt: NOW + 900_000, leadSec: 600 }), null);
  assert.equal(shouldNotifyClaudeAuth({ now: NOW, state: 'valid', expiresAt: NOW + 900_000, leadSec: 900 }), 'lead');
});

// ---------------------------------------------------------------- §15.12 期限超過後の確認送信（純粋な適格判定）

test('確認送信のラダーは 3m/30m/2h/6h/8h、token 当たり 1 回、各段 4・合計 20、許容遅れ 300 秒', () => {
  assert.deepEqual(EXPIRY_PROBE_STAGES.map((s) => [s.stage, s.targetDelaySec]), [
    ['3m', 180], ['30m', 1_800], ['2h', 7_200], ['6h', 21_600], ['8h', 28_800],
  ]);
  assert.equal(MAX_EXPIRY_PROBES_PER_TOKEN, 1);
  assert.equal(EXPIRY_PROBE_WINDOW_SEC, 300);
  assert.equal(EXPIRY_PROBE_TOTAL_BUDGET, 20);
});

test('probeWindowPosition: 全 5 段の下限直前/下限ちょうど/上限ちょうど/上限超', () => {
  const expiresAt = NOW;
  for (const { stage, targetDelaySec } of EXPIRY_PROBE_STAGES) {
    const at = (sec) => probeWindowPosition({ now: expiresAt + sec * 1000, expiresAt, targetDelaySec });
    assert.equal(at(targetDelaySec - 0.001), 'before', `${stage} 下限直前`);
    assert.equal(at(targetDelaySec), 'open', `${stage} 下限ちょうど`);
    assert.equal(at(targetDelaySec + 300), 'open', `${stage} 上限ちょうど`);
    assert.equal(at(targetDelaySec + 300.001), 'late', `${stage} 上限超`);
  }
  // 8h 段の上限は 8h5m
  assert.equal(probeWindowPosition({ now: NOW + (8 * 3600 + 300) * 1000, expiresAt: NOW, targetDelaySec: 28_800 }), 'open');
});

test('isPreexpiryBaselineLead: 期限前余裕 30 秒超〜390 秒（180 秒設定）を対照とし、鮮度は期限に対して評価する', () => {
  const lead = (sec, intervalSec = 180) => isPreexpiryBaselineLead({ requestStartedAt: NOW - sec * 1000, expiresAt: NOW, intervalSec });
  assert.equal(lead(30), false, '30 秒ちょうどは対象外（期限前 30 秒 gate と同じ境界）');
  assert.equal(lead(30.001), true);
  assert.equal(lead(390), true, '2 × 180 + 30 = 390 秒ちょうどは対象');
  assert.equal(lead(390.001), false);
  assert.equal(lead(630, 300), true, '間隔 300 秒なら 630 秒まで');
  assert.equal(isPreexpiryBaselineLead({ requestStartedAt: NOW, expiresAt: null, intervalSec: 180 }), false);
  // 8h 待っても対照の鮮度は「期限に対して」評価するので、対照の判定に probe 開始時刻は使わない
  assert.equal(isPreexpiryBaselineLead({ requestStartedAt: NOW - 100_000, expiresAt: NOW, intervalSec: 180 }), true);
});

test('checkProbeClock: 睡眠で W/E が同じだけ進めば合格。後退・累積差 60 秒・E 取得不能は不適格', () => {
  const base = { w0: NOW, e0: 1_000_000, prevW: NOW, prevE: 1_000_000 };
  const H = 3_600_000;
  // 数時間の睡眠: W も E も同じだけ進む（稼働中だけの単調時計が止まっていても判定には使わない）
  assert.equal(checkProbeClock({ ...base, w: NOW + 6 * H, e: 1_000_000 + 6 * H }), null);
  // 累積差の境界: 59.999 秒は合格、60 秒ちょうどで不適格（前進・後退の両方向）
  assert.equal(checkProbeClock({ ...base, w: NOW + H + 59_999, e: 1_000_000 + H }), null);
  assert.equal(checkProbeClock({ ...base, w: NOW + H + 60_000, e: 1_000_000 + H }), 'clock_suspect');
  assert.equal(checkProbeClock({ ...base, w: NOW + H - 60_000, e: 1_000_000 + H }), 'clock_suspect');
  // 小さな補正の累積も基準からの差で検出する
  assert.equal(checkProbeClock({ w0: NOW, e0: 0, prevW: NOW + 2 * H + 50_000, prevE: 2 * H, w: NOW + 3 * H + 60_000, e: 3 * H }), 'clock_suspect');
  // W の後退、E の後退
  assert.equal(checkProbeClock({ ...base, prevW: NOW + 10_000, prevE: 1_010_000, w: NOW + 9_999, e: 1_010_000 }), 'clock_suspect');
  assert.equal(checkProbeClock({ ...base, prevW: NOW + 10_000, prevE: 1_010_000, w: NOW + 10_000, e: 1_009_999 }), 'clock_suspect');
  // E 取得不能
  assert.equal(checkProbeClock({ ...base, w: NOW + 1000, e: null }), 'clock_unverified');
});

test('pickProbeStage: カーソルから順に、満杯（4 件）の段を飛ばし、全段満杯なら null', () => {
  assert.equal(pickProbeStage({ cursor: 0, usedByStage: [0, 0, 0, 0, 0] }), 0);
  assert.equal(pickProbeStage({ cursor: 4, usedByStage: [0, 0, 0, 0, 0] }), 4);
  assert.equal(pickProbeStage({ cursor: 5, usedByStage: [0, 0, 0, 0, 0] }), 0);
  assert.equal(pickProbeStage({ cursor: 1, usedByStage: [0, 4, 4, 0, 0] }), 3);
  assert.equal(pickProbeStage({ cursor: 4, usedByStage: [3, 4, 4, 4, 4] }), 0);
  assert.equal(pickProbeStage({ cursor: 0, usedByStage: [4, 4, 4, 4, 4] }), null);
});

test('summarizeProbeStage: 未観測は 0% にせず null、4 件未満は件数不足で全拒否と判定しない', () => {
  assert.deepEqual(summarizeProbeStage({ http200: 0, http401: 0 }), { decided: 0, acceptanceRate: null, sufficient: false, allRejected: false });
  assert.deepEqual(summarizeProbeStage({ http200: 0, http401: 3 }), { decided: 3, acceptanceRate: 0, sufficient: false, allRejected: false });
  assert.deepEqual(summarizeProbeStage({ http200: 0, http401: 4 }), { decided: 4, acceptanceRate: 0, sufficient: true, allRejected: true });
  assert.deepEqual(summarizeProbeStage({ http200: 1, http401: 3 }), { decided: 4, acceptanceRate: 0.25, sufficient: true, allRejected: false });
});

test('通常 gate は独立: 401 が期限切れより優先し、expired latch は確認送信の可否に関係なく expired のまま', () => {
  assert.equal(classifyClaudeAuth({ now: NOW, hasToken: true, expiresAt: NOW - 1, rejected: true }).source, 'cached_401');
  const latched = classifyClaudeAuth({ now: NOW - 3_600_000, hasToken: true, expiresAt: NOW + 3_600_000, expiredLatched: true });
  assert.deepEqual([latched.state, latched.blocked, latched.errorCode], ['expired', true, 'auth_expired_local']);
});
