import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccountSelection } from '../src/shared/account-selection.mjs';

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
