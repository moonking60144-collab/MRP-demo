import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIELD_MAP_PRODUCTION_PLANS,
  INVENTORY_LOT_FIELD_IDS,
  OPEN_PRODUCTION_PLAN_WHERE,
  RAGIC_WORK_ORDER_MOVEMENT_PATH,
  RAGIC_SYNC_PAGE_SIZE,
  RAGIC_SYNC_PROJECTED_FIELDS,
  SOURCE_FIELD_MAP_FORECASTS,
  SOURCE_FIELD_MAP_INVENTORY,
  SOURCE_FIELD_MAP_INVENTORY_LOTS,
  SOURCE_FIELD_MAP_ORDERS,
  SOURCE_FIELD_MAP_PART_VERSIONS,
  SOURCE_FIELD_MAP_PRODUCTION_PLANS,
  SOURCE_FIELD_MAP_PURCHASE_ORDERS,
  SOURCE_FIELD_MAP_WORK_ORDER_BOM,
  SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS,
  SOURCE_FIELD_MAP_WORK_ORDERS,
  WORK_ORDER_MOVEMENT_FIELD_IDS,
  getSyncProjectedFields,
  getSyncFilters,
} from './field-maps';

test('MRP 同步每頁讀取 2000 筆以減少 Ragic 往返次數', () => {
  assert.equal(RAGIC_SYNC_PAGE_SIZE, 2000);
});

test('線材所有狀態只抓一次，並保留使用中成品與 BOM 引用的停用線材', () => {
  const filters = getSyncFilters('2026/07/01').inventory;

  assert.equal(filters.length, 4);
  assert.deepEqual(filters[0]?.where, [
    { fieldId: '1005645', operator: 'eq', value: 'PROD-FG' },
    { fieldId: '1019191', operator: 'eq', value: '使用中' },
  ]);
  assert.deepEqual(filters[3]?.where, [
    { fieldId: '1005645', operator: 'eq', value: 'MTRL-WR' },
    { fieldId: '1005645', operator: 'eq', value: 'MTRL-WD' },
  ]);
});

test('未結案工令 BOM 使用完整回應，讓子表逐列領料狀態成為權威來源', () => {
  const filters = getSyncFilters('2026/07/01').work_order_bom;

  assert.deepEqual(filters, [{
    where: [{ fieldId: '1031626', operator: 'eq', value: '未結案' }],
    listing: false,
  }]);
});

test('生產計畫同步保留業務識別編號', () => {
  assert.equal(FIELD_MAP_PRODUCTION_PLANS['1036054'], 'plan_no');
  assert.equal(SOURCE_FIELD_MAP_PRODUCTION_PLANS['1006542'], 'plan_no');
});

test('同步與 plan_qty 驗算共用同一組未結案生產計畫篩選條件', () => {
  assert.deepEqual(
    getSyncFilters('2026/07/01').production_plans[0].where,
    OPEN_PRODUCTION_PLAN_WHERE,
  );
});

test('同步只投影寫入 staging 所需欄位', () => {
  assert.deepEqual(
    RAGIC_SYNC_PROJECTED_FIELDS.part_versions,
    Object.keys(SOURCE_FIELD_MAP_PART_VERSIONS),
  );
  assert.deepEqual(
    RAGIC_SYNC_PROJECTED_FIELDS.inventory,
    Object.entries(SOURCE_FIELD_MAP_INVENTORY)
      .filter(([, column]) => !column.startsWith('_'))
      .map(([fieldId]) => fieldId),
  );
  assert.equal(RAGIC_SYNC_PROJECTED_FIELDS.inventory?.includes('1026877'), true);
  assert.equal(RAGIC_SYNC_PROJECTED_FIELDS.inventory?.includes('1037338'), true);
  assert.equal(RAGIC_SYNC_PROJECTED_FIELDS.inventory?.includes('1019191'), true);

  for (const [step, fieldMap] of [
    ['inventory_lots', SOURCE_FIELD_MAP_INVENTORY_LOTS],
    ['orders', SOURCE_FIELD_MAP_ORDERS],
    ['forecasts', SOURCE_FIELD_MAP_FORECASTS],
    ['work_orders', SOURCE_FIELD_MAP_WORK_ORDERS],
    ['work_order_bom', SOURCE_FIELD_MAP_WORK_ORDER_BOM],
    ['production_plans', SOURCE_FIELD_MAP_PRODUCTION_PLANS],
    ['purchase_orders', SOURCE_FIELD_MAP_PURCHASE_ORDERS],
  ] as const) {
    assert.deepEqual(RAGIC_SYNC_PROJECTED_FIELDS[step], Object.keys(fieldMap));
  }
});

