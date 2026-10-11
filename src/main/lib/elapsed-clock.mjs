// 睡眠/休止を含む OS 経過時計の薄いアダプター（設計書 §15.12「長時間待機、スリープと時計の検証」）
// - Windows の Node では os.uptime() が libuv 経由で GetTickCount64 相当（睡眠・休止を含み、壁時計の補正に
//   影響されない）を秒（小数）で返す。ネイティブ addon を足さずにこれを ms へ換算して使う
// - 稼働中だけを測る時計（QueryUnbiasedInterruptTime / performance.now() 等）は睡眠分を含まないので代用しない
// - Windows 以外は睡眠を含む契約を確認していないため null（= clock_unverified として確認送信しない）
import os from 'node:os';

/**
 * 睡眠を含む経過時計を作る。値は ms、取得不能なら null。
 * @param {{platform?:string, uptimeSec?:() => number}} [options]  テスト用に差し替え可能
 * @returns {() => number|null}
 */
export function createSleepInclusiveClock({ platform = process.platform, uptimeSec = () => os.uptime() } = {}) {
  if (platform !== 'win32') return () => null;
  return () => {
    try {
      const value = Number(uptimeSec());
      return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
    } catch {
      return null;
    }
  };
}

/** 既定の経過時計（このプロセスの OS で決まる） */
export const sleepInclusiveElapsedMs = createSleepInclusiveClock();
