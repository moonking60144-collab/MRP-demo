import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  prioritizeSortFields,
  sanitizeSortState,
} from '../components/data-table/hooks/use-table-sorting';
import { normalizeFgMonthlyDecimals } from './mrp/fg-monthly-output';
import { applySort } from './mrp/merge-helpers';

test('右鍵排序把點選欄位設為第一排序並保留既有欄位作為次要排序', () => {
  const result = prioritizeSortFields([
    { id: 'forgingParent', direction: 'asc', label: '鍛造母件' },
    { id: 'customerPartNo', direction: 'asc', label: '客戶料號' },
    { id: 'erpPartNo', direction: 'asc', label: 'ERP料號' },
  ], {
    id: 'mainStockPc',
    direction: 'desc',
    label: '廠內（非AUX）在庫pc',
  });

  assert.deepEqual(result.map((field) => `${field.id}:${field.direction}`), [
    'mainStockPc:desc',
    'forgingParent:asc',
    'customerPartNo:asc',
    'erpPartNo:asc',
  ]);
});

test('右鍵切換既有排序欄方向時會移到第一順位且不重複', () => {
  const result = prioritizeSortFields([
    { id: 'forgingParent', direction: 'asc', label: '鍛造母件' },
    { id: 'mainStockPc', direction: 'asc', label: '廠內（非AUX）在庫pc' },
  ], {
    id: 'mainStockPc',
    direction: 'desc',
    label: '廠內（非AUX）在庫pc',
  });

  assert.deepEqual(result.map((field) => `${field.id}:${field.direction}`), [
    'mainStockPc:desc',
    'forgingParent:asc',
  ]);
});

test('合併資料庫的 Prisma Decimal 先正規化再做數值降冪排序', () => {
  const rows = [
    { partVersion: 'A', mainStockPc: new Prisma.Decimal(992) },
    { partVersion: 'B', mainStockPc: new Prisma.Decimal(9947) },
    { partVersion: 'C', mainStockPc: new Prisma.Decimal(12000) },
  ].map((row) => normalizeFgMonthlyDecimals(row));

  const sorted = applySort(rows, [{ key: 'mainStockPc', dir: 'desc' }]);
  assert.deepEqual(sorted.map((row) => row.mainStockPc), [12000, 9947, 992]);
});

test('瀏覽器舊排序設定會移除已不存在的欄位', () => {
  assert.deepEqual(
    sanitizeSortState({
      fields: [
        { id: 'removedColumn', direction: 'desc', label: '舊欄位' },
        { id: 'erpPartNo', direction: 'asc', label: 'ERP料號' },
      ],
    }, new Set(['erpPartNo'])),
    {
      fields: [{ id: 'erpPartNo', direction: 'asc', label: 'ERP料號' }],
    },
  );
});
