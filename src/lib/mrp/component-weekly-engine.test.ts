import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateComponentWeeklyPurchaseSupply,
  aggregateComponentWeeklyUsageRows,
  projectComponentWeeklyBalance,
  resolveComponentWeeklyInitialStock,
  resolveComponentWeeklyUnit,
  selectComponentWeeklyMaterialNumbers,
} from './component-weekly-engine';
import {
  normalizeComponentWeeklyMaterialPartNo,
  type ComponentWeeklyUsageBomRow,
} from './component-weekly-usage';
import { generateWeeklyPeriods } from './period-utils';

const weeks = generateWeeklyPeriods(new Date('2026-07-14T00:00:00.000Z'), 2);

function bomRow(overrides: Partial<ComponentWeeklyUsageBomRow> = {}): ComponentWeeklyUsageBomRow {
  return {
    sourceRecordId: '25393',
    componentNo: 'SCM435-I3-04.80-V01',
    woNumber: 'DEMO-WO-001',
    sourceType: '內製',
    processCode: '鍛造',
    unit: 'kg',
    minUsage: 250,
    alreadyPicked: 'Yes',
    issuedQty: 1041,
    remainingUsage: 0,
    issuedQtyState: 'known',
    issuedDetailCount: 1,
    issuedQtyError: null,
    startDate: new Date('2026-07-30T00:00:00.000Z'),
    ...overrides,
  };
}

test('已領足或超領的 BOM 仍建立元件可見性，但週需求維持 0', () => {
  const { usageMap, unitMap } = aggregateComponentWeeklyUsageRows([bomRow()], weeks);

  assert.equal(usageMap.has('SCM435-I3-04.80-V01'), true);
  assert.equal(usageMap.get('SCM435-I3-04.80-V01')?.size, 0);
  assert.equal(unitMap.get('SCM435-I3-04.80-V01'), 'kg');
});

test('有剩餘需求的 BOM 才寫入對應週別用量', () => {
  const { usageMap } = aggregateComponentWeeklyUsageRows([
    bomRow({
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      minUsage: 600,
      issuedQty: 100,
      remainingUsage: 500,
    }),
  ], weeks);

  assert.equal(usageMap.get('SCM435-I3-04.80-V01')?.get(weeks[0]!.label), 500);
});

test('元件需求優先依排程開始日分週，不使用過期的 BOM 日期', () => {
  const { usageMap } = aggregateComponentWeeklyUsageRows([
    bomRow({
      woNumber: 'DEMO-WO-002',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      minUsage: 4144,
      issuedQty: 2227,
      remainingUsage: 1917,
    }),
  ], weeks, {
    workOrderStartDates: new Map([
      ['DEMO-WO-002', new Date('2026-07-21T00:00:00.000Z')],
    ]),
  });

  assert.equal(usageMap.get('SCM435-I3-04.80-V01')?.get(weeks[1]!.label), 1917);
  assert.equal(usageMap.get('SCM435-I3-04.80-V01')?.has(weeks[0]!.label), false);
});

test('W 週推保留使用中、舊 Run 與本 Run BOM 引用的停用線材', () => {
  const inventoryMap = new Map([
    ['ACTIVE', { itemStatus: '使用中' }],
    ['LEGACY', { itemStatus: null }],
    ['INACTIVE-USED', { itemStatus: '作廢' }],
    ['INACTIVE-UNUSED', { itemStatus: '作廢' }],
  ]);
  const usageMap = new Map([
    ['INACTIVE-USED', new Map<string, number>()],
  ]);

  assert.deepEqual(
    selectComponentWeeklyMaterialNumbers('W', inventoryMap, usageMap),
    ['ACTIVE', 'LEGACY', 'INACTIVE-USED'],
  );
});

test('W 週推不把只有 BOM 引用、沒有線材庫存主檔的元件誤分類為線材', () => {
  const inventoryMap = new Map([
    ['INVENTORY-ONLY', { itemStatus: '使用中' }],
  ]);
  const usageMap = new Map([
    ['BOM-ONLY', new Map<string, number>()],
  ]);

  assert.deepEqual(
    selectComponentWeeklyMaterialNumbers('W', inventoryMap, usageMap),
    ['INVENTORY-ONLY'],
  );
});

test('元件週推保留庫存主檔的 canonical unit，不把原始數字直接改標成 kg', () => {
  assert.equal(resolveComponentWeeklyUnit('W', null, 'kg'), 'kg');
  assert.equal(resolveComponentWeeklyUnit('W', 'pc', 'kg'), 'pc');
  assert.equal(resolveComponentWeeklyUnit('W', null, 'pc', {
    stockPc: 0,
    stockKg: 1177,
  }), 'kg');
  assert.equal(resolveComponentWeeklyUnit('B', 'pc', 'kg'), 'pc');
  assert.equal(resolveComponentWeeklyUnit('D', null, 'pc'), 'pc');
  assert.equal(resolveComponentWeeklyUnit('D', null, null), null);
});

