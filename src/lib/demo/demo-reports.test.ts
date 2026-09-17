import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET as fg } from '@/app/api/fg-monthly/route';
import { GET as cw } from '@/app/api/component-weekly/route';
import { GET as source } from '@/app/api/source-data/route';
import { GET as sales } from '@/app/api/sales-meeting/route';
import { dataset, demoPreferences } from './data';
import { prepareDemo } from './run-control';
test.before(async () => prepareDemo());

async function query(handler: typeof fg, params: Record<string, string>) {
  const response = await handler(new NextRequest(`http://127.0.0.1:3142/api/report?${new URLSearchParams({ runId: '3', ...params })}`));
  assert.equal(response.headers.get('X-MRP-Data'), 'synthetic');
  return { response, body: await response.json() };
}

test('篩選先於分頁，數值多選與排序使用原序列化契約', async () => {
  const expected = dataset(3).fg.filter((row) => !row.isAggregated && row.customerCode === 'XA' && ['M1', 'M2'].includes(String(row.forgingMachine)))
    .sort((a, b) => Number(b.currentStockPc) - Number(a.currentStockPc));
  const { body } = await query(fg, { filter_customerCode: 'equals:XA', filter_forgingMachine: 'oneOf:["M1","M2"]', sortFields: 'currentStockPc:desc', limit: '3', page: '2' });
  assert.equal(body.total, expected.length);
  assert.deepEqual(body.items.map((row: { partVersion: string }) => row.partVersion), expected.slice(3, 6).map((row) => row.partVersion));
  const numeric = await query(fg, { filter_currentStockPc: 'oneOfNumber:["60000"]', limit: '100' });
  assert.equal(numeric.body.total, 12);
  assert.ok(numeric.body.items.every((row: { currentStockPc: number }) => row.currentStockPc === 60000));
});

test('facet 排除自身篩選，保留其他條件及 facetQuery', async () => {
  const { body } = await query(fg, { facet: 'customerCode', facetType: 'enum', filter_customerCode: 'equals:XA', machineFilter: 'M1' });
  const counts = new Map<string, number>();
  for (const row of dataset(3).fg.filter((row) => !row.isAggregated && row.forgingMachine === 'M1')) {
    const customer = String(row.customerCode);
    counts.set(customer, (counts.get(customer) ?? 0) + 1);
  }
  assert.deepEqual(body.options, [...counts].sort().map(([value, count]) => ({ value, label: value, count })));
  const narrowed = await query(fg, { facet: 'customerCode', facetType: 'enum', facetQuery: 'xb', machineFilter: 'M1' });
  assert.equal(narrowed.body.options.length, 1);
  assert.equal(narrowed.body.options[0].value, 'XB');
  assert.equal((await query(fg, { facet: 'notAColumn', facetType: 'enum' })).response.status, 400);
});

test('成品合計不受頁碼影響，ERP 庫存與餘額只算一次，需求逐客料加總', async () => {
  const { body } = await query(fg, { totals: 'true', page: '3', limit: '2' });
  const data = dataset(3);
  const pools = new Map<string, number>();
  for (const row of data.fg.filter((row) => !row.isAggregated)) pools.set(String(row.erpPartNo), Number(row.currentStockPc));
  assert.equal(body.total, data.fg.filter((row) => !row.isAggregated).length);
  assert.deepEqual(body.items, []);
  assert.equal(body.totals.preperiod.currentStockPc, [...pools.values()].reduce((sum, stock) => sum + stock, 0));
  for (const period of body.totals.periods) {
    const balances = new Map<string, number>();
    let demand = 0;
    for (const row of data.fg.filter((row) => !row.isAggregated)) {
      const item = data.fgPeriods[String(row.partVersion)].find((item) => item.periodIndex === period.periodIndex)!;
      demand += Number(item.demandIntegrated);
      const key = String(row.erpPartNo);
      balances.set(key, Math.min(balances.get(key) ?? Infinity, Number(item.remainingStock)));
    }
    assert.equal(period.demandIntegrated, demand);
    assert.equal(period.remainingStock, [...balances.values()].reduce((sum, stock) => sum + stock, 0));
  }
  const otherPage = await query(fg, { totals: 'true', page: '1', limit: '200' });
  assert.deepEqual(body.totals, otherPage.body.totals);
  const selected = await query(fg, { totals: 'true', partVersionsIn: 'XA-PRODUCT-001-R1,XB-PRODUCT-001-R1' });
  assert.equal(selected.body.total, 2);
  assert.equal(selected.body.totals.preperiod.currentStockPc, 2090);
});

