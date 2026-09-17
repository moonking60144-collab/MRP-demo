import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildColumnFilterOptionsUrl,
  loadColumnFilterOptions,
} from './column-filter-options-client';

test('FG customerCode facet URL 排除自身 filter 並保留其他 query scope', () => {
  const url = new URL(buildColumnFilterOptionsUrl({
    tableId: 'fg_monthly_detailed',
    columnId: 'customerCode',
    valueType: 'enum',
    runId: 58,
    globalSearch: 'V01',
    columnFilters: [
      { columnId: 'customerCode', operator: 'oneOf', value: ['SY'], valueType: 'enum' },
      { columnId: 'stockWeeks', operator: 'gte', value: 2, valueType: 'numeric' },
    ],
    fixedScope: { shortageOnly: true, excludeTest: false, machineFilter: 'internal' },
    query: 'S',
    limit: 80,
  }), 'http://localhost');

  assert.equal(url.pathname, '/api/fg-monthly');
  assert.equal(url.searchParams.get('runId'), '58');
  assert.equal(url.searchParams.get('search'), 'V01');
  assert.equal(url.searchParams.get('shortageOnly'), 'true');
  assert.equal(url.searchParams.get('machineFilter'), 'internal');
  assert.equal(url.searchParams.get('filter_customerCode'), null);
  assert.equal(url.searchParams.get('filter_stockWeeks'), 'gte:2');
  assert.equal(url.searchParams.get('facetQuery'), 'S');
  assert.equal(url.searchParams.get('facetLimit'), '80');
});

test('Sales merge facet 使用 merge identity，不附單一 Run', () => {
  const url = new URL(buildColumnFilterOptionsUrl({
    tableId: 'sales_meeting_traditional',
    columnId: 'customerCode',
    valueType: 'enum',
    runId: 58,
    mergeDb: true,
    columnFilters: [],
  }), 'http://localhost');
  assert.equal(url.pathname, '/api/sales-meeting');
  assert.equal(url.searchParams.get('merge'), 'true');
  assert.equal(url.searchParams.get('runId'), null);
});

test('server facet client 支援所有列表 endpoint 與任意已宣告欄位', () => {
  assert.throws(() => buildColumnFilterOptionsUrl({
    tableId: 'unknown_table',
    columnId: 'customerCode',
    valueType: 'enum',
    runId: 58,
    columnFilters: [],
  }), /不支援的 server facet tableId/);

  const fg = new URL(buildColumnFilterOptionsUrl({
    tableId: 'fg_monthly_detailed',
    columnId: 'erpPartNo',
    valueType: 'text',
    runId: 58,
    columnFilters: [],
  }), 'http://localhost');
  assert.equal(fg.searchParams.get('facet'), 'erpPartNo');
  assert.equal(fg.searchParams.get('facetType'), 'text');

  const component = new URL(buildColumnFilterOptionsUrl({
    tableId: 'component_weekly_B',
    columnId: 'unit',
    valueType: 'text',
    runId: 58,
    columnFilters: [],
  }), 'http://localhost');
  assert.equal(component.pathname, '/api/component-weekly');
  assert.equal(component.searchParams.get('mrpType'), 'B');

  const source = new URL(buildColumnFilterOptionsUrl({
    tableId: 'source_inventory_lots',
    columnId: 'warehouseCode',
    valueType: 'text',
    runId: 58,
    columnFilters: [],
  }), 'http://localhost');
  assert.equal(source.pathname, '/api/source-data');
  assert.equal(source.searchParams.get('table'), 'inventory_lots');
});

test('server facet client 將 AbortSignal 傳到 fetch', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response(JSON.stringify({
      facet: 'customerCode',
      options: [{ value: 'SY', label: 'SY', count: 2 }],
      runId: 59,
      dbSource: null,
      merge: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const options = await loadColumnFilterOptions({
      tableId: 'fg_monthly_detailed',
      columnId: 'customerCode',
      valueType: 'enum',
      runId: 59,
      columnFilters: [],
      query: 'signal-check',
    }, controller.signal);
    assert.equal(receivedSignal, controller.signal);
    assert.deepEqual(options, [{ value: 'SY', label: 'SY', count: 2 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
