import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_PENDING_TEXT,
  CURRENT_MARKER_TEXT,
  IDENTIFIER_UNAVAILABLE_TEXT,
  MENU_MAX_HEIGHT,
  MENU_MAX_WIDTH,
  MENU_PREFERRED_WIDTH,
  MENU_VIEWPORT_MARGIN,
  TYPEAHEAD_RESET_MS,
  UNKNOWN_IDENTIFIER_TEXT,
  accountOptionId,
  buildAccountMenuRows,
  buildClosedTriggerLabel,
  computeMenuPlacement,
  findTypeaheadIndex,
  isAnchorVisible,
  moveActiveIndex,
  shortenAccountUuid,
  updateTypeaheadBuffer,
} from '../src/shared/account-menu.mjs';

const EMAIL = 'user@example.test';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';

/** テスト用の匿名 DTO（`/api/accounts` と同じ形） */
const ACCOUNTS = [
  { accountKey: 'claude:1', label: 'アカウント1', isCurrent: true, kind: 'known' },
  { accountKey: 'claude:2', label: 'アカウント2', isCurrent: false, kind: 'known' },
  { accountKey: 'claude:3', label: 'アカウント3', isCurrent: false, kind: 'known' },
  { accountKey: 'claude:unknown', label: '不明なアカウント', isCurrent: false, kind: 'unknown' },
];

/** テスト用の実 ID キャッシュ（accountKey を鍵にする） */
const IDENTIFIERS = {
  'claude:1': { kind: 'email', value: EMAIL },
  'claude:2': { kind: 'uuid', value: UUID },
};

/** @param {Partial<Parameters<typeof buildAccountMenuRows>[0]>} [over] */
function rows(over = {}) {
  return buildAccountMenuRows({
    provider: 'claude',
    accounts: ACCOUNTS,
    identifiers: IDENTIFIERS,
    identifierState: 'ready',
    selectedAccountKey: 'claude:2',
    ...over,
  });
}

test('匿名 account DTO と識別子 DTO が accountKey で結合される', () => {
  const built = rows();
  assert.equal(built.length, 4);
  assert.equal(built[0].accountKey, 'claude:1');
  assert.equal(built[0].identifierText, EMAIL);
  assert.equal(built[0].optionId, accountOptionId('claude', 'claude:1'));
  assert.equal(built[0].optionId, 'claude-account-option-claude-1');
  assert.equal(built[1].isSelected, true);
  assert.equal(built[0].isSelected, false);
});

test('メールが UUID より優先され、メールなし時だけ UUID が 先頭8…末尾4 になる', () => {
  const built = rows({
    identifiers: {
      'claude:1': { kind: 'email', value: EMAIL },
      'claude:2': { kind: 'uuid', value: UUID },
    },
  });
  assert.equal(built[0].identifierText, EMAIL);
  assert.equal(built[0].identifierText.includes('…'), false);
  assert.equal(built[1].identifierText, 'UUID 01234567…cdef');
  assert.equal(built[1].identifierText.includes(UUID), false);
  assert.equal(shortenAccountUuid(UUID), '01234567…cdef');
  assert.equal(shortenAccountUuid('short'), 'short');
});

test('unknown は実 ID なし、欠落と取得失敗は一般文言になる', () => {
  const built = rows();
  assert.equal(built[3].identifierText, UNKNOWN_IDENTIFIER_TEXT);
  assert.equal(built[2].identifierText, IDENTIFIER_UNAVAILABLE_TEXT);
  const failed = rows({ identifierState: 'unavailable' });
  assert.equal(failed[0].identifierText, IDENTIFIER_UNAVAILABLE_TEXT);
  assert.equal(failed[1].identifierText, IDENTIFIER_UNAVAILABLE_TEXT);
  const disabled = rows({ identifierState: 'disabled' });
  assert.deepEqual(disabled.map((row) => row.identifierText), ['', '', '', '']);
});

test('current marker は匿名 DTO だけから決まる', () => {
  const built = rows();
  assert.equal(built[0].currentText, CURRENT_MARKER_TEXT);
  assert.equal(built[0].isCurrent, true);
  assert.deepEqual(built.slice(1).map((row) => row.currentText), ['', '', '']);
  // 識別子キャッシュを空にしても current 判定は変わらない。
  const withoutIdentifiers = rows({ identifiers: {}, identifierState: 'unavailable' });
  assert.deepEqual(withoutIdentifiers.map((row) => row.isCurrent), [true, false, false, false]);
});

test('行モデルの closed label は常に匿名 label だけになる', () => {
  for (const state of ['ready', 'unavailable', 'disabled']) {
    for (const row of rows({ identifierState: state })) {
      assert.equal(row.closedLabel, row.label);
      assert.equal(row.closedLabel.includes(EMAIL), false);
      assert.equal(row.closedLabel.includes('01234567'), false);
      assert.equal(row.closedLabel.includes(CURRENT_MARKER_TEXT), false);
    }
  }
});

test('閉じたトリガーの文言は匿名 label だけで、実 ID も current marker も含まない', () => {
  const group = { accounts: ACCOUNTS };
  assert.equal(buildClosedTriggerLabel(group, 'claude:1'), 'アカウント1');
  assert.equal(buildClosedTriggerLabel(group, 'claude:unknown'), '不明なアカウント');
  assert.equal(buildClosedTriggerLabel(group, 'claude:99'), ACCOUNT_PENDING_TEXT);
  assert.equal(buildClosedTriggerLabel(null, 'claude:1'), ACCOUNT_PENDING_TEXT);
  assert.equal(buildClosedTriggerLabel(group, 'claude:1').includes(CURRENT_MARKER_TEXT), false);
});

