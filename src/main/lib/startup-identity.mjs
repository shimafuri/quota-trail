// 起動時の identity 解決を短時間で打ち切る補助。
// timeout 後も元の要求は中断せず、常駐アプリは unknown として公開を続ける。

/**
 * 初回 identity 解決を起動予算内で待つ。
 * @param {Promise<any>} promise
 * @param {number} [timeoutMs]
 * @returns {Promise<any|null>}
 */
export async function resolveInitialIdentityWithinBudget(promise, timeoutMs = 3_000) {
  let timer = null;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
