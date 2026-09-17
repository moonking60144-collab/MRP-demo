import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterPartVersionsByInventoryAnomalyCount,
  isTestErpPartNo,
  matchesNumericColumnFilter,
  parseNumericColumnFilter,
} from './fg-monthly-filters';

test('ERP料號包含 TEST 時不分大小寫判定為測試資料', () => {
  assert.equal(isTestErpPartNo('TESTPART-V01'), true);
  assert.equal(isTestErpPartNo('abc-test-001'), true);
  assert.equal(isTestErpPartNo('TeSt-ERP'), true);
});
test('正式 ERP料號與空值不判定為測試資料', () => {
  assert.equal(isTestErpPartNo('DEMO-ERP-003-V01'), false);
  assert.equal(isTestErpPartNo(''), false);
  assert.equal(isTestErpPartNo(null), false);
});


test('庫存異常欄位可解析並套用大於 0 的數值篩選', () => {
  const filter = parseNumericColumnFilter('gt:0');
  assert.ok(filter);
  assert.equal(matchesNumericColumnFilter(0, filter), false);
  assert.equal(matchesNumericColumnFilter(1, filter), true);
});

test('庫存異常欄位接受資料表 numeric equalsNumber 契約', () => {
  const filter = parseNumericColumnFilter('equalsNumber:2');
  assert.ok(filter);
  assert.equal(matchesNumericColumnFilter(2, filter), true);
  assert.equal(matchesNumericColumnFilter(1, filter), false);
});

test('庫存異常欄位以 null 判定為空或非空', () => {
  const empty = parseNumericColumnFilter('isEmpty:');
  const notEmpty = parseNumericColumnFilter('isNotEmpty:');
  assert.ok(empty);
  assert.ok(notEmpty);
  assert.equal(matchesNumericColumnFilter(null, empty), true);
  assert.equal(matchesNumericColumnFilter(0, empty), false);
  assert.equal(matchesNumericColumnFilter(null, notEmpty), false);
  assert.equal(matchesNumericColumnFilter(0, notEmpty), true);
});

test('庫存異常篩選依一般 ERP 或聚合成員的異常筆數選出料號', () => {
  const rows = [
    { partVersion: 'NORMAL-A', erpPartNo: 'ERP-A', aggregatedMembers: [] },
    { partVersion: 'NORMAL-B', erpPartNo: 'ERP-B', aggregatedMembers: [] },
    { partVersion: 'GROUP-AB', erpPartNo: null, aggregatedMembers: ['MEMBER-A', 'MEMBER-B'] },
  ];
  const memberErps = new Map([
    ['MEMBER-A', 'ERP-A'],
    ['MEMBER-B', 'ERP-B'],
  ]);
  const anomalyCounts = new Map([
    ['ERP-A', 2],
    ['ERP-B', 0],
  ]);
  const filter = parseNumericColumnFilter('gt:0');
  assert.ok(filter);

  assert.deepEqual(
    filterPartVersionsByInventoryAnomalyCount(rows, memberErps, anomalyCounts, filter),
    ['NORMAL-A', 'GROUP-AB'],
  );
});
