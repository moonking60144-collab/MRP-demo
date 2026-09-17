import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySerializedColumnFiltersToPrismaWhere,
  applySerializedColumnFiltersToRows,
  collectColumnFacetOptions,
  collectCustomerCodeOptions,
  collectCustomerCodeFacetOptions,
  excludeSerializedColumnFilter,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
} from './data-table-server-filters';
import {
  sanitizeColumnFilters,
  serializeColumnFilter,
} from '@/components/data-table/hooks/use-table-filtering';
import { applyColumnFilter } from '@/components/data-table/utils/filter-fns';

test('前端序列化時保留數值與日期型別', () => {
  assert.equal(
    serializeColumnFilter({
      columnId: 'sortGroup',
      operator: 'equals',
      value: 9,
      valueType: 'numeric',
    }),
    'equalsNumber:9',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'deliveryDate',
      operator: 'gte',
      value: '2026-07-23',
      valueType: 'date',
    }),
    'gteDate:2026-07-23',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'shouldPlanProduction',
      operator: 'equals',
      value: 'true',
      valueType: 'boolean',
    }),
    'equalsBoolean:true',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'customerCode',
      operator: 'oneOf',
      value: ['SY', 'SM'],
      valueType: 'enum',
    }),
    'oneOf:["SY","SM"]',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'sortGroup',
      operator: 'oneOf',
      value: ['8', '9'],
      valueType: 'numeric',
    }),
    'oneOfNumber:["8","9"]',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'deliveryDate',
      operator: 'oneOf',
      value: ['2026-08-24'],
      valueType: 'date',
    }),
    'oneOfDate:["2026-08-24"]',
  );
  assert.equal(
    serializeColumnFilter({
      columnId: 'shouldPlanProduction',
      operator: 'oneOf',
      value: ['true'],
      valueType: 'boolean',
    }),
    'oneOfBoolean:["true"]',
  );
});

test('通用 facet 將文字、數字、日期與布林值正規化並聚合筆數', () => {
  assert.deepEqual(collectColumnFacetOptions([
    { status: 'OPEN' },
    { status: 'OPEN', count: 2 },
    { status: 'CLOSED' },
  ], 'status', 'text'), [
    { value: 'CLOSED', label: 'CLOSED', count: 1 },
    { value: 'OPEN', label: 'OPEN', count: 3 },
  ]);
  assert.deepEqual(collectColumnFacetOptions([
    { qty: 1000 },
    { qty: '2' },
  ], 'qty', 'numeric'), [
    { value: '2', label: '2', count: 1 },
    { value: '1000', label: '1,000', count: 1 },
  ]);
  assert.deepEqual(collectColumnFacetOptions([
    { day: new Date('2026-08-24T00:00:00.000Z') },
  ], 'day', 'date'), [
    { value: '2026-08-24', label: '2026-08-24', count: 1 },
  ]);
  assert.deepEqual(collectColumnFacetOptions([
    { active: true },
    { active: false },
  ], 'active', 'boolean'), [
    { value: 'false', label: '否', count: 1 },
    { value: 'true', label: '是', count: 1 },
  ]);
});

test('typed oneOf 在 Prisma 與合併資料列保留數字、日期、布林型別', () => {
  const filters = parseSerializedColumnFilters(new URLSearchParams({
    filter_sortGroup: 'oneOfNumber:["8","9"]',
    filter_deliveryDate: 'oneOfDate:["2026-08-24"]',
    filter_shouldPlanProduction: 'oneOfBoolean:["true"]',
  }));
  assert.deepEqual(applySerializedColumnFiltersToPrismaWhere({}, filters), {
    sortGroup: { in: [8, 9] },
    deliveryDate: { in: [new Date('2026-08-24')] },
    shouldPlanProduction: { in: [true] },
  });
  const matching = {
    sortGroup: 9,
    deliveryDate: '2026-08-24T00:00:00.000Z',
    shouldPlanProduction: true,
  };
  assert.deepEqual(applySerializedColumnFiltersToRows([
    matching,
    { ...matching, sortGroup: 7 },
  ], filters), [matching]);
});

test('集合篩選在 Prisma 與合併資料列使用相同的任一符合語意', () => {
  const params = new URLSearchParams({
    filter_customerCode: 'oneOf:["SY","SM"]',
  });
  const filters = parseSerializedColumnFilters(params);

  assert.deepEqual(applySerializedColumnFiltersToPrismaWhere({}, filters), {
    customerCode: { in: ['SY', 'SM'], mode: 'insensitive' },
  });

  const rows = [
    { id: 1, customerCode: 'SY' },
    { id: 2, customerCode: 'sm' },
    { id: 3, customerCode: '4W' },
  ];
  assert.deepEqual(applySerializedColumnFiltersToRows(rows, filters), [rows[0], rows[1]]);
  assert.equal(applyColumnFilter('SM', {
    columnId: 'customerCode',
    operator: 'oneOf',
    value: ['SY', 'SM'],
    valueType: 'enum',
  }), true);
});

test('客戶多選選項由完整資料集去空白、去重並排序', () => {
  assert.deepEqual(collectCustomerCodeOptions([
    { customerCode: ' SY ' },
    { customerCode: 'SM' },
    { customerCode: 'SY' },
    { customerCode: null },
  ]), ['SM', 'SY']);
});

test('客戶 facet 選項排除空值、聚合數量並支援搜尋與上限', () => {
  assert.deepEqual(collectCustomerCodeFacetOptions([
    { customerCode: 'SY' },
    { customerCode: ' SY ' },
    { customerCode: 'SM', count: 4 },
    { customerCode: null },
  ], 's', 1), [
    { value: 'SM', label: 'SM', count: 4 },
  ]);
});

