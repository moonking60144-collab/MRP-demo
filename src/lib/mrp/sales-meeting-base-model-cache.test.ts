import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';

import prisma from '../db';
import { GET } from '../../app/api/sales-meeting/route';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const salesDelegate = prisma.salesMeeting as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const partDelegate = prisma.stagingPartVersion as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const lotDelegate = prisma.stagingInventoryLot as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const originals = {
  run: runDelegate.findUnique,
  sales: salesDelegate.findMany,
  parts: partDelegate.findMany,
  lots: lotDelegate.findMany,
};

afterEach(() => {
  runDelegate.findUnique = originals.run;
  salesDelegate.findMany = originals.sales;
  partDelegate.findMany = originals.parts;
  lotDelegate.findMany = originals.lots;
});

function summary(id: number, partVersion: string, erpPartNo: string) {
  return {
    id,
    mrpRunId: 9911,
    customerCode: 'SA',
    partVersion,
    erpPartNo,
    unit: 'pc',
    goodStockPc: 100,
    goodStockKg: 1,
    mainStockPc: 0,
    auxStockPc: 0,
    badStockPc: 0,
    badStockKg: 0,
    avgDemandPerWeek: 10,
    stockWeeks: 10,
    shortageStartWeek: null,
    purchaseLeadWeeks: 8,
    outstanding04: 0,
    fgDiff04: 100,
    fgStatus04: '無訂單',
    totalOrderDemand: 0,
    totalFgDiff: 100,
  };
}

test('同一完成 Run 翻頁重用分組基礎模型，分頁與搜尋仍按請求計算', async () => {
  runDelegate.findUnique = async () => ({
    id: 9911,
    status: 'completed',
    versionCode: 'MRP-9911',
    runDate: new Date('2026-09-11T00:00:00.000Z'),
    syncCounts: {},
  });
  let summaryReads = 0;
  salesDelegate.findMany = async () => {
    summaryReads += 1;
    return [
      summary(1, 'PV-A', 'ERP-A'),
      summary(2, 'PV-B', 'ERP-B'),
    ];
  };
  let partReads = 0;
  partDelegate.findMany = async () => {
    partReads += 1;
    return [
      { partVersion: 'PV-A', customerPartNo: 'CP-A' },
      { partVersion: 'PV-B', customerPartNo: 'CP-B' },
    ];
  };
  lotDelegate.findMany = async () => [];

  const first = await GET(new NextRequest(
    'http://localhost/api/sales-meeting?runId=9911&page=1&limit=1',
  ));
  const second = await GET(new NextRequest(
    'http://localhost/api/sales-meeting?runId=9911&page=2&limit=1',
  ));
  const searched = await GET(new NextRequest(
    'http://localhost/api/sales-meeting?runId=9911&page=1&limit=1&search=CP-B',
  ));
  const firstBody = await first.json();
  const secondBody = await second.json();
  const searchedBody = await searched.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(searched.status, 200);
  assert.equal(summaryReads, 1);
  assert.equal(partReads, 1);
  assert.equal(firstBody.total, 2);
  assert.equal(firstBody.items[0].partVersion, 'PV-A');
  assert.equal(secondBody.items[0].partVersion, 'PV-B');
  assert.equal(searchedBody.total, 1);
  assert.equal(searchedBody.items[0].partVersion, 'PV-B');
});
