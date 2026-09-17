import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET } from '../app/api/fg-monthly/warehouse-stock/route';

const fgDelegate = prisma.fgMonthly as unknown as {
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const partVersionDelegate = prisma.stagingPartVersion as unknown as {
  findFirst: (args: unknown) => Promise<{ erpPartNo: string | null } | null>;
  findMany: (args: unknown) => Promise<Array<{ erpPartNo: string | null }>>;
};
const lotDelegate = prisma.stagingInventoryLot as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const workOrderDelegate = prisma.stagingWorkOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<{ woNumber: string | null; ragicRecordId: string | null }>>;
};
const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<{ syncCounts: unknown } | null>;
};

const originalFindSummary = fgDelegate.findFirst;
const originalFindPartVersions = partVersionDelegate.findMany;
const originalFindPartVersion = partVersionDelegate.findFirst;
const originalFindLots = lotDelegate.findMany;
const originalFindWorkOrders = workOrderDelegate.findMany;
const originalFindRun = runDelegate.findUnique;

afterEach(() => {
  fgDelegate.findFirst = originalFindSummary;
  partVersionDelegate.findMany = originalFindPartVersions;
  partVersionDelegate.findFirst = originalFindPartVersion;
  lotDelegate.findMany = originalFindLots;
  workOrderDelegate.findMany = originalFindWorkOrders;
  runDelegate.findUnique = originalFindRun;
});

test('廠內明細讀取指定 Run、ERP 的非 YE1 與空白倉庫批號', async () => {
  runDelegate.findUnique = async () => ({ syncCounts: { inventory_lot_validation_v1: 1 } });
  let lotQuery: unknown;
  let workOrderQuery: unknown;
  fgDelegate.findFirst = async () => ({ erpPartNo: 'ERP-01', aggregatedMembers: [] });
  lotDelegate.findMany = async (args) => {
    lotQuery = args;
    return [
      {
        ragicRecordId: '101', lotNo: 'LOT-A', erpPartNo: 'ERP-01', warehouseCode: 'WFG',
        stockStatus: '在庫', qualityStatus: '正常', stockPc: 120, stockKg: 1.2,
        unitWeightG: 9, expectedStockPc: 133, stockPcDiff: -13,
        stockPcDiffPct: -0.1083, quantityAnomaly: true,
        sourceWorkOrderNo: null, sourceWorkOrderType: null,
      },
      {
        ragicRecordId: '102', lotNo: 'LOT-B', erpPartNo: 'ERP-01', warehouseCode: 'WFG',
        stockStatus: '在庫', qualityStatus: '待驗', stockPc: 30, stockKg: 0.3,
        sourceWorkOrderNo: 'WO-1', sourceWorkOrderType: '內製',
      },
      {
        ragicRecordId: '103', lotNo: 'LOT-C', erpPartNo: 'ERP-01', warehouseCode: 'WFG',
        stockStatus: '在庫', qualityStatus: '不良', stockPc: 20, stockKg: 0.2,
        sourceWorkOrderNo: 'WO-2', sourceWorkOrderType: '委外',
      },
      {
        ragicRecordId: '104', lotNo: 'LOT-Y', erpPartNo: 'ERP-01', warehouseCode: ' ye1 ',
        stockStatus: '在庫', qualityStatus: '正常', stockPc: 999, stockKg: 9.99,
        sourceWorkOrderNo: null, sourceWorkOrderType: null,
      },
    ];
  };
  workOrderDelegate.findMany = async (args) => {
    workOrderQuery = args;
    return [{ woNumber: 'WO-1', ragicRecordId: '501' }];
  };

  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock?runId=7&partVersion=PV-01&warehouse=INTERNAL&aggregated=false',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.totalPc, 170);
  assert.equal(body.totalKg, 1.7);
  assert.equal(body.availablePc, 150);
  assert.equal(body.excludedPc, 20);
  assert.equal(body.inventoryValidationAvailable, true);
  assert.equal(body.inventoryAnomalyCount, 1);
  assert.equal(body.lots[0].quantityAnomaly, true);
  assert.equal(body.lots[0].expectedStockPc, 133);
  assert.equal(body.lots[0].includedInMrp, true);
  assert.equal(body.lots[1].sourceWorkOrderRagicUrl.endsWith('/default/forms8/92/501'), true);
  assert.equal(body.lots[2].includedInMrp, false);
  const fallbackWorkOrderUrl = new URL(body.lots[2].sourceWorkOrderRagicUrl);
  assert.equal(fallbackWorkOrderUrl.pathname, '/default/forms8/92');
  assert.deepEqual(JSON.parse(fallbackWorkOrderUrl.searchParams.get('status') ?? '{}'), {
    filter: ['1005984|1|WO-2'],
  });
  assert.equal(body.lots[0].ragicUrl.endsWith('/default/forms4/16/101'), true);
  assert.deepEqual(body.qualitySummaries, [
    { qualityStatus: '正常', lotCount: 1, stockPc: 120, stockKg: 1.2, includedInMrp: true },
    { qualityStatus: '待驗', lotCount: 1, stockPc: 30, stockKg: 0.3, includedInMrp: true },
    { qualityStatus: '不良', lotCount: 1, stockPc: 20, stockKg: 0.2, includedInMrp: false },
  ]);
  assert.deepEqual(lotQuery, {
    where: {
      mrpRunId: 7,
      erpPartNo: { in: ['ERP-01'] },
    },
    orderBy: [{ erpPartNo: 'asc' }, { stockPc: 'desc' }, { lotNo: 'asc' }],
  });
  assert.deepEqual(workOrderQuery, {
    where: { mrpRunId: 7, woNumber: { in: ['WO-1', 'WO-2'] } },
    select: { woNumber: true, ragicRecordId: true },
  });
});