test('Up / Down / Home / End / PageUp / PageDown の index 計算が範囲外へ出ない', () => {
  assert.equal(moveActiveIndex(0, 'up', 4), 0);
  assert.equal(moveActiveIndex(3, 'down', 4), 3);
  assert.equal(moveActiveIndex(1, 'up', 4), 0);
  assert.equal(moveActiveIndex(1, 'down', 4), 2);
  assert.equal(moveActiveIndex(2, 'home', 4), 0);
  assert.equal(moveActiveIndex(1, 'end', 4), 3);
  assert.equal(moveActiveIndex(3, 'pageup', 4, 10), 0);
  assert.equal(moveActiveIndex(0, 'pagedown', 4, 10), 3);
  assert.equal(moveActiveIndex(3, 'pageup', 10, 3), 0);
  assert.equal(moveActiveIndex(0, 'pagedown', 10, 3), 3);
  assert.equal(moveActiveIndex(-1, 'down', 4), 1);
  assert.equal(moveActiveIndex(0, 'down', 0), -1);
  assert.equal(moveActiveIndex(99, 'down', 4), 3);
});

test('typeahead は匿名 label と可視識別情報へ先頭一致し、700 ms 超過で buffer をリセットする', () => {
  const built = rows();
  assert.equal(findTypeaheadIndex(built, 'アカウント3', 0), 2);
  assert.equal(findTypeaheadIndex(built, 'user@', 0), 0);
  assert.equal(findTypeaheadIndex(built, 'USER@', 0), 0);
  assert.equal(findTypeaheadIndex(built, '不明', 0), 3);
  assert.equal(findTypeaheadIndex(built, 'zzz', 0), -1);
  // 一致が見つかるまで末尾から先頭へ回る。
  assert.equal(findTypeaheadIndex(built, 'user@', 2), 0);
  assert.equal(updateTypeaheadBuffer('a', 'b', 100), 'ab');
  assert.equal(updateTypeaheadBuffer('a', 'b', TYPEAHEAD_RESET_MS), 'ab');
  assert.equal(updateTypeaheadBuffer('a', 'b', TYPEAHEAD_RESET_MS + 1), 'b');
  assert.equal(updateTypeaheadBuffer('a', 'b', Number.POSITIVE_INFINITY), 'b');
});

test('viewport の上下左右端で placement が 8 px margin 内に clamp される', () => {
  const viewport = { width: 1000, height: 700 };
  const below = computeMenuPlacement({
    anchor: { left: 40, top: 20, right: 200, bottom: 44, width: 160, height: 24 },
    viewport,
    contentHeight: 200,
  });
  assert.equal(below.placement, 'below');
  assert.equal(below.width, MENU_PREFERRED_WIDTH);
  assert.equal(below.top, 44);
  assert.ok(below.left >= MENU_VIEWPORT_MARGIN);

  const above = computeMenuPlacement({
    anchor: { left: 40, top: 640, right: 200, bottom: 664, width: 160, height: 24 },
    viewport,
    contentHeight: 300,
  });
  assert.equal(above.placement, 'above');
  assert.ok(above.top >= MENU_VIEWPORT_MARGIN);
  assert.ok(above.top + above.height <= viewport.height - MENU_VIEWPORT_MARGIN);

  const right = computeMenuPlacement({
    anchor: { left: 980, top: 100, right: 998, bottom: 124, width: 18, height: 24 },
    viewport,
    contentHeight: 200,
  });
  assert.ok(right.left + right.width <= viewport.width - MENU_VIEWPORT_MARGIN);

  const left = computeMenuPlacement({
    anchor: { left: -50, top: 100, right: 110, bottom: 124, width: 160, height: 24 },
    viewport,
    contentHeight: 200,
  });
  assert.equal(left.left, MENU_VIEWPORT_MARGIN);

  const narrow = computeMenuPlacement({
    anchor: { left: 4, top: 100, right: 300, bottom: 124, width: 296, height: 24 },
    viewport: { width: 320, height: 640 },
    contentHeight: 900,
  });
  assert.equal(narrow.width, 320 - MENU_VIEWPORT_MARGIN * 2);
  assert.ok(narrow.maxHeight <= MENU_MAX_HEIGHT);
  assert.ok(narrow.left >= MENU_VIEWPORT_MARGIN);
  assert.ok(narrow.left + narrow.width <= 320 - MENU_VIEWPORT_MARGIN);

  const wideAnchor = computeMenuPlacement({
    anchor: { left: 8, top: 100, right: 1900, bottom: 124, width: 1892, height: 24 },
    viewport: { width: 1920, height: 1080 },
    contentHeight: 200,
  });
  assert.equal(wideAnchor.width, MENU_MAX_WIDTH);
});

test('anchor が viewport の外へ出たら見えていないと判定する', () => {
  const viewport = { width: 800, height: 600 };
  assert.equal(isAnchorVisible({ left: 10, top: 10, right: 100, bottom: 34 }, viewport), true);
  assert.equal(isAnchorVisible({ left: 10, top: 620, right: 100, bottom: 644 }, viewport), false);
  assert.equal(isAnchorVisible({ left: 10, top: -60, right: 100, bottom: -20 }, viewport), false);
  assert.equal(isAnchorVisible({ left: 820, top: 10, right: 900, bottom: 34 }, viewport), false);
  assert.equal(isAnchorVisible(null, viewport), false);
});

test('純粋関数は実 ID を受け取っても行モデルの文字列以外へ残さない', () => {
  const built = rows();
  const serialized = JSON.stringify(built.map((row) => ({
    accountKey: row.accountKey,
    label: row.label,
    closedLabel: row.closedLabel,
    currentText: row.currentText,
    optionId: row.optionId,
    kind: row.kind,
  })));
  assert.equal(serialized.includes(EMAIL), false);
  assert.equal(serialized.includes('01234567'), false);
});