test('訂單同步保留 direct 備貨、出庫、銷貨與訂單類型事實欄位', () => {
  assert.equal(SOURCE_FIELD_MAP_ORDERS['1006752'], 'prepared_qty');
  assert.equal(SOURCE_FIELD_MAP_ORDERS['1006636'], 'shipped_qty');
  assert.equal(SOURCE_FIELD_MAP_ORDERS['1006782'], 'sold_qty');
  assert.equal(SOURCE_FIELD_MAP_ORDERS['1031827'], 'order_type');
});

test('工令 BOM full response 保留領料子表，listing 才套用欄位投影', () => {
  assert.deepEqual(
    getSyncProjectedFields('work_order_bom', true),
    Object.keys(SOURCE_FIELD_MAP_WORK_ORDER_BOM),
  );
  assert.equal(getSyncProjectedFields('work_order_bom', false), undefined);
  assert.deepEqual(
    getSyncProjectedFields('inventory', false),
    RAGIC_SYNC_PROJECTED_FIELDS.inventory,
  );
});

test('庫存批號同步全部在庫品質，並使用真正的來源工令欄位', () => {
  const filters = getSyncFilters('2026/07/01').inventory_lots;
  assert.deepEqual(filters.map((filter) => ({
    stockStatus: filter.where.find((clause) => clause.fieldId === '1005500')?.value,
    qualityStatus: filter.where.find((clause) => clause.fieldId === '1005482')?.value,
    listing: filter.listing,
  })), [
    { stockStatus: '在庫', qualityStatus: undefined, listing: true },
  ]);
  assert.equal(SOURCE_FIELD_MAP_INVENTORY_LOTS[INVENTORY_LOT_FIELD_IDS.sourceWorkOrderNo], 'source_work_order_no');
  assert.equal(SOURCE_FIELD_MAP_INVENTORY_LOTS[INVENTORY_LOT_FIELD_IDS.stockPc], 'stock_pc');
  assert.equal(SOURCE_FIELD_MAP_INVENTORY_LOTS[INVENTORY_LOT_FIELD_IDS.stockKg], 'stock_kg');
  assert.equal(SOURCE_FIELD_MAP_INVENTORY_LOTS[INVENTORY_LOT_FIELD_IDS.unitWeightG], 'unit_weight_g');
  assert.equal(SOURCE_FIELD_MAP_INVENTORY_LOTS['1016299'], undefined);
});

test('工令耗用與退料快照集中使用 Form 20 欄位契約', () => {
  assert.equal(RAGIC_WORK_ORDER_MOVEMENT_PATH, '/default/forms4/20');
  assert.equal(
    SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS[WORK_ORDER_MOVEMENT_FIELD_IDS.workOrderNo],
    'work_order_no',
  );
  assert.equal(
    SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS[WORK_ORDER_MOVEMENT_FIELD_IDS.componentNo],
    'component_no',
  );
  assert.equal(
    SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS[WORK_ORDER_MOVEMENT_FIELD_IDS.basisType],
    'basis_type',
  );
  assert.equal(
    SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS[WORK_ORDER_MOVEMENT_FIELD_IDS.movementQtyKg],
    'movement_qty_kg',
  );
});
