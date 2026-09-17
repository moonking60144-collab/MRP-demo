import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachSharedErpCounts,
  attachSharedErpPoolInfo,
  buildSharedErpPoolUsageSet,
  resolveSharedErpPlanDisplayMember,
  selectSharedErpDisplayOwner,
  sumPhysicalInventoryByErp,
} from './shared-erp-display';

test('共享 ERP 成員數以整個 Run 為母體，不受目前分頁與排序影響', () => {
  const population = [
    { erpPartNo: 'ERP-A', partVersion: 'A-1' },
    { erpPartNo: 'ERP-B', partVersion: 'B-1' },
    { erpPartNo: 'ERP-A', partVersion: 'A-2' },
  ];

  const page = attachSharedErpCounts([population[2]], population);

  assert.equal(page[0].sharedErpCount, 2);
});

test('空 ERP 不會被歸成同一個共享池', () => {
  const rows = attachSharedErpCounts([
    { erpPartNo: null, partVersion: 'A' },
    { erpPartNo: '  ', partVersion: 'B' },
  ]);

  assert.deepEqual(rows.map((row) => row.sharedErpCount), [1, 1]);
});

test('同 ERP 有多個成品時標記為共享池', () => {
  const members = [
    { erpPartNo: 'ERP-A', partVersion: 'A-1' },
    { erpPartNo: 'ERP-A', partVersion: 'A-2' },
  ];

  const result = attachSharedErpPoolInfo([members[0]], members, []);

  assert.equal(result[0].sharedErpCount, 2);
  assert.equal(result[0].usesSharedErpPool, true);
});

test('單一成品但有未歸屬生產計畫時仍標記為共享池', () => {
  const members = [{ erpPartNo: 'ERP-A', partVersion: 'A-1' }];
  const sharedErps = buildSharedErpPoolUsageSet(members, [
    { erpPartNo: 'ERP-A', partVersion: null },
  ]);

  assert.equal(sharedErps.has('ERP-A'), true);
});

test('單一成品且生產計畫已正確歸屬時不標記為共享池', () => {
  const members = [{ erpPartNo: 'ERP-A', partVersion: 'A-1' }];
  const sharedErps = buildSharedErpPoolUsageSet(members, [
    { erpPartNo: 'ERP-A', partVersion: 'A-1' },
  ]);

  assert.equal(sharedErps.has('ERP-A'), false);
});

test('共用 ERP 未歸屬計畫只歸給固定 display owner，已歸屬計畫保留原成員', () => {
  const members = [
    { erpPartNo: 'ERP-A', partVersion: 'PV-B', customerCode: 'ZZ' },
    { erpPartNo: 'ERP-A', partVersion: 'PV-A', customerCode: 'AA' },
  ];

  assert.equal(selectSharedErpDisplayOwner(members)?.partVersion, 'PV-A');
  assert.equal(resolveSharedErpPlanDisplayMember(
    { erpPartNo: 'ERP-A', partVersion: null },
    members,
    true,
  )?.partVersion, 'PV-A');
  assert.equal(resolveSharedErpPlanDisplayMember(
    { erpPartNo: 'ERP-A', partVersion: 'PV-B' },
    members,
    true,
  )?.partVersion, 'PV-B');
  assert.equal(resolveSharedErpPlanDisplayMember(
    { erpPartNo: 'ERP-A', partVersion: 'PV-X' },
    members,
    false,
  ), null);
});

test('實體庫存合計按 ERP 去重，但沒有 ERP 的列仍各自計算', () => {
  const total = sumPhysicalInventoryByErp([
    { erpPartNo: 'ERP-A', partVersion: 'A-1', currentStockPc: '600', mainStockPc: '400', auxStockPc: '150', badStockPc: '10' },
    { erpPartNo: 'ERP-A', partVersion: 'A-2', currentStockPc: '600', mainStockPc: '400', auxStockPc: '150', badStockPc: '10' },
    { erpPartNo: null, partVersion: 'B-1', currentStockPc: '25', mainStockPc: '20', auxStockPc: '5', badStockPc: '2' },
    { erpPartNo: null, partVersion: 'B-2', currentStockPc: '30', mainStockPc: '10', auxStockPc: '10', badStockPc: '3' },
  ]);

  assert.deepEqual(total, {
    currentStockPc: 655,
    mainStockPc: 430,
    auxStockPc: 165,
    badStockPc: 15,
  });
});
