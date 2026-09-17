import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET } from '../app/api/fg-monthly/warehouse-stock/recheck/route';

const lotDelegate = prisma.stagingInventoryLot as unknown as {
  findUnique: (args: unknown) => Promise<unknown>;
};
const originalFindUnique = lotDelegate.findUnique;
const originalFetch = globalThis.fetch;

afterEach(() => {
  lotDelegate.findUnique = originalFindUnique;
  globalThis.fetch = originalFetch;
});

test('庫存批號重查只讀 GET Ragic，修正後要求重跑 MRP 而不覆寫 Run', async () => {
  lotDelegate.findUnique = async () => ({
    ragicRecordId: '43838',
    stockPc: 15501,
    stockKg: 171.64427,
    unitWeightG: 11.69,
    expectedStockPc: 14683,
    stockPcDiff: 818,
    quantityAnomaly: true,
  });

  let requestMethod = '';
  globalThis.fetch = async (_input, init) => {
    requestMethod = init?.method ?? 'GET';
    return Response.json({
      43838: {
        1005510: 14683,
        1005511: 171.64427,
        1005465: 11.69,
      },
    });
  };

  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock/recheck?runId=18&recordId=43838',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'GET');
  assert.equal(body.snapshot.quantityAnomaly, true);
  assert.equal(body.live.quantityAnomaly, false);
  assert.equal(body.ragicCorrected, true);
  assert.equal(body.mrpRunNeedsRefresh, true);
  assert.equal(body.live.stockPc, 14683);
});
