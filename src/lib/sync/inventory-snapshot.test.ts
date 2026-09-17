import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasInventoryLotQuantityValidation,
  hasInventoryLotSnapshot,
  evaluateInventoryLotQuantity,
  isMrpAvailableInventoryQuality,
  normalizeInventoryLot,
  resolveInventoryAvailability,
  summarizeInventoryAnomalies,
  summarizeInventoryLots,
} from './inventory-snapshot';

test('只有 Run 同步統計含 inventory_lots 才代表有倉別快照', () => {
  assert.equal(hasInventoryLotSnapshot({ inventory_lots: 2307, inventory: 3038 }), true);
  assert.equal(hasInventoryLotSnapshot({ inventory_lots: 0 }), true);
  assert.equal(hasInventoryLotSnapshot({ inventory: 3037 }), false);
  assert.equal(hasInventoryLotSnapshot(null), false);
  assert.equal(hasInventoryLotSnapshot([]), false);
});


test('只有新版 Run marker 才代表庫存批號已執行數量驗證', () => {
  assert.equal(hasInventoryLotQuantityValidation({ inventory_lot_validation_v1: 1 }), true);
  assert.equal(hasInventoryLotQuantityValidation({ inventory_lots: 2307 }), false);
  assert.equal(hasInventoryLotQuantityValidation(null), false);
});

test('庫存快照保留所有在庫品質，但排除非在庫狀態', () => {
  const base = {
    ragicRecordId: '101',
    lotNo: 'LOT-1',
    erpPartNo: 'ERP-A',
    warehouseCode: 'WFG',
    stockStatus: '在庫',
    qualityStatus: '正常',
    stockPc: '1,200',
    stockKg: '12.5',
    unitWeightG: '10',
    sourceWorkOrderNo: 'WO-001',
    sourceWorkOrderType: '內製',
  };

  assert.deepEqual(normalizeInventoryLot(base), {
    ragicRecordId: '101',
    lotNo: 'LOT-1',
    erpPartNo: 'ERP-A',
    warehouseCode: 'WFG',
    stockStatus: '在庫',
    qualityStatus: '正常',
    stockPc: 1200,
    stockKg: 12.5,
    unitWeightG: 10,
    expectedStockPc: 1250,
    stockPcDiff: -50,
    stockPcDiffPct: 0.041666666666666664,
    quantityAnomaly: true,
    sourceWorkOrderNo: 'WO-001',
    sourceWorkOrderType: '內製',
  });
  assert.equal(normalizeInventoryLot({ ...base, stockStatus: '工令領用' }), null);
  assert.equal(normalizeInventoryLot({ ...base, qualityStatus: '不良' })?.qualityStatus, '不良');
  assert.equal(normalizeInventoryLot({ ...base, qualityStatus: '' })?.qualityStatus, null);
  assert.ok(normalizeInventoryLot({ ...base, qualityStatus: '待驗暫先放行' }));
  assert.equal(normalizeInventoryLot({ ...base, warehouseCode: ' ye1 ' })?.warehouseCode, 'YE1');
  assert.equal(isMrpAvailableInventoryQuality('正常'), true);
  assert.equal(isMrpAvailableInventoryQuality('待驗'), true);
  assert.equal(isMrpAvailableInventoryQuality('不良'), false);
});

test('MRP合計只納入允許品質，再以 YE1 和非 YE1 拆分', () => {
  const summary = summarizeInventoryLots([
    { erpPartNo: 'ERP-A', warehouseCode: 'WFG', stockStatus: '在庫', qualityStatus: '正常', stockPc: 100, stockKg: 1 },
    { erpPartNo: 'ERP-A', warehouseCode: 'YE1', stockStatus: '在庫', qualityStatus: '待驗', stockPc: 60, stockKg: 0.5 },
    { erpPartNo: 'ERP-A', warehouseCode: 'WIP', stockStatus: '在庫', qualityStatus: '待驗暫先放行', stockPc: 40, stockKg: 0.5 },
    { erpPartNo: 'ERP-A', warehouseCode: null, stockStatus: '在庫', qualityStatus: '正常', stockPc: 20, stockKg: 0.5 },
    { erpPartNo: 'ERP-A', warehouseCode: 'WFG', stockStatus: '在庫', qualityStatus: '不良', stockPc: 999, stockKg: 9 },
  ]).get('ERP-A');

  assert.deepEqual(summary, {
    inStockPc: 220,
    inStockKg: 2.5,
    wfgStockPc: 160,
    wfgStockKg: 2,
    ye1StockPc: 60,
    ye1StockKg: 0.5,
  });
});

