// 現在アカウント状態と v2 backfill の調停（設計書 §3.4 / §4.3）。
// 実 ID はここで DB へ解決するだけで、HTTP API には匿名 account key だけを渡す。
// backfill は最初の取得結果で一度だけ判断し、完了後は DB に再アクセスしない。

/**
 * @typedef {{status:'pending'|'known'|'unknown', accountId:number|null, accountKey:string|null, observedAt:number}} CurrentAccount
 */

/**
 * 現在アカウントを管理する。
 * @param {{db?:any, now?:() => number}} [dependencies]
 * @returns {{
 *   observe:(provider:string, identity:any) => CurrentAccount,
 *   observeBatch:(batch:{provider:string, identity:any}) => CurrentAccount,
 *   current:(provider:string) => CurrentAccount,
 *   currentAccountIds:() => Record<string, number|null>,
 *   accounts:() => any[],
 *   finishBackfills:() => void,
 * }}
 */
export function createAccountManager({ db, now = () => Date.now() } = {}) {
  const providers = ['claude', 'codex'];
  /** @type {Map<string, CurrentAccount>} */
  const currentByProvider = new Map();
  const identities = new Map();
  const backfillFinished = new Set();

  for (const provider of providers) {
    currentByProvider.set(provider, {
      status: 'pending',
      accountId: null,
      accountKey: null,
      observedAt: now(),
    });
  }

  /**
   * identity を DB account へ解決し、匿名 key を含む現在状態へ変換する。
   * @param {string} provider
   * @param {any} identity
   * @returns {CurrentAccount}
   */
  function observe(provider, identity) {
    identities.set(provider, identity ?? null);
    const accountId = identity ? (db?.upsertAccount?.(identity) ?? null) : null;
    const accounts = db?.listAccounts?.() ?? [];
    const account = accounts.find((row) => {
      return row.provider === provider
        && db?.resolveAccountKey?.(provider, row.accountKey) === accountId;
    });
    const current = {
      status: accountId === null ? 'unknown' : 'known',
      accountId,
      accountKey: account?.accountKey ?? null,
      observedAt: now(),
    };
    currentByProvider.set(provider, current);
    return current;
  }

  return {
    observe,

    /** @param {{provider:string, identity:any}} batch @returns {CurrentAccount} */
    observeBatch(batch) {
      return observe(batch.provider, batch.identity);
    },

    /** @param {string} provider @returns {CurrentAccount} */
    current(provider) {
      return currentByProvider.get(provider) ?? {
        status: 'pending',
        accountId: null,
        accountKey: null,
        observedAt: now(),
      };
    },

    /** @returns {Record<string, number|null>} */
    currentAccountIds() {
      return Object.fromEntries(providers.map((provider) => {
        return [provider, this.current(provider).accountId];
      }));
    },

    /** @returns {any[]} */
    accounts() {
      return (db?.listAccounts?.() ?? []).map((account) => ({
        ...account,
        isCurrent: this.current(account.provider).accountKey === account.accountKey,
      }));
    },

    /**
     * 初回 batch の identity 解決後だけ v1 backfill を確定する。
     * assigned / unresolved 後は Set に記録し、3 分ごとの tick で DB を触らない。
     * @returns {void}
     */
    finishBackfills() {
      for (const provider of providers) {
        if (backfillFinished.has(provider) || !identities.has(provider)) {
          continue;
        }
        const result = db?.finishV2Backfill?.(provider, identities.get(provider) ?? null);
        if (result?.state === 'assigned' || result?.state === 'unresolved' || result?.state === 'none') {
          backfillFinished.add(provider);
        }
      }
    },
  };
}