test('W 單位不明時 engine 與來源明細都不得把 pc 庫存當成起始庫存', () => {
  const inventory = { stockPc: 525000, stockKg: 951 };

  assert.equal(resolveComponentWeeklyInitialStock('W', null, inventory), 0);
  assert.equal(resolveComponentWeeklyInitialStock('W', 'kg', inventory), 951);
  assert.equal(resolveComponentWeeklyInitialStock('W', 'pc', inventory), 525000);
  assert.equal(resolveComponentWeeklyInitialStock('B', null, inventory), 525000);
});

test('W 線材同料號混用 kg 與 pc 時只納入 canonical unit，異常列不得混算', () => {
  const result = aggregateComponentWeeklyUsageRows([
    bomRow({
      sourceRecordId: 'kg-row',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'kg',
      remainingUsage: 500,
    }),
    bomRow({
      sourceRecordId: 'pc-row',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'pc',
      remainingUsage: 537,
    }),
  ], weeks, {
    enforceUnitConsistency: true,
    canonicalUnits: new Map([['SCM435-I3-04.80-V01', 'kg']]),
  });

  assert.equal(
    result.usageMap.get('SCM435-I3-04.80-V01')?.get(weeks[0]!.label),
    500,
  );
  assert.equal(result.unitMap.get('SCM435-I3-04.80-V01'), 'kg');
  assert.equal(result.unitMismatchCountMap.get('SCM435-I3-04.80-V01'), 1);
});

test('W 線材庫存無法判定單位且 BOM 混用 kg 與 pc 時不得依資料順序選單位', () => {
  const result = aggregateComponentWeeklyUsageRows([
    bomRow({
      sourceRecordId: 'kg-row',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'kg',
      remainingUsage: 500,
    }),
    bomRow({
      sourceRecordId: 'pc-row',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'pc',
      remainingUsage: 537,
    }),
  ], weeks, {
    enforceUnitConsistency: true,
    canonicalUnits: new Map([['SCM435-I3-04.80-V01', null]]),
  });

  assert.equal(result.usageMap.get('SCM435-I3-04.80-V01')?.size, 0);
  assert.equal(result.unitMap.has('SCM435-I3-04.80-V01'), false);
  assert.equal(result.unitMismatchCountMap.get('SCM435-I3-04.80-V01'), 2);
});

test('W 線材庫存無法判定單位但 BOM 單位唯一時可採用該來源單位', () => {
  const result = aggregateComponentWeeklyUsageRows([
    bomRow({
      sourceRecordId: 'kg-row-1',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'kg',
      remainingUsage: 500,
    }),
    bomRow({
      sourceRecordId: 'kg-row-2',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
      unit: 'KG',
      remainingUsage: 250,
    }),
  ], weeks, {
    enforceUnitConsistency: true,
    canonicalUnits: new Map([['SCM435-I3-04.80-V01', null]]),
  });

  assert.equal(
    result.usageMap.get('SCM435-I3-04.80-V01')?.get(weeks[0]!.label),
    750,
  );
  assert.equal(result.unitMap.get('SCM435-I3-04.80-V01')?.toLowerCase(), 'kg');
  assert.equal(result.unitMismatchCountMap.has('SCM435-I3-04.80-V01'), false);
});

test('元件週推排除 Source 星號與句點占位料號', () => {
  const inventoryMap = new Map([
    ['*', { itemStatus: '使用中' }],
    ['.', { itemStatus: '使用中' }],
    ['WIRE-01', { itemStatus: '使用中' }],
  ]);
  const usageMap = new Map<string, Map<string, number>>();

  assert.equal(normalizeComponentWeeklyMaterialPartNo('*'), null);
  assert.equal(normalizeComponentWeeklyMaterialPartNo(' . '), null);
  assert.equal(normalizeComponentWeeklyMaterialPartNo(' WIRE-01 '), 'WIRE-01');
  assert.deepEqual(
    selectComponentWeeklyMaterialNumbers('W', inventoryMap, usageMap),
    ['WIRE-01'],
  );
  assert.equal(
    aggregateComponentWeeklyUsageRows([
      bomRow({ componentNo: '*' }),
      bomRow({ componentNo: '.' }),
    ], weeks).usageMap.size,
    0,
  );
});

