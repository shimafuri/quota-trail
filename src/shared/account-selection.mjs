/**
 * provider の表示アカウントを副作用なしで選ぶ。
 * @param {{resolution:string,currentAccountKey:string|null,accounts:{accountKey:string,kind:string}[]}} group
 * @param {string|null|undefined} savedAccountKey
 * @returns {string|null}
 */
export function chooseAccountSelection(group, savedAccountKey) {
  const accounts = Array.isArray(group?.accounts) ? group.accounts : [];
  const has = (key) => accounts.some((account) => account.accountKey === key);
  if (typeof savedAccountKey === 'string' && has(savedAccountKey)) {
    return savedAccountKey;
  }
  if (typeof group?.currentAccountKey === 'string' && has(group.currentAccountKey)) {
    return group.currentAccountKey;
  }
  const known = accounts
    .filter((account) => account.kind === 'known')
    .sort((left, right) => left.accountKey.localeCompare(right.accountKey, 'en'));
  if (known.length > 0) {
    return known[0].accountKey;
  }
  const unknown = accounts.find((account) => account.kind === 'unknown');
  return unknown?.accountKey ?? null;
}

/**
 * listbox の確定操作が実際に表示アカウントを変えるかを判定する（アカウントメニュー設計書 §7.2）。
 * active option の移動だけでは呼ばず、Enter・Space・click の確定時だけ呼ぶ。
 * @param {string|null|undefined} currentAccountKey  現在の匿名 accountKey
 * @param {string|null|undefined} nextAccountKey     確定しようとしている匿名 accountKey
 * @returns {boolean} 切り替えが必要なら true
 */
export function isAccountSelectionChange(currentAccountKey, nextAccountKey) {
  if (typeof nextAccountKey !== 'string' || nextAccountKey === '') {
    return false;
  }
  return currentAccountKey !== nextAccountKey;
}
