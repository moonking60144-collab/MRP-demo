import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSalesMeetingPeriodMap,
  expandSalesMeetingFacetRows,
  groupSalesMeetingPeriods,
  groupSalesMeetingRows,
  type SalesMeetingGroupableRow,
} from './sales-meeting-display';

function summary(partVersion: string, overrides: Partial<SalesMeetingGroupableRow> = {}): SalesMeetingGroupableRow {
  return {
    id: partVersion.endsWith('V00') ? 2 : 1,
    mrpRunId: 56,
    customerCode: 'SY',
    customerPartNo: '11210-H6B-3000',
    partVersion,
    erpPartNo: '11203-H6B-0000-V01-11PA',
    unit: 'PC',
    goodStockPc: 4369,
    goodStockKg: 149.4198,
    mainStockPc: 0,
    auxStockPc: 4369,
    badStockPc: 0,
    badStockKg: 0,
    avgDemandPerWeek: 0,
    stockWeeks: 22.6,
    shortageStartWeek: null,
    purchaseLeadWeeks: 0,
    outstanding04: 0,
    fgDiff04: 1856,
    fgStatus04: '無訂單',
    totalOrderDemand: 0,
    totalFgDiff: 1856,
    ...overrides,
  };
}

test('客戶料號彙總只加總需求，不重複加總同 ERP 庫存', () => {
  const grouped = groupSalesMeetingRows([
    summary('DEMO-PRODUCT-002', {
      avgDemandPerWeek: 193.3,
      outstanding04: 2513,
      totalOrderDemand: 2513,
      fgStatus04: '足夠',
    }),
    summary('DEMO-PRODUCT-002-R1'),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.goodStockPc, 4369);
  assert.equal(grouped[0]?.totalOrderDemand, 2513);
  assert.equal(grouped[0]?.avgDemandPerWeek, 193.3);
  assert.deepEqual(grouped[0]?.memberPartVersions, [
    'DEMO-PRODUCT-002',
    'DEMO-PRODUCT-002-R1',
  ]);
});

test('不同 ERP 料號不會因客戶料號相同而合併', () => {
  const rows = groupSalesMeetingRows([
    summary('DEMO-PRODUCT-002'),
    summary('DEMO-PRODUCT-002-R1', { erpPartNo: 'ANOTHER-ERP' }),
  ]);
  assert.equal(rows.length, 2);
});

test('客料版本 facet 展開群組內全部成員，不只顯示代表版本', () => {
  const grouped = groupSalesMeetingRows([
    summary('DEMO-PRODUCT-002'),
    summary('DEMO-PRODUCT-002-R1'),
  ]);

  assert.deepEqual(expandSalesMeetingFacetRows(grouped, 'partVersion'), [
    { partVersion: 'DEMO-PRODUCT-002' },
    { partVersion: 'DEMO-PRODUCT-002-R1' },
  ]);
  assert.deepEqual(expandSalesMeetingFacetRows(grouped, 'customerCode'), grouped);
});

test('彙總週期加總需求與供給，期末取完成所有成員扣用後的較小餘額', () => {
  const periods = groupSalesMeetingPeriods([
    {
      id: 1,
      mrpRunId: 56,
      partVersion: 'SY-A',
      weekIndex: 2,
      weekLabel: 'W02',
      weekStart: '2026-08-10',
      remainingStock: 16110,
      demand: 400,
      supply: 100,
    },
    {
      id: 2,
      mrpRunId: 56,
      partVersion: 'SY-A-V00',
      weekIndex: 2,
      weekLabel: 'W02',
      weekStart: '2026-08-10',
      remainingStock: 15710,
      demand: 300,
      supply: 0,
    },
  ], 'SY-A');

  assert.deepEqual(periods.map((period) => ({
    demand: period.demand,
    supply: period.supply,
    remainingStock: period.remainingStock,
  })), [{ demand: 700, supply: 100, remainingStock: 15710 }]);
});

test('期間索引一次分派多個客料群組且保留原始列順序', () => {
  const rows = [
    {
      id: 1, mrpRunId: 56, partVersion: 'PV-A', weekIndex: 1,
      weekLabel: 'W01', weekStart: '2026-08-03', remainingStock: 90, demand: 10, supply: 0,
    },
    {
      id: 2, mrpRunId: 56, partVersion: 'PV-A-V00', weekIndex: 1,
      weekLabel: 'W01', weekStart: '2026-08-03', remainingStock: 70, demand: 20, supply: 5,
    },
    {
      id: 3, mrpRunId: 56, partVersion: 'PV-B', weekIndex: 1,
      weekLabel: 'W01', weekStart: '2026-08-03', remainingStock: 40, demand: 30, supply: 0,
    },
  ];
  const groups = [
    { partVersion: 'PV-A', memberPartVersions: ['PV-A', 'PV-A-V00'] },
    { partVersion: 'PV-B', memberPartVersions: ['PV-B'] },
  ];

  const indexed = buildSalesMeetingPeriodMap(rows, groups);
  const reference = Object.fromEntries(groups.map((group) => [
    group.partVersion,
    groupSalesMeetingPeriods(
      rows.filter((row) => group.memberPartVersions.includes(row.partVersion)),
      group.partVersion,
    ),
  ]));

  assert.deepEqual(indexed, reference);
  assert.deepEqual(indexed['PV-A'].map((period) => ({
    demand: period.demand,
    supply: period.supply,
    remainingStock: period.remainingStock,
  })), [{ demand: 30, supply: 5, remainingStock: 70 }]);
});