test('B 與 D 週推的料號集合由 BOM 引用決定', () => {
  const inventoryMap = new Map([
    ['INVENTORY-ONLY', { itemStatus: '使用中' }],
  ]);
  const usageMap = new Map([
    ['BOM-A', new Map<string, number>()],
    ['BOM-B', new Map<string, number>()],
  ]);

  assert.deepEqual(selectComponentWeeklyMaterialNumbers('B', inventoryMap, usageMap), ['BOM-A', 'BOM-B']);
  assert.deepEqual(selectComponentWeeklyMaterialNumbers('D', inventoryMap, usageMap), ['BOM-A', 'BOM-B']);
});

test('前期需求已使庫存為負時，缺貨起始為前期而不是 W01', () => {
  const projectionWeeks = generateWeeklyPeriods(new Date('2026-08-04T00:00:00.000Z'), 17);
  const usage = new Map<string, number>([
    ['PRIOR', 58_000],
    [projectionWeeks[10]!.label, 54_000],
  ]);

  const result = projectComponentWeeklyBalance({
    initialStock: 0,
    usage,
    supply: new Map(),
    weeks: projectionWeeks,
  });

  assert.equal(result.shortageStartWeek, 0);
  assert.equal(result.shortageStartDate, null);
  assert.equal(result.shortageQty, 58_000);
  assert.equal(result.periods[0]!.endingStock, -58_000);
  assert.equal(result.periods[11]!.endingStock, -112_000);
});

test('未來工令需求落在實際週別並保留首次缺口', () => {
  const projectionWeeks = generateWeeklyPeriods(new Date('2026-08-04T00:00:00.000Z'), 17);
  const usage = new Map<string, number>([
    [projectionWeeks[16]!.label, 206_000],
  ]);

  const result = projectComponentWeeklyBalance({
    initialStock: 0,
    usage,
    supply: new Map(),
    weeks: projectionWeeks,
  });

  assert.equal(result.shortageStartWeek, 17);
  assert.equal(result.shortageStartDate?.toISOString().slice(0, 10), '2026-11-23');
  assert.equal(result.shortageQty, 206_000);
});

test('逾期未進貨 PO 保留催交證據但不納入可用供給', () => {
  const projectionWeeks = generateWeeklyPeriods(new Date('2026-08-04T00:00:00.000Z'), 4);
  const result = aggregateComponentWeeklyPurchaseSupply([
    {
      productNo: 'SAE1022-B3-05.80-V01',
      deliveryDate: new Date('2026-07-24T00:00:00.000Z'),
      unreceivedQty: 2_250,
    },
    {
      productNo: 'SAE1022-B3-05.80-V01',
      deliveryDate: new Date('2026-08-17T00:00:00.000Z'),
      unreceivedQty: 500,
    },
  ], projectionWeeks, new Date('2026-08-04T07:46:00.000Z'));

  const materialSupply = result.supplyMap.get('SAE1022-B3-05.80-V01');
  const meta = result.purchaseMetaMap.get('SAE1022-B3-05.80-V01');
  assert.equal(materialSupply?.has('PRIOR'), false);
  assert.equal(materialSupply?.get(projectionWeeks[2]!.label), 500);
  assert.deepEqual(meta, {
    overduePurchaseQty: 2_250,
    overduePurchaseCount: 1,
    futurePurchaseQty: 500,
    futurePurchaseCount: 1,
    nextPurchaseReceiptDate: new Date('2026-08-17T00:00:00.000Z'),
  });
});

test('Run 當週週一已到期 PO 依 Run 日視為逾期，同日交期仍計入供給', () => {
  const runDate = new Date('2026-08-04T07:46:00.000Z');
  const projectionWeeks = generateWeeklyPeriods(runDate, 2);
  const result = aggregateComponentWeeklyPurchaseSupply([
    {
      productNo: '91303-M9Q-0000-V01-01BU',
      deliveryDate: new Date('2026-08-03T00:00:00.000Z'),
      unreceivedQty: 58_000,
    },
    {
      productNo: '91303-M9Q-0000-V01-01BU',
      deliveryDate: new Date('2026-08-04T00:00:00.000Z'),
      unreceivedQty: 54_000,
    },
  ], projectionWeeks, runDate);

  const materialSupply = result.supplyMap.get('91303-M9Q-0000-V01-01BU');
  const meta = result.purchaseMetaMap.get('91303-M9Q-0000-V01-01BU');
  assert.equal(materialSupply?.get(projectionWeeks[0]!.label), 54_000);
  assert.deepEqual(meta, {
    overduePurchaseQty: 58_000,
    overduePurchaseCount: 1,
    futurePurchaseQty: 54_000,
    futurePurchaseCount: 1,
    nextPurchaseReceiptDate: new Date('2026-08-04T00:00:00.000Z'),
  });
});
