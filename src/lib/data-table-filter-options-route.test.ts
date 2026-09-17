import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';

import prisma from './db';
import { GET as componentWeeklyGET } from '../app/api/component-weekly/route';
import { GET as sourceDataGET } from '../app/api/source-data/route';

type GroupByDelegate = {
  groupBy: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const componentDelegate = prisma.componentWeekly as unknown as GroupByDelegate;
const inventoryLotDelegate = prisma.stagingInventoryLot as unknown as GroupByDelegate;

const originals = {
  run: runDelegate.findUnique,
  componentGroupBy: componentDelegate.groupBy,
  inventoryLotGroupBy: inventoryLotDelegate.groupBy,
};

afterEach(() => {
  runDelegate.findUnique = originals.run;
  componentDelegate.groupBy = originals.componentGroupBy;
  inventoryLotDelegate.groupBy = originals.inventoryLotGroupBy;
});

test('元件週推所有可篩選欄位都能取得排除自身條件的 server facet', async () => {
  runDelegate.findUnique = async () => ({
    id: 58,
    versionCode: 'MRP-58',
    status: 'completed',
    runDate: new Date('2026-08-24T00:00:00.000Z'),
  });
  const queries: unknown[] = [];
  componentDelegate.groupBy = async (args) => {
    queries.push(args);
    return [
      { unit: 'kg', _count: { _all: 8 } },
      { unit: 'pc', _count: { _all: 3 } },
    ];
  };

  const response = await componentWeeklyGET(new NextRequest(
    'http://localhost/api/component-weekly?mrpType=B&runId=58'
    + '&facet=unit&facetType=text&facetQuery=k'
    + '&filter_unit=oneOf:["pc"]&filter_stockWeeks=gte:2',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.options, [{ value: 'kg', label: 'kg', count: 8 }]);
  assert.equal(queries.length, 1);
  assert.deepEqual((queries[0] as { by: unknown }).by, ['unit']);
  assert.deepEqual((queries[0] as { where: unknown }).where, {
    mrpRunId: 58,
    mrpType: 'B',
    materialPartNo: { notIn: ['*', '.'] },
    stockWeeks: { gte: 2 },
  });
});

test('原始資料各分頁表共用 typed server facet，且保留其他欄位條件', async () => {
  const queries: unknown[] = [];
  inventoryLotDelegate.groupBy = async (args) => {
    queries.push(args);
    return [
      { warehouseCode: 'HD1', _count: { _all: 12 } },
      { warehouseCode: 'AUX', _count: { _all: 4 } },
    ];
  };

  const response = await sourceDataGET(new NextRequest(
    'http://localhost/api/source-data?table=inventory_lots&runId=58'
    + '&facet=warehouseCode&facetType=text&facetQuery=H'
    + '&filter_warehouseCode=oneOf:["AUX"]'
    + '&filter_quantityAnomaly=oneOfBoolean:["true"]',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.options, [{ value: 'HD1', label: 'HD1', count: 12 }]);
  assert.equal(queries.length, 1);
  assert.deepEqual((queries[0] as { by: unknown }).by, ['warehouseCode']);
  assert.deepEqual((queries[0] as { where: unknown }).where, {
    mrpRunId: 58,
    quantityAnomaly: { in: [true] },
  });
});
