import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FG_MONTHLY_DETAILED_COLUMNS,
  FG_MONTHLY_SIMPLE_COLUMNS,
  FG_TRAD_STATIC,
  FG_TRAD_WAREHOUSE,
  FG_TRAD_PERIOD_COLUMNS,
  FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
} from '../../components/data-table/column-defs/fg-monthly-columns';
import {
  buildHiddenColumnPreference,
  mergeColumnVisibility,
  readStoredColumnVisibility,
} from '../../components/data-table/hooks/use-column-visibility';
import {
  FG_MONTHLY_COLUMN_VISIBILITY_KEY,
  migrateFgMonthlyColumnVisibility,
} from './fg-monthly-column-visibility';

function createStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test('成品月推將主庫存標示為可用庫存', () => {
  const detailedStock = FG_MONTHLY_DETAILED_COLUMNS.find((column) => column.id === 'currentStockPc');
  const traditionalStock = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'currentStockPc');

  assert.equal(detailedStock?.header, '可用成品庫存pc');
  assert.equal(traditionalStock?.header, '可用成品庫存pc');
  assert.notEqual(detailedStock?.defaultVisible, false);
  assert.notEqual(traditionalStock?.defaultVisible, false);
});

test('成品月推所有既有欄位預設顯示', () => {
  const detailedBadStock = FG_MONTHLY_DETAILED_COLUMNS.find((column) => column.id === 'badStockPc');
  const traditionalBadStock = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'badStockPc');

  assert.ok(detailedBadStock);
  assert.ok(traditionalBadStock);
  assert.equal(FG_MONTHLY_DETAILED_COLUMNS.every((column) => column.defaultVisible !== false), true);
  assert.equal(FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.every((column) => column.defaultVisible !== false), true);
});

test('鍛造進度欄使用業務名稱，計畫累計欄預設顯示', () => {
  const scheduled = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'woScheduled');
  const total = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'woTotal');
  const reported = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'planReportedQty');
  const closed = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.find((column) => column.id === 'planClosedQty');

  assert.equal(scheduled?.header, '鍛造已排');
  assert.equal(total?.header, '鍛造未結合計');
  assert.equal(reported?.header, '計畫累計報工');
  assert.equal(closed?.header, '計畫累計結案入庫');
  assert.notEqual(reported?.defaultVisible, false);
  assert.notEqual(closed?.defaultVisible, false);
});

test('成品月推欄位偏好升版時保留使用者隱藏項並清除舊系統強制隱藏', () => {
  const storage = createStorage({
    mrp_colvis_fg_v2: JSON.stringify({
      surfaceTreatment: false,
      woTotal: false,
      currentStockPc: true,
      badStockPc: true,
      planReportedQty: true,
      planClosedQty: true,
    }),
  });

  assert.equal(migrateFgMonthlyColumnVisibility(storage), true);
  assert.deepEqual(
    JSON.parse(storage.getItem(FG_MONTHLY_COLUMN_VISIBILITY_KEY) ?? '{}'),
    {
      surfaceTreatment: false,
      woTotal: false,
    },
  );
});

test('月份區塊有穩定 ID 且全部預設顯示', () => {
  assert.equal(FG_TRAD_PERIOD_COLUMNS.length, 7);
  assert.equal(FG_TRAD_PERIOD_COLUMNS.every((column) => column.id.startsWith('period.')), true);
  assert.equal(FG_TRAD_PERIOD_COLUMNS.every((column) => column.defaultVisible !== false), true);
  assert.equal(new Set(FG_TRAD_PERIOD_COLUMNS.map((column) => column.id)).size, 7);
});

test('廠內與 AUX 是獨立倉庫區段，簡易表排在期末無計劃剩餘前', () => {
  assert.deepEqual(FG_TRAD_WAREHOUSE.map((column) => column.key), ['mainStockPc', 'auxStockPc']);
  assert.equal(FG_TRAD_STATIC.some((column) => column.key === 'mainStockPc' || column.key === 'auxStockPc'), false);

  const ids = FG_MONTHLY_SIMPLE_COLUMNS.map((column) => column.id);
  const mainIndex = ids.indexOf('mainStockPc');
  const auxIndex = ids.indexOf('auxStockPc');
  const remainingIndex = ids.indexOf('lastPeriodRemainingNoPlan');
  assert.equal(auxIndex, mainIndex + 1);
  assert.equal(remainingIndex, auxIndex + 1);
});

test('hidden-only 偏好讓新欄預設顯示並保留另一個 view 的隱藏項', () => {
  const merged = mergeColumnVisibility(
    { currentStockPc: true, mainStockPc: true, auxStockPc: true },
    { currentStockPc: false, removedColumn: false },
  );
  assert.deepEqual(merged, {
    currentStockPc: false,
    mainStockPc: true,
    auxStockPc: true,
  });

  const hidden = buildHiddenColumnPreference(
    ['currentStockPc', 'mainStockPc', 'auxStockPc'],
    { currentStockPc: true, mainStockPc: false, auxStockPc: true },
    { 'period.forecastQty': false, currentStockPc: false },
  );
  assert.deepEqual(hidden, {
    'period.forecastQty': false,
    mainStockPc: false,
  });
});

test('成品月推已有新版欄位偏好時不重複覆寫', () => {
  const current = JSON.stringify({ badStockPc: true, woTotal: false });
  const storage = createStorage({
    mrp_colvis_fg_v2: JSON.stringify({ badStockPc: false, woTotal: true }),
    [FG_MONTHLY_COLUMN_VISIBILITY_KEY]: current,
  });

  assert.equal(migrateFgMonthlyColumnVisibility(storage), false);
  assert.equal(storage.getItem(FG_MONTHLY_COLUMN_VISIBILITY_KEY), current);
});

test('成品月推舊欄位偏好損壞時安全沿用新版預設', () => {
  const storage = createStorage({ mrp_colvis_fg_v2: '{broken-json' });

  assert.equal(migrateFgMonthlyColumnVisibility(storage), false);
  assert.equal(storage.getItem(FG_MONTHLY_COLUMN_VISIBILITY_KEY), null);
});

test('瀏覽器拒絕讀取 localStorage 時欄位偏好安全回到預設', () => {
  const blockedStorage = {
    getItem: () => {
      throw new Error('SecurityError');
    },
  };

  assert.deepEqual(readStoredColumnVisibility(blockedStorage, FG_MONTHLY_COLUMN_VISIBILITY_KEY), {});
});
