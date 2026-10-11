// 電源・ロックイベントの Claude 認証関連の処理順（設計書 §4.5 / §15.6 / §15.12）。Electron に依存しない（node:test 対象）。
// - suspend: 確認送信の予約に睡眠開始を記録する
// - resume: 睡眠終了の記録と gate 再評価 → monitor の再読込 → 既存の即時 tick（再評価を tick より先に済ませる）
// - lock: OS 通知だけを保留する。unlock は睡眠とみなさず、通知の再評価と既存の即時 tick だけ
// - idle / lock でポーリングや監視を止めない（H-002）

/**
 * @param {string} evt  powerMonitor のイベント名
 * @param {Object} deps
 * @param {{notePowerEvent?:(kind:'suspend'|'resume') => void}|null} [deps.provider]
 * @param {{setLocked:(v:boolean) => void, checkNow:() => any}|null} [deps.monitor]
 * @param {() => any} [deps.runNow]
 */
export function handleClaudePowerEvent(evt, { provider = null, monitor = null, runNow } = {}) {
  if (evt === 'suspend') provider?.notePowerEvent?.('suspend');
  if (evt === 'lock-screen') monitor?.setLocked(true);
  if (evt === 'unlock-screen') monitor?.setLocked(false);
  if (evt === 'resume') {
    provider?.notePowerEvent?.('resume');
    monitor?.checkNow();
  }
  if (evt === 'resume' || evt === 'unlock-screen') {
    // スリープ復帰・ロック解除後の最初のサンプルを即時取得する（設計書 §4.5）
    void runNow?.();
  }
}