test('新 Run 使用在庫快照，舊 Run 才 fallback 到原良品總量', () => {
  assert.equal(resolveInventoryAvailability({ goodStockPc: 335558, goodStockKg: 10 }).inStockPc, 335558);
  assert.deepEqual(resolveInventoryAvailability({
    goodStockPc: 335558,
    goodStockKg: 10,
    inStockPc: 199934,
    inStockKg: 6,
    wfgStockPc: 100000,
    ye1StockPc: 99934,
  }), {
    inStockPc: 199934,
    inStockKg: 6,
    wfgStockPc: 100000,
    wfgStockKg: 0,
    ye1StockPc: 99934,
    ye1StockKg: 0,
  });
  assert.equal(resolveInventoryAvailability({ goodStockPc: 100, goodStockKg: 5, inStockPc: 0 }).inStockPc, 0);
});


test('庫存批號以公斤與單位重推算 pc，差異同時超過 2pc 與 1% 才列為異常', () => {
  assert.deepEqual(evaluateInventoryLotQuantity({
    stockPc: 15501,
    stockKg: 171.64427,
    unitWeightG: 11.69,
  }), {
    unitWeightG: 11.69,
    expectedStockPc: 14683,
    stockPcDiff: 818,
    stockPcDiffPct: 818 / 15501,
    quantityAnomaly: true,
  });

  assert.equal(evaluateInventoryLotQuantity({
    stockPc: 1000,
    stockKg: 10.01,
    unitWeightG: 10,
  }).quantityAnomaly, false);
  assert.equal(evaluateInventoryLotQuantity({
    stockPc: 100,
    stockKg: 0.97,
    unitWeightG: 10,
  }).quantityAnomaly, true);
  assert.equal(evaluateInventoryLotQuantity({
    stockPc: 50000,
    stockKg: 499.9,
    unitWeightG: 10,
  }).quantityAnomaly, false);
});

test('缺少有效單位重時保留原始庫存，但不虛構異常', () => {
  assert.deepEqual(evaluateInventoryLotQuantity({
    stockPc: 15501,
    stockKg: 171.64427,
    unitWeightG: null,
  }), {
    unitWeightG: null,
    expectedStockPc: null,
    stockPcDiff: null,
    stockPcDiffPct: null,
    quantityAnomaly: false,
  });
});


test('異常摘要只計入 MRP 可用品質且在庫的批號', () => {
  const summaries = summarizeInventoryAnomalies([
    { erpPartNo: 'ERP-A', stockStatus: '在庫', qualityStatus: '正常', quantityAnomaly: true, stockPcDiff: 818 },
    { erpPartNo: 'ERP-A', stockStatus: '在庫', qualityStatus: '待驗', quantityAnomaly: true, stockPcDiff: -50 },
    { erpPartNo: 'ERP-A', stockStatus: '在庫', qualityStatus: '不良', quantityAnomaly: true, stockPcDiff: 999 },
    { erpPartNo: 'ERP-B', stockStatus: '在庫', qualityStatus: '正常', quantityAnomaly: false, stockPcDiff: 0 },
  ]);

  assert.deepEqual(summaries.get('ERP-A'), {
    count: 2,
    absoluteDiffPc: 868,
    erpPartNos: ['ERP-A'],
  });
  assert.equal(summaries.has('ERP-B'), false);
});