test('聚合列以成員的唯一 ERP 清單讀取同一 Run 的 YE1 快照', async () => {
  runDelegate.findUnique = async () => ({ syncCounts: { inventory_lot_validation_v1: 1 } });
  let lotQuery: unknown;
  fgDelegate.findFirst = async () => ({
    erpPartNo: 'ERP-GROUP',
    aggregatedMembers: ['PV-A', 'PV-B', 'PV-C'],
  });
  partVersionDelegate.findMany = async () => [
    { erpPartNo: 'ERP-A' },
    { erpPartNo: 'ERP-B' },
  ];
  lotDelegate.findMany = async (args) => {
    lotQuery = args;
    return [
      {
        ragicRecordId: '201', lotNo: 'LOT-Y', erpPartNo: 'ERP-A', warehouseCode: ' ye1 ',
        stockStatus: '在庫', qualityStatus: '正常', stockPc: 30, stockKg: 0.3,
        unitWeightG: null, expectedStockPc: null, stockPcDiff: null,
        stockPcDiffPct: null, quantityAnomaly: false,
        sourceWorkOrderNo: null, sourceWorkOrderType: null,
      },
      {
        ragicRecordId: '202', lotNo: 'LOT-W', erpPartNo: 'ERP-A', warehouseCode: 'WFG',
        stockStatus: '在庫', qualityStatus: '正常', stockPc: 20, stockKg: 0.2,
        unitWeightG: null, expectedStockPc: null, stockPcDiff: null,
        stockPcDiffPct: null, quantityAnomaly: false,
        sourceWorkOrderNo: null, sourceWorkOrderType: null,
      },
    ];
  };
  workOrderDelegate.findMany = async () => [];

  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock?runId=9&partVersion=GROUP-01&warehouse=YE1&aggregated=true',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.erpPartNos, ['ERP-A', 'ERP-B']);
  assert.equal(body.totalPc, 30);
  assert.equal(body.lots.length, 1);
  assert.equal(body.lots[0].warehouseCode, ' ye1 ');
  assert.deepEqual(lotQuery, {
    where: { mrpRunId: 9, erpPartNo: { in: ['ERP-A', 'ERP-B'] } },
    orderBy: [{ erpPartNo: 'asc' }, { stockPc: 'desc' }, { lotNo: 'asc' }],
  });
});

test('產銷資料沒有成品月推摘要時以客料版本快照開啟倉庫明細', async () => {
  runDelegate.findUnique = async () => ({ syncCounts: { inventory_lots: 1 } });
  fgDelegate.findFirst = async () => null;
  partVersionDelegate.findFirst = async () => ({ erpPartNo: 'ERP-SM' });
  lotDelegate.findMany = async () => [{
    ragicRecordId: '301', lotNo: 'LOT-SM', erpPartNo: 'ERP-SM', warehouseCode: 'WFG',
    stockStatus: '在庫', qualityStatus: '正常', stockPc: 25, stockKg: 0.25,
    unitWeightG: null, expectedStockPc: null, stockPcDiff: null,
    stockPcDiffPct: null, quantityAnomaly: false,
    sourceWorkOrderNo: null, sourceWorkOrderType: null,
  }];
  workOrderDelegate.findMany = async () => [];

  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock?runId=11&partVersion=PV-SM&warehouse=INTERNAL&aggregated=false',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.erpPartNos, ['ERP-SM']);
  assert.equal(body.availablePc, 25);
});

test('倉庫明細拒絕無效參數', async () => {
  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock?runId=0&partVersion=&warehouse=OTHER',
  ));
  assert.equal(response.status, 400);
});

test('倉庫明細拒絕未知資料庫來源', async () => {
  const response = await GET(new NextRequest(
    'http://localhost/api/fg-monthly/warehouse-stock?runId=7&partVersion=PV-01&warehouse=INTERNAL&dbSource=unknown',
  ));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '無效的 dbSource' });
});
