/**
 * アカウントメニューの表示行・キーボード操作・配置を決める純粋関数群（設計書 §7.6 / §9.1）。
 * DOM、fetch、timer、localStorage、ログには触れない。
 * 実 ID を受け取るのは表示行の生成だけで、戻り値は文字列と配置値に限る。
 * @module shared/account-menu
 */

/** option に識別情報を出さないときの文言（設計書 §5.1）。 */
export const IDENTIFIER_UNAVAILABLE_TEXT = '識別情報を取得できません';

/** unknown account の識別情報欄に出す文言（設計書 §5.1）。 */
export const UNKNOWN_IDENTIFIER_TEXT = '実 ID なし';

/** 現在ログイン中の option へ付ける marker（設計書 §5.1）。 */
export const CURRENT_MARKER_TEXT = '現在ログイン中';

/** 起動時先読み中にトリガーへ添える可視 status（設計書 §3.6）。 */
export const IDENTIFIER_PREPARING_TEXT = 'アカウント情報を準備中';

/** account dimension が使えないときの disabled トリガー文言（設計書 §7.4）。 */
export const ACCOUNT_DIMENSION_UNAVAILABLE_TEXT = 'アカウント情報を利用できません';

/** account 一覧がまだ無いときの匿名トリガー文言。 */
export const ACCOUNT_PENDING_TEXT = 'アカウントを確認中';

/** typeahead の入力バッファを保持する時間（設計書 §6.2）。 */
export const TYPEAHEAD_RESET_MS = 700;

/** listbox と viewport の最小余白（設計書 §5.2）。 */
export const MENU_VIEWPORT_MARGIN = 8;

/** listbox の推奨幅（設計書 §5.2）。 */
export const MENU_PREFERRED_WIDTH = 360;

/** listbox の最大幅（設計書 §5.2）。 */
export const MENU_MAX_WIDTH = 560;

/** listbox の最大高（設計書 §5.2）。 */
export const MENU_MAX_HEIGHT = 320;

/**
 * @typedef {Object} AnonymousAccount
 * @property {string} accountKey  匿名の account key（`claude:1` など）
 * @property {string} label       匿名ラベル（`アカウント1` など）
 * @property {boolean} [isCurrent] 現在ログイン中かどうか
 * @property {'known'|'unknown'} [kind] 既知 account か unknown か
 */

/**
 * @typedef {Object} AccountIdentifier
 * @property {'email'|'uuid'} kind  表示用に選ばれた識別情報の種別
 * @property {string} value         識別情報そのもの
 */

/**
 * @typedef {Object} AccountMenuRow
 * @property {string} accountKey      匿名 account key
 * @property {string} label           匿名ラベル
 * @property {string} closedLabel     閉じたトリガーへ出してよい文言（常に匿名ラベルと同一）
 * @property {string} identifierText  開いた listbox にだけ出す識別情報欄の文言
 * @property {string} currentText     current marker（該当しなければ空文字）
 * @property {boolean} isCurrent      匿名 DTO 由来の current 判定
 * @property {boolean} isSelected     選択中かどうか
 * @property {'known'|'unknown'} kind account の種別
 * @property {string} optionId        provider と匿名 key だけから作った option の id
 */

/**
 * UUID を `先頭8…末尾4` へ短縮する（設計書 §5.1）。
 * @param {string} uuid  短縮前の UUID
 * @returns {string} 短縮した表示文字列
 */
