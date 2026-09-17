import assert from 'node:assert/strict';
import test from 'node:test';
import { isYe1Warehouse, matchesWarehouseStockFilter } from './warehouse-stock';

const lots = [
  { includedInMrp: true, quantityAnomaly: true, qualityStatus: '正常' },
  { includedInMrp: true, quantityAnomaly: false, qualityStatus: '待驗' },
  { includedInMrp: false, quantityAnomaly: false, qualityStatus: '不良' },
  { includedInMrp: false, quantityAnomaly: false, qualityStatus: null },
];

test('數量異常分類只顯示需要處理的 MRP 可用批號', () => {
  assert.deepEqual(
    lots.map((lot) => matchesWarehouseStockFilter(lot, 'ANOMALY')),
    [true, false, false, false],
  );
});

test('庫存批號分類保留 MRP、排除與品質狀態既有語意', () => {
  assert.deepEqual(
    lots.map((lot) => matchesWarehouseStockFilter(lot, 'MRP')),
    [true, true, false, false],
  );
  assert.deepEqual(
    lots.map((lot) => matchesWarehouseStockFilter(lot, 'EXCLUDED')),
    [false, false, true, true],
  );
  assert.deepEqual(
    lots.map((lot) => matchesWarehouseStockFilter(lot, 'QUALITY:不良')),
    [false, false, true, false],
  );
  assert.deepEqual(
    lots.map((lot) => matchesWarehouseStockFilter(lot, 'QUALITY:未設定')),
    [false, false, false, true],
  );
});

test('YE1 倉別判斷忽略前後空白與大小寫', () => {
  assert.equal(isYe1Warehouse('YE1'), true);
  assert.equal(isYe1Warehouse(' ye1 '), true);
  assert.equal(isYe1Warehouse('WFG'), false);
  assert.equal(isYe1Warehouse(null), false);
});
