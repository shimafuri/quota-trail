import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccountSelection, isAccountSelectionChange } from '../src/shared/account-selection.mjs';
import { buildAccountMenuRows, moveActiveIndex } from '../src/shared/account-menu.mjs';

const group = {
  resolution: 'known',
  currentAccountKey: 'claude:2',
  accounts: [
    { accountKey: 'claude:2', kind: 'known' },
    { accountKey: 'claude:1', kind: 'known' },
    { accountKey: 'claude:unknown', kind: 'unknown' },
  ],
};

test('保存済みで一覧にある選択を現在アカウントより優先する', () => {
  assert.equal(chooseAccountSelection(group, 'claude:1'), 'claude:1');
});

test('保存済みの選択が消えたときは現在アカウントを選ぶ', () => {
  assert.equal(chooseAccountSelection(group, 'claude:99'), 'claude:2');
});

test('現在アカウントが無いときは最小 alias、最後に unknown を選ぶ', () => {
  assert.equal(chooseAccountSelection({ ...group, currentAccountKey: null }, null), 'claude:1');
  assert.equal(chooseAccountSelection({ resolution: 'unknown', currentAccountKey: 'codex:unknown', accounts: [{ accountKey: 'codex:unknown', kind: 'unknown' }] }, null), 'codex:unknown');
});

test('listbox の active 移動だけでは保存選択を変えない', () => {
  const rows = buildAccountMenuRows({
    provider: 'claude',
    accounts: [
      { accountKey: 'claude:1', label: 'アカウント1', isCurrent: false, kind: 'known' },
      { accountKey: 'claude:2', label: 'アカウント2', isCurrent: true, kind: 'known' },
      { accountKey: 'claude:unknown', label: '不明なアカウント', isCurrent: false, kind: 'unknown' },
    ],
    identifierState: 'unavailable',
    selectedAccountKey: 'claude:1',
  });
  const saved = 'claude:1';
  let active = rows.findIndex((row) => row.isSelected);
  assert.equal(active, 0);
  active = moveActiveIndex(active, 'down', rows.length);
  active = moveActiveIndex(active, 'end', rows.length);
  active = moveActiveIndex(active, 'pageup', rows.length, 10);
  // active index が動いても保存値と選択値は据え置く。
  assert.equal(chooseAccountSelection(group, saved), 'claude:1');
  assert.equal(isAccountSelectionChange(saved, rows[active].accountKey), false);
});

test('確定時だけ account key が更新対象になり、同じ key の再確定は no-op になる', () => {
  assert.equal(isAccountSelectionChange('claude:1', 'claude:2'), true);
  assert.equal(isAccountSelectionChange('claude:1', 'claude:1'), false);
  assert.equal(isAccountSelectionChange(null, 'claude:unknown'), true);
  assert.equal(isAccountSelectionChange('claude:1', ''), false);
  assert.equal(isAccountSelectionChange('claude:1', null), false);
  assert.equal(isAccountSelectionChange('claude:1', undefined), false);
});

test('invalid saved key・current・最小 alias・unknown の fallback 順を維持する', () => {
  assert.equal(chooseAccountSelection(group, 'claude:does-not-exist'), 'claude:2');
  assert.equal(chooseAccountSelection({ ...group, currentAccountKey: 'claude:gone' }, null), 'claude:1');
  assert.equal(chooseAccountSelection({ ...group, currentAccountKey: null, accounts: [{ accountKey: 'claude:unknown', kind: 'unknown' }] }, 'claude:1'), 'claude:unknown');
  assert.equal(chooseAccountSelection({ resolution: 'pending', currentAccountKey: null, accounts: [] }, 'claude:1'), null);
});
