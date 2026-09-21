import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneColumnFilter,
  createServerFacetedOptionSource,
  createColumnFilterOptionsFingerprint,
  getColumnHeaderCapabilities,
  hasColumnHeaderMenu,
  withServerFacetedColumnOptions,
} from './column-header-contract';
import type { ColumnFilter } from './types';

const customerFilter: ColumnFilter = {
  columnId: 'customerCode',
  operator: 'oneOf',
  value: ['SY', 'SM'],
  valueType: 'enum',
};

test('欄頭 capability 由 column metadata 決定，不依賴頁面領域判斷', () => {
  assert.deepEqual(getColumnHeaderCapabilities({
    id: 'customerCode',
    header: '客戶代碼',
    filterType: 'enum',
    freezeable: false,
  }), {
    filterable: true,
    sortable: true,
    hideable: true,
    freezeable: false,
  });
  assert.equal(hasColumnHeaderMenu({
    id: 'period-1',
    header: 'W01',
    headerMenu: false,
  }), false);
});

test('首站預設來源為低基數欄，不必先輸入兩個字才能勾選', () => {
  assert.deepEqual(createServerFacetedOptionSource({
    id: 'firstProcessSourceType', header: '首站預設來源', filterType: 'text',
  }), { type: 'server', mode: 'faceted', limit: 100 });
});

test('server 列表會替所有可篩選欄位啟用 faceted options', () => {
  const columns = withServerFacetedColumnOptions([
    { id: 'partVersion', header: '客料版本', filterType: 'text' },
    { id: 'stockWeeks', header: '庫存週數', filterType: 'numeric' },
    { id: 'unit', header: '單位', filterType: 'text' },
    { id: 'customerCode', header: '客戶', filterType: 'enum' },
    { id: 'period', header: '月份區塊', filterable: false },
  ]);
  assert.deepEqual(columns[0].optionSource, {
    type: 'server', mode: 'faceted', minSearchLength: 2, limit: 50,
  });
  assert.deepEqual(columns[1].optionSource, {
    type: 'server', mode: 'faceted', minSearchLength: 1, limit: 50,
  });
  assert.deepEqual(columns[2].optionSource, { type: 'server', mode: 'faceted', limit: 100 });
  assert.deepEqual(columns[3].optionSource, { type: 'server', mode: 'faceted', limit: 100 });
  assert.equal(columns[4].optionSource, undefined);
});

test('高基數 server facet 必須先搜尋，低基數欄位維持直接勾選', () => {
  assert.equal(createServerFacetedOptionSource({
    id: 'erpPartNo', header: 'ERP料號', filterType: 'text',
  }).minSearchLength, 2);
  assert.equal(createServerFacetedOptionSource({
    id: 'goodStockPc', header: '良品庫存', filterType: 'numeric',
  }).minSearchLength, 1);
  assert.equal(createServerFacetedOptionSource({
    id: 'unit', header: '單位', filterType: 'text',
  }).minSearchLength, undefined);
  assert.equal(createServerFacetedOptionSource({
    id: 'quantityAnomaly', header: '數量異常', filterType: 'boolean',
  }).minSearchLength, undefined);
});

test('欄頭 draft clone 不會與 canonical array filter 共用參照', () => {
  const draft = cloneColumnFilter(customerFilter);
  assert.notEqual(draft.value, customerFilter.value);
  (draft.value as string[]).push('SA');
  assert.deepEqual(customerFilter.value, ['SY', 'SM']);
});

test('facet fingerprint 排除目前欄位並正規化 filter 與 oneOf 順序', () => {
  const first = createColumnFilterOptionsFingerprint({
    tableId: 'fg_monthly_detailed',
    columnId: 'customerCode',
    runId: 56,
    dbSource: 'local',
    columnFilters: [
      customerFilter,
      { columnId: 'machine', operator: 'oneOf', value: ['U4', 'F7'], valueType: 'enum' },
      { columnId: 'stockWeeks', operator: 'gte', value: 2, valueType: 'numeric' },
    ],
    fixedScope: { shortageOnly: true, excludeTest: false },
  });
  const second = createColumnFilterOptionsFingerprint({
    tableId: 'fg_monthly_detailed',
    columnId: 'customerCode',
    runId: 56,
    dbSource: 'local',
    columnFilters: [
      { columnId: 'stockWeeks', operator: 'gte', value: 2, valueType: 'numeric' },
      { columnId: 'customerCode', operator: 'oneOf', value: ['SM'], valueType: 'enum' },
      { columnId: 'machine', operator: 'oneOf', value: ['F7', 'U4', 'F7'], valueType: 'enum' },
    ],
    fixedScope: { excludeTest: false, shortageOnly: true },
  });
  assert.equal(first, second);
});

test('facet fingerprint 隔離 Run、DB source、搜尋與固定 scope', () => {
  const base = {
    tableId: 'sales_meeting_detailed',
    columnId: 'customerCode',
    runId: 56,
    dbSource: 'local',
    globalSearch: '',
    columnFilters: [] as ColumnFilter[],
    fixedScope: { onlySY: false },
  };
  const fingerprint = createColumnFilterOptionsFingerprint(base);
  assert.notEqual(fingerprint, createColumnFilterOptionsFingerprint({ ...base, runId: 55 }));
  assert.notEqual(fingerprint, createColumnFilterOptionsFingerprint({ ...base, dbSource: 'docker' }));
  assert.notEqual(fingerprint, createColumnFilterOptionsFingerprint({ ...base, globalSearch: 'ABC' }));
  assert.notEqual(fingerprint, createColumnFilterOptionsFingerprint({
    ...base,
    fixedScope: { onlySY: true },
  }));
});