export function shortenAccountUuid(uuid) {
  const text = typeof uuid === 'string' ? uuid : '';
  if (text.length <= 13) {
    return text;
  }
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

/**
 * option の DOM id を provider と匿名 key だけから作る（設計書 §2.4）。
 * @param {string} provider   provider 名
 * @param {string} accountKey 匿名 account key
 * @returns {string} option の id
 */
export function accountOptionId(provider, accountKey) {
  const suffix = String(accountKey).replace(/[^0-9A-Za-z]+/g, '-');
  return `${provider}-account-option-${suffix}`;
}

/**
 * 識別情報欄の文言を決める（設計書 §5.1）。
 * @param {AnonymousAccount} account  匿名 DTO
 * @param {AccountIdentifier|null|undefined} identifier  専用キャッシュの値
 * @param {'ready'|'unavailable'|'disabled'} identifierState  識別情報の取得状態
 * @returns {string} 識別情報欄へ出す文言
 */
export function formatIdentifierText(account, identifier, identifierState) {
  if (identifierState === 'disabled') {
    return '';
  }
  if (account?.kind === 'unknown') {
    return UNKNOWN_IDENTIFIER_TEXT;
  }
  if (identifierState !== 'ready' || !identifier || typeof identifier.value !== 'string' || identifier.value === '') {
    return IDENTIFIER_UNAVAILABLE_TEXT;
  }
  if (identifier.kind === 'email') {
    return identifier.value;
  }
  return `UUID ${shortenAccountUuid(identifier.value)}`;
}

/**
 * 開いた listbox 用の行モデルを作る（設計書 §5.1 / §9.1）。
 * 匿名 DTO と専用実 ID キャッシュを `accountKey` で結合する。
 * @param {Object} input
 * @param {string} input.provider  provider 名
 * @param {AnonymousAccount[]} input.accounts  `/api/accounts` の匿名 DTO
 * @param {Record<string, AccountIdentifier>} [input.identifiers]  accountKey を鍵にした実 ID
 * @param {'ready'|'unavailable'|'disabled'} [input.identifierState]  識別情報の取得状態
 * @param {string|null} [input.selectedAccountKey]  選択中の匿名 key
 * @returns {AccountMenuRow[]} 行モデルの配列
 */
export function buildAccountMenuRows({
  provider,
  accounts,
  identifiers = {},
  identifierState = 'unavailable',
  selectedAccountKey = null,
}) {
  const rows = Array.isArray(accounts) ? accounts : [];
  return rows.map((account) => {
    const kind = account?.kind === 'unknown' ? 'unknown' : 'known';
    const label = typeof account?.label === 'string' ? account.label : '';
    const identifier = identifiers ? identifiers[account?.accountKey] : null;
    return {
      accountKey: String(account?.accountKey ?? ''),
      label,
      closedLabel: label,
      identifierText: formatIdentifierText(account, identifier, identifierState),
      currentText: account?.isCurrent === true ? CURRENT_MARKER_TEXT : '',
      isCurrent: account?.isCurrent === true,
      isSelected: account?.accountKey === selectedAccountKey,
      kind,
      optionId: accountOptionId(provider, account?.accountKey ?? ''),
    };
  });
}

/**
 * 閉じたトリガーの文言を匿名 DTO だけから作る（設計書 §4.2 不変条件 1）。
 * 実 ID も current marker も含めない。
 * @param {{accounts?:AnonymousAccount[]}|null|undefined} group  provider の匿名グループ
 * @param {string|null|undefined} selectedAccountKey  選択中の匿名 key
 * @returns {string} トリガーへ出す文言
 */
export function buildClosedTriggerLabel(group, selectedAccountKey) {
  const accounts = Array.isArray(group?.accounts) ? group.accounts : [];
  const selected = accounts.find((account) => account.accountKey === selectedAccountKey);
  if (selected && typeof selected.label === 'string' && selected.label !== '') {
    return selected.label;
  }
  return ACCOUNT_PENDING_TEXT;
}

/**
 * キーボード操作後の active index を求める（設計書 §6.2）。
 * 範囲外へは出ず、行が無ければ -1 を返す。
 * @param {number} currentIndex  現在の active index
 * @param {'up'|'down'|'home'|'end'|'pageup'|'pagedown'} action  移動種別
 * @param {number} count  行数
 * @param {number} [pageSize]  PageUp / PageDown の移動量
 * @returns {number} 新しい active index
 */
export function moveActiveIndex(currentIndex, action, count, pageSize = 1) {
  const total = Number.isInteger(count) ? count : 0;
  if (total <= 0) {
    return -1;
  }
  const page = Math.max(1, Math.trunc(Number.isFinite(pageSize) ? pageSize : 1));
  const base = Number.isInteger(currentIndex) ? currentIndex : -1;
  const start = Math.min(Math.max(base, 0), total - 1);
  let next = start;
  if (action === 'up') {
    next = start - 1;
  } else if (action === 'down') {
    next = start + 1;
  } else if (action === 'home') {
    next = 0;
  } else if (action === 'end') {
    next = total - 1;
  } else if (action === 'pageup') {
    next = start - page;
  } else if (action === 'pagedown') {
    next = start + page;
  }
  return Math.min(Math.max(next, 0), total - 1);
}

/**
 * typeahead の入力バッファを更新する（設計書 §6.2）。
 * 前回入力から 700 ms を超えていればバッファを捨てる。
 * @param {string} buffer  現在のバッファ
 * @param {string} character  新しく入力された 1 文字
 * @param {number} elapsedMs  前回入力からの経過ミリ秒
 * @returns {string} 更新後のバッファ
 */
export function updateTypeaheadBuffer(buffer, character, elapsedMs) {
  const input = typeof character === 'string' ? character : '';
  const previous = typeof buffer === 'string' ? buffer : '';
  if (!Number.isFinite(elapsedMs) || elapsedMs > TYPEAHEAD_RESET_MS) {
    return input;
  }
  return `${previous}${input}`;
}

/**
 * typeahead のバッファに前方一致する行を探す（設計書 §6.2）。
 * 匿名ラベルと現在表示中の識別情報の両方を対象にし、末尾まで行ったら先頭へ回る。
 * @param {AccountMenuRow[]} rows  行モデル
 * @param {string} buffer  typeahead のバッファ
 * @param {number} startIndex  探索を始める index
 * @returns {number} 一致した index。一致しなければ -1
 */
export function findTypeaheadIndex(rows, buffer, startIndex) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = typeof buffer === 'string' ? buffer.toLocaleLowerCase() : '';
  if (list.length === 0 || needle === '') {
    return -1;
  }
  const from = Number.isInteger(startIndex) ? startIndex : 0;
  for (let step = 0; step < list.length; step += 1) {
    const index = (((from + step) % list.length) + list.length) % list.length;
    const row = list[index];
    const haystacks = [row?.label ?? '', row?.identifierText ?? ''];
    if (haystacks.some((text) => String(text).toLocaleLowerCase().startsWith(needle))) {
      return index;
    }
  }
  return -1;
}