test('facet 只排除目前欄位條件，保留其他 canonical filters', () => {
  const filters = parseSerializedColumnFilters(new URLSearchParams({
    filter_customerCode: 'oneOf:["SY","SM"]',
    filter_forgingMachine: 'equals:F7',
  }));
  assert.deepEqual(excludeSerializedColumnFilter(filters, 'customerCode'), [{
    columnId: 'forgingMachine',
    operator: 'equals',
    value: 'F7',
  }]);
});

test('無效或空白的集合篩選不會產生查詢條件', () => {
  for (const serialized of ['oneOf:not-json', 'oneOf:[]', 'oneOf:["", "  "]']) {
    const params = new URLSearchParams({ filter_customerCode: serialized });
    assert.deepEqual(
      applySerializedColumnFiltersToPrismaWhere({}, parseSerializedColumnFilters(params)),
      {},
    );
  }
});

test('數值等於條件產生 Prisma number，不附加文字 mode', () => {
  const params = new URLSearchParams({ filter_sortGroup: 'equalsNumber:9' });
  const filters = parseSerializedColumnFilters(params);
  const where = applySerializedColumnFiltersToPrismaWhere({}, filters);

  assert.deepEqual(where, { sortGroup: { equals: 9 } });
});

test('文字等於條件保留不分大小寫比較', () => {
  const params = new URLSearchParams({ filter_customerCode: 'equals:hk' });
  const filters = parseSerializedColumnFilters(params);
  const where = applySerializedColumnFiltersToPrismaWhere({}, filters);

  assert.deepEqual(where, {
    customerCode: { equals: 'hk', mode: 'insensitive' },
  });
});

test('日期比較轉成 Date 交給 Prisma', () => {
  const params = new URLSearchParams({ filter_deliveryDate: 'gteDate:2026-07-23' });
  const filters = parseSerializedColumnFilters(params);
  const where = applySerializedColumnFiltersToPrismaWhere({}, filters);

  assert.deepEqual(where, {
    deliveryDate: { gte: new Date('2026-07-23') },
  });
});

test('布林等於條件產生 Prisma boolean', () => {
  const params = new URLSearchParams({
    filter_shouldPlanProduction: 'equalsBoolean:true',
  });
  const where = applySerializedColumnFiltersToPrismaWhere(
    {},
    parseSerializedColumnFilters(params),
  );

  assert.deepEqual(where, {
    shouldPlanProduction: { equals: true },
  });
});

test('合併資料列套用文字、數值與日期條件', () => {
  const params = new URLSearchParams({
    filter_customerCode: 'equals:hk',
    filter_sortGroup: 'equalsNumber:9',
    filter_deliveryDate: 'gteDate:2026-07-23',
  });
  const rows = [
    { id: 1, customerCode: 'HK', sortGroup: 9, deliveryDate: '2026-07-23' },
    { id: 2, customerCode: 'HK', sortGroup: 8, deliveryDate: '2026-07-23' },
    { id: 3, customerCode: 'SM', sortGroup: 9, deliveryDate: '2026-07-23' },
    { id: 4, customerCode: 'HK', sortGroup: 9, deliveryDate: '2026-07-22' },
  ];

  assert.deepEqual(
    applySerializedColumnFiltersToRows(rows, parseSerializedColumnFilters(params)),
    [rows[0]],
  );
});

test('純前端頁面的日期與布林右鍵條件保留原始型別', () => {
  assert.equal(
    applyColumnFilter('2026-07-24', {
      columnId: 'completionDate',
      operator: 'gte',
      value: '2026-07-23',
      valueType: 'date',
    }),
    true,
  );
  assert.equal(
    applyColumnFilter(false, {
      columnId: 'shouldPlanProduction',
      operator: 'equals',
      value: 'false',
      valueType: 'boolean',
    }),
    true,
  );
});

test('伺服器忽略不在 model 契約中的篩選欄位', () => {
  const params = new URLSearchParams({
    filter_customerCode: 'equals:HK',
    filter_removedColumn: 'equals:stale',
  });
  const filters = parseSerializedColumnFilters(
    params,
    new Set(['customerCode']),
  );

  assert.deepEqual(filters, [{
    columnId: 'customerCode',
    operator: 'equals',
    value: 'HK',
  }]);
});

test('伺服器只保留 model 契約內且方向有效的排序欄位', () => {
  assert.deepEqual(
    parseSerializedSortFields(
      'removedColumn:desc,sortGroup:desc,erpPartNo:sideways',
      new Set(['sortGroup', 'erpPartNo']),
    ),
    [{ key: 'sortGroup', dir: 'desc' }],
  );
});

test('瀏覽器舊篩選設定會移除已不存在的欄位', () => {
  assert.deepEqual(
    sanitizeColumnFilters([
      { columnId: 'removedColumn', operator: 'equals', value: 'stale' },
      { columnId: 'customerCode', operator: 'equals', value: 'HK' },
    ], new Set(['customerCode'])),
    [{ columnId: 'customerCode', operator: 'equals', value: 'HK' }],
  );
});

test('瀏覽器保存集合篩選時去重、去空白並保留舊單值條件', () => {
  assert.deepEqual(
    sanitizeColumnFilters([
      { columnId: 'customerCode', operator: 'oneOf', value: ['SY', ' SM ', 'SY', ''] },
      { columnId: 'status', operator: 'equals', value: 'completed' },
    ], new Set(['customerCode', 'status'])),
    [
      { columnId: 'customerCode', operator: 'oneOf', value: ['SY', 'SM'] },
      { columnId: 'status', operator: 'equals', value: 'completed' },
    ],
  );
});