test('機台分類、欠料、忽略客戶與暫時顯示忽略沿用原 UI 參數', async () => {
  const saved = demoPreferences.demoIgnored;
  try {
    demoPreferences.demoIgnored = ['XA'];
    const { body } = await query(fg, { shortageOnly: 'true', machineFilter: 'M1', limit: '100' });
    assert.deepEqual(body.items.map((row: { partVersion: string }) => row.partVersion), dataset(3).fg.filter((row) => !row.isAggregated && row.customerCode !== 'XA' && row.shouldPlanProduction && row.forgingMachine === 'M1').map((row) => row.partVersion));
    assert.equal((await query(fg, { includeIgnored: 'true' })).body.total, 48);
    assert.equal((await query(fg, { machineFilter: 'supplier' })).body.total, 0);
  } finally { demoPreferences.demoIgnored = saved; }
});

test('元件與來源共用欄位篩選，Run 與 type 身份不混用', async () => {
  const component = await query(cw, { mrpType: 'B', filter_goodStockPc: 'gte:2000', sortFields: 'goodStockPc:desc', limit: '2' });
  assert.equal(component.body.total, 5);
  assert.deepEqual(component.body.items.map((row: { materialPartNo: string }) => row.materialPartNo), ['DEMO-B-012', 'DEMO-B-011']);
  const orders = await query(source, { table: 'orders', filter_partVersion: 'equals:XA-PRODUCT-001-R1', filter_orderQty: 'gte:870', limit: '5', page: '2' });
  assert.equal(orders.body.total, 12);
  assert.equal(orders.body.items.length, 5);
  assert.ok(orders.body.items.every((row: { partVersion: string; mrpRunId: number }) => row.partVersion === 'XA-PRODUCT-001-R1' && row.mrpRunId === 3));
  assert.equal((await query(source, { table: 'not-a-table' })).response.status, 400);
  assert.equal((await query(fg, { limit: '0' })).response.status, 400);
  assert.equal((await query(fg, { merge: 'true', dbSource: 'local' })).response.status, 400);
});

test('三張既有報表匯出用 limit=100000，回傳完整篩選集而不是空資料', async () => {
  for (const [handler, params, expected] of [
    [fg, { filter_customerCode: 'equals:XA' }, 24],
    [cw, { mrpType: 'W' }, 12],
    [sales, { filter_customerCode: 'equals:XB' }, 24],
  ] as const) {
    const { response, body } = await query(handler, { ...params, page: '1', limit: '100000' });
    assert.equal(response.status, 200);
    assert.equal(body.total, expected);
    assert.equal(body.items.length, expected);
  }
});

test('空資料集仍接受合法 schema facet，非法欄位維持拒絕', async () => {
  const emptySource = await query(source, { table: 'work_order_material_movements', facet: 'workOrderNo', facetType: 'text', facetQuery: 'demo' });
  assert.equal(emptySource.response.status, 200);
  assert.deepEqual(emptySource.body.options, []);
  assert.equal((await query(source, { table: 'work_order_material_movements', facet: 'unknownColumn', facetType: 'text' })).response.status, 400);
  const saved = demoPreferences.demoIgnored;
  try {
    demoPreferences.demoIgnored = ['XA', 'XB'];
    const emptyFg = await query(fg, { facet: 'customerCode', facetType: 'enum' });
    assert.equal(emptyFg.response.status, 200);
    assert.deepEqual(emptyFg.body.options, []);
    const totals = await query(fg, { totals: 'true' });
    assert.equal(totals.body.total, 0);
    assert.equal(totals.body.totals.preperiod.currentStockPc, 0);
    assert.deepEqual(totals.body.totals.periods, []);
  } finally { demoPreferences.demoIgnored = saved; }
});

test('原產銷 consumer 取得客戶料號、成員版本與期間，不只 schema 摘要', async () => {
  const { response, body } = await query(sales, { includePeriods: '1' });
  assert.equal(response.status, 200); assert.equal(body.items.length, 48);
  for (const item of body.items) {
    const part = dataset(3).source.part_versions.find((row) => row.partVersion === item.partVersion)!;
    assert.equal(item.customerPartNo, part.customerPartNo, 'SALES_DISPLAY_CONTRACT');
    assert.deepEqual(item.memberPartVersions, [item.partVersion], 'SALES_DISPLAY_CONTRACT');
    assert.equal(body.periods[item.partVersion].length, 13);
  }
});