/**
 * @typedef {Object} AnchorRect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} MenuPlacement
 * @property {number} left       viewport 座標の左端
 * @property {number} top        viewport 座標の上端
 * @property {number} width      listbox の幅
 * @property {number} height     実際に使う高さ
 * @property {number} maxHeight  option 領域の最大高
 * @property {'above'|'below'} placement  トリガーの上下どちらへ置くか
 */

/**
 * listbox の配置を viewport 内へ clamp して求める（設計書 §5.2）。
 * @param {Object} input
 * @param {AnchorRect} input.anchor  トリガーの矩形
 * @param {{width:number, height:number}} input.viewport  viewport の大きさ
 * @param {number} [input.contentHeight]  option 全体の高さ
 * @param {number} [input.margin]  viewport からの最小余白
 * @returns {MenuPlacement} 配置結果
 */
export function computeMenuPlacement({ anchor, viewport, contentHeight = MENU_MAX_HEIGHT, margin = MENU_VIEWPORT_MARGIN }) {
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  const anchorLeft = Number(anchor?.left) || 0;
  const anchorTop = Number(anchor?.top) || 0;
  const anchorBottom = Number(anchor?.bottom) || 0;
  const anchorWidth = Math.max(0, Number(anchor?.width) || 0);

  const available = Math.max(0, viewportWidth - margin * 2);
  const wanted = Math.max(MENU_PREFERRED_WIDTH, anchorWidth);
  const width = Math.min(wanted, MENU_MAX_WIDTH, available);

  const belowSpace = Math.max(0, viewportHeight - anchorBottom - margin);
  const aboveSpace = Math.max(0, anchorTop - margin);
  const desired = Math.max(0, Math.min(MENU_MAX_HEIGHT, Number(contentHeight) || 0));
  const placement = belowSpace < desired && aboveSpace > belowSpace ? 'above' : 'below';
  const space = placement === 'above' ? aboveSpace : belowSpace;
  const maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, space));
  const height = Math.min(maxHeight, desired);

  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const left = Math.min(Math.max(anchorLeft, margin), maxLeft);
  const lowestTop = Math.max(margin, viewportHeight - height - margin);
  const top = placement === 'above'
    ? Math.max(margin, anchorTop - height)
    : Math.max(margin, Math.min(anchorBottom, lowestTop));

  return { left, top, width, height, maxHeight, placement };
}

/**
 * トリガーが viewport 内に残っているかを判定する（設計書 §5.2）。
 * 画面外へ出た listbox は閉じる。
 * @param {AnchorRect} anchor  トリガーの矩形
 * @param {{width:number, height:number}} viewport  viewport の大きさ
 * @returns {boolean} 一部でも見えていれば true
 */
export function isAnchorVisible(anchor, viewport) {
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  if (!anchor) {
    return false;
  }
  if (anchor.bottom <= 0 || anchor.top >= viewportHeight) {
    return false;
  }
  if (anchor.right <= 0 || anchor.left >= viewportWidth) {
    return false;
  }
  return true;
}
