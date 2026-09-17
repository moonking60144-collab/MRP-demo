import assert from 'node:assert/strict';
import test from 'node:test';

import { PLAN_MANAGEMENT_COLUMNS } from '../column-defs/plan-management-columns';
import { RUN_HISTORY_COLUMNS } from '../column-defs/run-history-columns';
import { buildColumnFilterFromDraft, createFilterEditorDraft } from '../filter-editor-model';
import {
  filterStaticColumnOptions,
  meetsColumnOptionSearchThreshold,
  mergeColumnFilterOptions,
} from './use-column-filter-options';

test('所有 enum 列表欄位都以 oneOf string[] 建立多選條件', () => {
  const enumCases = [
    {
      column: RUN_HISTORY_COLUMNS.find((column) => column.id === 'status'),
      selectedValues: ['completed', 'error'],
    },
    {
      column: PLAN_MANAGEMENT_COLUMNS.find((column) => column.id === 'status'),
      selectedValues: ['未儲存', '已轉單'],
    },
    {
      column: PLAN_MANAGEMENT_COLUMNS.find((column) => column.id === 'customerCode'),
      selectedValues: ['SY', 'SM'],
    },
  ];

  for (const { column, selectedValues } of enumCases) {
    assert.equal(column?.filterType, 'enum');
    assert.deepEqual(buildColumnFilterFromDraft(column!, {
      ...createFilterEditorDraft('enum'),
      selectedValues,
    }), {
      columnId: column!.id,
      operator: 'oneOf',
      value: selectedValues,
      valueType: 'enum',
    });
  }
});

test('靜態列表選項支援搜尋，並保留不在原始清單中的既有選取值', () => {
  const options = mergeColumnFilterOptions([
    { value: 'completed', label: 'completed' },
    { value: 'error', label: 'error' },
  ], ['stopped']);

  assert.deepEqual(options, [
    { value: 'completed', label: 'completed' },
    { value: 'error', label: 'error' },
    { value: 'stopped', label: 'stopped' },
  ]);
  assert.deepEqual(filterStaticColumnOptions(options, 'ERR'), [
    { value: 'error', label: 'error' },
  ]);
});

test('server facet 保留回傳筆數，也保留目前已選但未回傳的值', () => {
  assert.deepEqual(mergeColumnFilterOptions([
    { value: 'SY', label: 'SY', count: 18 },
  ], ['SY', 'SM']), [
    { value: 'SY', label: 'SY', count: 18 },
    { value: 'SM', label: 'SM' },
  ]);
});

test('高基數候選值未達搜尋長度時不得進入 server 載入', () => {
  assert.equal(meetsColumnOptionSearchThreshold('', 2), false);
  assert.equal(meetsColumnOptionSearchThreshold(' S ', 2), false);
  assert.equal(meetsColumnOptionSearchThreshold('SR', 2), true);
  assert.equal(meetsColumnOptionSearchThreshold('0', 1), true);
  assert.equal(meetsColumnOptionSearchThreshold('', 0), true);
});
