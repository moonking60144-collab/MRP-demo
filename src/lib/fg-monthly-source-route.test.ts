import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma, { currentDbMode, getClientForMode } from './db';
import { GET as fgMonthlyGET } from '../app/api/fg-monthly/route';
import { GET } from '../app/api/fg-monthly/[partVersion]/source-records/route';
import { GET as sourcesGET } from '../app/api/fg-monthly/[partVersion]/sources/route';
import { GET as periodsGET } from '../app/api/fg-monthly/[partVersion]/periods/route';
import { POST as batchPeriodsPOST } from '../app/api/fg-monthly/batch-periods/route';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const partVersionSingleDelegate = prisma.stagingPartVersion as unknown as {
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const orderDelegate = prisma.stagingOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const inventoryDelegate = prisma.stagingInventory as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const forecastDelegate = prisma.stagingForecast as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const workOrderDelegate = prisma.stagingWorkOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const workOrderBomDelegate = prisma.stagingWorkOrderBom as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const productionPlanDelegate = prisma.stagingProductionPlan as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const partVersionDelegate = prisma.stagingPartVersion as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const periodDelegate = prisma.fgMonthlyPeriod as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const suggestionDelegate = prisma.fgPlanSuggestion as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};
const transferDelegate = prisma.productionPlanTransfer as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};
const fgMonthlyDelegate = prisma.fgMonthly as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  count: (args: unknown) => Promise<number>;
  aggregate: (args: unknown) => Promise<{ _sum: Record<string, unknown> }>;
  groupBy: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const originals = {
  queryRaw: getClientForMode(currentDbMode())!.$queryRaw,
  run: runDelegate.findUnique,
  partVersionSingle: partVersionSingleDelegate.findFirst,
  orders: orderDelegate.findMany,
  inventory: inventoryDelegate.findMany,
  forecasts: forecastDelegate.findMany,
  workOrders: workOrderDelegate.findMany,
  workOrderBoms: workOrderBomDelegate.findMany,
  productionPlans: productionPlanDelegate.findMany,
  partVersions: partVersionDelegate.findMany,
  periods: periodDelegate.findMany,
  suggestions: suggestionDelegate.findMany,
  recoverSuggestions: suggestionDelegate.updateMany,
  transfers: transferDelegate.findMany,
  recoverTransfers: transferDelegate.updateMany,
  fgMonthlyRows: fgMonthlyDelegate.findMany,
  fgMonthlyCount: fgMonthlyDelegate.count,
  fgMonthlyAggregate: fgMonthlyDelegate.aggregate,
  fgMonthlyGroupBy: fgMonthlyDelegate.groupBy,
};

afterEach(() => {
  getClientForMode(currentDbMode())!.$queryRaw = originals.queryRaw;
  runDelegate.findUnique = originals.run;
  partVersionSingleDelegate.findFirst = originals.partVersionSingle;
  orderDelegate.findMany = originals.orders;
  inventoryDelegate.findMany = originals.inventory;
  forecastDelegate.findMany = originals.forecasts;
  workOrderDelegate.findMany = originals.workOrders;
  workOrderBomDelegate.findMany = originals.workOrderBoms;
  productionPlanDelegate.findMany = originals.productionPlans;
  partVersionDelegate.findMany = originals.partVersions;
  periodDelegate.findMany = originals.periods;
  suggestionDelegate.findMany = originals.suggestions;
  suggestionDelegate.updateMany = originals.recoverSuggestions;
  transferDelegate.findMany = originals.transfers;
  transferDelegate.updateMany = originals.recoverTransfers;
  fgMonthlyDelegate.findMany = originals.fgMonthlyRows;
  fgMonthlyDelegate.count = originals.fgMonthlyCount;
  fgMonthlyDelegate.aggregate = originals.fgMonthlyAggregate;
  fgMonthlyDelegate.groupBy = originals.fgMonthlyGroupBy;
});

test('成品月推來源總覽固定使用指定 Run 與單一 DB source，並回傳同一 identity', async () => {
  const mode = currentDbMode();
  const runQueries: Array<Record<string, unknown>> = [];
  const partVersionQueries: Array<Record<string, unknown>> = [];
  runDelegate.findUnique = async (args) => {
    runQueries.push(args as Record<string, unknown>);
    return {
      id: 45,
      runDate: new Date('2026-07-27T00:00:00.000Z'),
      orderDemandContractVersion: 'order-demand-v2-manual-close',
    };
  };
  partVersionSingleDelegate.findFirst = async (args) => {
    partVersionQueries.push(args as Record<string, unknown>);
    return { partVersion: 'PV-A', erpPartNo: 'ERP-A' };
  };
  inventoryDelegate.findMany = async () => [];
  orderDelegate.findMany = async () => [];
  forecastDelegate.findMany = async () => [];
  workOrderDelegate.findMany = async () => [];
  workOrderBomDelegate.findMany = async () => [];
  productionPlanDelegate.findMany = async () => [];
  transferDelegate.findMany = async () => [];

  const response = await sourcesGET(
    new NextRequest(
      `http://localhost/api/fg-monthly/PV-A/sources?runId=45&dbSource=${mode}`,
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.partVersion, 'PV-A');
  assert.equal(body.runId, 45);
  assert.equal(body.dbSource, mode);
  assert.deepEqual(runQueries, [{
    where: { id: 45 },
    select: { id: true, runDate: true, orderDemandContractVersion: true },
  }]);
  assert.equal(body.contractVersion, 'order-demand-v2-manual-close');
  assert.deepEqual(partVersionQueries, [{
    where: { mrpRunId: 45, partVersion: 'PV-A' },
  }]);
});

test('成品月推來源總覽拒絕無效、不存在的 Run 與 DB source', async () => {
  let runQueryCount = 0;
  runDelegate.findUnique = async () => {
    runQueryCount++;
    return { id: 45 };
  };

  const invalidRun = await sourcesGET(
    new NextRequest('http://localhost/api/fg-monthly/PV-A/sources?runId=bad'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const invalidDbSource = await sourcesGET(
    new NextRequest('http://localhost/api/fg-monthly/PV-A/sources?runId=45&dbSource=invalid'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );

  assert.equal(invalidRun.status, 400);
  assert.equal(invalidDbSource.status, 400);
  assert.equal(runQueryCount, 0);

  runDelegate.findUnique = async () => {
    runQueryCount++;
    return null;
  };
  const missingRun = await sourcesGET(
    new NextRequest(
      `http://localhost/api/fg-monthly/PV-A/sources?runId=999&dbSource=${currentDbMode()}`,
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );

  assert.equal(missingRun.status, 404);
  assert.equal(runQueryCount, 1);
});

test('成品月推聚合來源總覽以全部成員與 ERP scope 查詢，不只查代表料號', async () => {
  const orderQueries: Array<Record<string, unknown>> = [];
  const inventoryQueries: Array<Record<string, unknown>> = [];
  runDelegate.findUnique = async () => ({
    id: 45,
    orderDemandContractVersion: 'order-demand-v2-manual-close',
  });
  partVersionDelegate.findMany = async () => [
    { partVersion: 'PV-A', erpPartNo: 'ERP-A' },
    { partVersion: 'PV-B', erpPartNo: 'ERP-B' },
  ];
  workOrderDelegate.findMany = async () => [];
  workOrderBomDelegate.findMany = async () => [];
  inventoryDelegate.findMany = async (args) => {
    inventoryQueries.push(args as Record<string, unknown>);
    return [];
  };
  orderDelegate.findMany = async (args) => {
    orderQueries.push(args as Record<string, unknown>);
    return [];
  };
  forecastDelegate.findMany = async () => [];
  productionPlanDelegate.findMany = async () => [];
  transferDelegate.findMany = async () => [];

  const response = await sourcesGET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-GROUP/sources?runId=45'
      + '&partVersion=PV-A&partVersion=PV-B',
    ),
    { params: Promise.resolve({ partVersion: 'PV-GROUP' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.sourcePartVersions, ['PV-A', 'PV-B']);
  assert.deepEqual(body.erpPartNos, ['ERP-A', 'ERP-B']);
  assert.deepEqual(
    (orderQueries[0].where as { partVersion: unknown }).partVersion,
    { in: ['PV-A', 'PV-B'] },
  );
  assert.deepEqual(
    (inventoryQueries[0].where as { erpPartNo: unknown }).erpPartNo,
    { in: ['ERP-A', 'ERP-B'] },
  );
});

test('成品月推來源明細固定選取 Run、期間與聚合成員，訂單由 contract 判定貢獻', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  const orderQueries: Array<Record<string, unknown>> = [];
  orderDelegate.findMany = async (args) => {
    orderQueries.push(args as Record<string, unknown>);
    return [];
  };

  const response = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-GROUP/source-records'
      + '?runId=42&type=orders&metric=ordersUnshipped&periodIndex=0'
      + '&partVersion=PV-A&partVersion=PV-B',
    ),
    { params: Promise.resolve({ partVersion: 'PV-GROUP' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.runId, 42);
  assert.equal(body.periodIndex, 0);
  assert.deepEqual(body.partVersions, ['PV-A', 'PV-B']);
  assert.equal(orderQueries.length, 1);
  assert.deepEqual(
    (orderQueries[0].where as { partVersion: unknown }).partVersion,
    { in: ['PV-A', 'PV-B'] },
  );
  assert.equal('AND' in (orderQueries[0].where as Record<string, unknown>), false);
});

test('v2 人工結案在訂單總量顯示 direct 已出庫貢獻，但不列入未出庫需求', async () => {
  runDelegate.findUnique = async () => ({
    runDate: new Date('2026-07-27T00:00:00.000Z'),
    orderDemandContractVersion: 'order-demand-v2-manual-close',
  });
  orderDelegate.findMany = async () => [{
    ragicRecordId: 'manual-close-partial',
    partVersion: 'PV-A',
    designatedShipDate: new Date('2026-08-05T00:00:00.000Z'),
    deliveryDate: new Date('2026-08-05T00:00:00.000Z'),
    orderQty: 1000,
    preparedQty: 500,
    unprepQty: 0,
    shippedQty: 300,
    unshippedQty: 0,
    soldQty: 200,
    unsoldQty: 0,
    salesStatus: '人工結案',
    shipmentStatus: '人工結案',
    prepStatus: '人工結案',
  }];

  const totalResponse = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=orders&metric=ordersTotal&periodIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const totalBody = await totalResponse.json();
  const outstandingResponse = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=orders&metric=ordersUnshipped&periodIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const outstandingBody = await outstandingResponse.json();

  assert.equal(totalResponse.status, 200);
  assert.equal(totalBody.contractVersion, 'order-demand-v2-manual-close');
  assert.equal(totalBody.records.length, 1);
  assert.equal(totalBody.records[0].orderDemandContribution.recognizedOrderQty, 300);
  assert.equal(totalBody.records[0].orderDemandAttribution.recognizedOrderQty, 300);
  assert.equal(totalBody.records[0].orderDemandAttribution.status, 'included_period');
  assert.equal(totalBody.records[0].orderDemandContribution.closedUnfulfilledQty, 700);
  assert.equal(outstandingResponse.status, 200);
  assert.equal(outstandingBody.records.length, 0);
});

test('成品月推來源明細拒絕無效 Run 與期間', async () => {
  const invalidRun = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records?runId=bad&type=orders&periodIndex=0',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(invalidRun.status, 400);

  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  const invalidPeriod = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records?runId=42&type=orders&periodIndex=999',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(invalidPeriod.status, 400);
});

test('成品月推來源明細拒絕未知 metric 與不相容的來源 type，且不查詢資料庫', async () => {
  let runQueryCount = 0;
  let orderQueryCount = 0;
  runDelegate.findUnique = async () => {
    runQueryCount++;
    return { runDate: new Date('2026-07-27T00:00:00.000Z') };
  };
  orderDelegate.findMany = async () => {
    orderQueryCount++;
    return [];
  };

  const unknownMetric = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=orders&metric=unexpected&periodIndex=0',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(unknownMetric.status, 400);
  assert.deepEqual(await unknownMetric.json(), { error: 'invalid metric' });

  const incompatibleType = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=orders&metric=forecastQty&periodIndex=0',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(incompatibleType.status, 400);
  assert.deepEqual(await incompatibleType.json(), { error: 'metric is not valid for type' });
  assert.equal(runQueryCount, 0);
  assert.equal(orderQueryCount, 0);
});

test('成品月推訂單來源排除指定出貨日空白的資料，不以客戶需求日代替', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  orderDelegate.findMany = async () => [
    {
      ragicRecordId: 'missing-designated',
      partVersion: 'PV-A',
      designatedShipDate: null,
      deliveryDate: new Date('2026-08-05T00:00:00.000Z'),
      orderQty: 100,
      unshippedQty: 100,
      salesStatus: '未結案',
      prepStatus: null,
    },
    {
      ragicRecordId: 'engine-attributed',
      partVersion: 'PV-A',
      designatedShipDate: new Date('2026-08-05T00:00:00.000Z'),
      deliveryDate: new Date('2026-09-05T00:00:00.000Z'),
      orderQty: 80,
      unshippedQty: 80,
      salesStatus: '未結案',
      prepStatus: null,
    },
  ];

  const response = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=orders&metric=ordersUnshipped&periodIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.records.map((row: { ragicRecordId: string }) => row.ragicRecordId), [
    'engine-attributed',
  ]);
  assert.equal(body.records[0].orderDemandAttribution.status, 'included_period');
});

test('成品月推來源總覽保留缺指定出貨日的實際資料，但不把它算入 MRP 合計', async () => {
  runDelegate.findUnique = async () => ({
    id: 45,
    runDate: new Date('2026-07-27T00:00:00.000Z'),
    orderDemandContractVersion: 'order-demand-v2-manual-close',
  });
  partVersionSingleDelegate.findFirst = async () => ({
    partVersion: 'PV-A',
    erpPartNo: 'ERP-A',
  });
  inventoryDelegate.findMany = async () => [];
  workOrderDelegate.findMany = async () => [];
  workOrderBomDelegate.findMany = async () => [];
  forecastDelegate.findMany = async () => [];
  productionPlanDelegate.findMany = async () => [];
  transferDelegate.findMany = async () => [];
  orderDelegate.findMany = async () => [{
    ragicRecordId: 'missing-designated',
    partVersion: 'PV-A',
    designatedShipDate: null,
    orderQty: 1000,
    preparedQty: 500,
    shippedQty: 300,
    soldQty: 200,
    unshippedQty: 700,
    salesStatus: '未結案',
    prepStatus: '未完成',
  }];

  const response = await sourcesGET(
    new NextRequest(
      `http://localhost/api/fg-monthly/PV-A/sources?runId=45&dbSource=${currentDbMode()}`,
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.orders.length, 1);
  assert.equal(
    body.orders[0].orderDemandAttribution.status,
    'excluded_missing_designated_ship_date',
  );
  assert.equal(body.orderDemandSummary.rawOrderQty, 1000);
  assert.equal(body.orderDemandSummary.shippedQty, 300);
  assert.equal(body.orderDemandSummary.recognizedOrderQty, 0);
  assert.equal(body.orderDemandSummary.outstandingOrderQty, 0);
  assert.equal(body.orderDemandSummary.demandResolvedQty, 0);
});

test('成品月推共用 ERP 的未歸屬生產計畫只出現在 engine 選定的 display owner', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  partVersionDelegate.findMany = async (args) => {
    const where = (args as { where: { partVersion?: { in?: string[] } } }).where;
    if (where.partVersion?.in) {
      return where.partVersion.in.map((partVersion) => ({
        partVersion,
        erpPartNo: 'ERP-A',
        customerCode: partVersion === 'PV-A' ? 'AA' : 'ZZ',
      }));
    }
    return [
      { partVersion: 'PV-A', erpPartNo: 'ERP-A', customerCode: 'AA' },
      { partVersion: 'PV-B', erpPartNo: 'ERP-A', customerCode: 'ZZ' },
    ];
  };
  productionPlanDelegate.findMany = async (args) => {
    const where = (args as { where: Record<string, unknown> }).where;
    if ('partVersion' in where) return [];
    return [{
      ragicRecordId: 'shared-plan',
      partVersion: null,
      erpPartNo: 'ERP-A',
      completionDate: new Date('2026-08-12T00:00:00.000Z'),
      planQty: 300,
      reportedQty: 0,
      closedQty: 0,
    }];
  };

  const ownerResponse = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=production_plans&metric=plannedOutput&periodIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const memberResponse = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-B/source-records'
      + '?runId=42&type=production_plans&metric=plannedOutput&periodIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-B' }) },
  );
  const ownerBody = await ownerResponse.json();
  const memberBody = await memberResponse.json();

  assert.equal(ownerResponse.status, 200);
  assert.equal(memberResponse.status, 200);
  assert.equal(
    ownerBody.records.reduce((sum: number, row: { planQty: number }) => sum + row.planQty, 0),
    300,
  );
  assert.equal(memberBody.records.length, 0);
});


test('成品月推多 ERP 聚合來源保留各 ERP display owner 的未歸屬生產計畫', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  partVersionDelegate.findMany = async (args) => {
    const where = (args as {
      where: {
        partVersion?: { in?: string[] };
        erpPartNo?: { in?: string[] };
      };
    }).where;
    if (where.partVersion?.in) {
      return [
        { partVersion: 'PV-A1', erpPartNo: 'ERP-A', customerCode: 'AA' },
        { partVersion: 'PV-A2', erpPartNo: 'ERP-A', customerCode: 'ZZ' },
        { partVersion: 'PV-B', erpPartNo: 'ERP-B', customerCode: 'BB' },
      ];
    }
    if (where.erpPartNo?.in) {
      return [
        { partVersion: 'PV-A1', erpPartNo: 'ERP-A', customerCode: 'AA' },
        { partVersion: 'PV-A2', erpPartNo: 'ERP-A', customerCode: 'ZZ' },
        { partVersion: 'PV-B', erpPartNo: 'ERP-B', customerCode: 'BB' },
      ];
    }
    return [];
  };
  let productionPlanWhere: Record<string, unknown> | null = null;
  productionPlanDelegate.findMany = async (args) => {
    productionPlanWhere = (args as { where: Record<string, unknown> }).where;
    return [{
      ragicRecordId: 'shared-plan-erp-a',
      partVersion: null,
      erpPartNo: 'ERP-A',
      completionDate: new Date('2026-08-12T00:00:00.000Z'),
      planQty: 300,
      reportedQty: 0,
      closedQty: 0,
    }];
  };

  const response = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-GROUP/source-records'
      + '?runId=42&type=production_plans&metric=plannedOutput&periodIndex=1'
      + '&partVersion=PV-A1&partVersion=PV-A2&partVersion=PV-B',
    ),
    { params: Promise.resolve({ partVersion: 'PV-GROUP' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    body.records.reduce((sum: number, row: { planQty: number }) => sum + row.planQty, 0),
    300,
  );
  assert.deepEqual(productionPlanWhere, {
    mrpRunId: 42,
    OR: [
      { erpPartNo: { in: ['ERP-A', 'ERP-B'] } },
      { partVersion: { in: ['PV-A1', 'PV-A2', 'PV-B'] } },
    ],
  });
});

test('成品月推摘要來源依鍛造排程與生產計畫數字套用同一組計算篩選', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  partVersionDelegate.findMany = async () => [
    { partVersion: 'PV-A', erpPartNo: null, customerCode: 'AA' },
  ];
  const workOrderQueries: Array<Record<string, unknown>> = [];
  const productionPlanQueries: Array<Record<string, unknown>> = [];
  workOrderDelegate.findMany = async (args) => {
    workOrderQueries.push(args as Record<string, unknown>);
    return [];
  };
  productionPlanDelegate.findMany = async (args) => {
    productionPlanQueries.push(args as Record<string, unknown>);
    return [{
      ragicRecordId: 'reported-plan',
      partVersion: 'PV-A',
      erpPartNo: null,
      completionDate: null,
      planQty: 0,
      reportedQty: 12,
      closedQty: 0,
    }];
  };

  const scheduled = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=work_orders&metric=woScheduled',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const reported = await GET(
    new NextRequest(
      'http://localhost/api/fg-monthly/PV-A/source-records'
      + '?runId=42&type=production_plans&metric=planReportedQty',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );

  assert.equal(scheduled.status, 200);
  assert.equal(reported.status, 200);
  assert.equal((await reported.json()).records.length, 1);
  assert.deepEqual(
    (workOrderQueries[0].where as Record<string, unknown>),
    {
      mrpRunId: 42,
      partVersion: 'PV-A',
      subProcessCode: 'HF01',
      jobOrderCode: { notIn: ['99', ''] },
    },
  );
  assert.deepEqual(
    (productionPlanQueries[0].where as Record<string, unknown>),
    {
      mrpRunId: 42,
      partVersion: 'PV-A',
    },
  );
});

test('成品月推 batch periods 固定使用指定 Run 並回傳資料庫 identity', async () => {
  runDelegate.findUnique = async () => ({ id: 45 });
  const periodQueries: Array<Record<string, unknown>> = [];
  periodDelegate.findMany = async (args) => {
    periodQueries.push(args as Record<string, unknown>);
    return [];
  };

  const response = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/fg-monthly/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partVersions: ['PV-A'],
        runId: 45,
        aggregated: false,
      }),
    },
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.runId, 45);
  assert.equal(body.dbSource, null);
  assert.equal(periodQueries.length, 1);
  assert.deepEqual(
    (periodQueries[0].where as { mrpRunId: number; partVersion: unknown }),
    { mrpRunId: 45, partVersion: { in: ['PV-A'] }, isAggregated: false },
  );
});

test('成品月推 batch periods 拒絕無效 Run 與 DB source', async () => {
  const invalidRun = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/fg-monthly/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partVersions: ['PV-A'],
        runId: 'bad',
      }),
    },
  ));
  assert.equal(invalidRun.status, 400);

  const invalidDbSource = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/fg-monthly/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partVersions: ['PV-A'],
        runId: 45,
        dbSource: 'invalid',
      }),
    },
  ));
  assert.equal(invalidDbSource.status, 400);
});

test('成品月推單筆期間固定使用指定 Run 並回傳資料庫 identity', async () => {
  const runQueries: Array<Record<string, unknown>> = [];
  runDelegate.findUnique = async (args) => {
    runQueries.push(args as Record<string, unknown>);
    return { id: 45 };
  };
  periodDelegate.findMany = async () => [];
  suggestionDelegate.updateMany = async () => ({ count: 0 });
  suggestionDelegate.findMany = async () => [];
  transferDelegate.updateMany = async () => ({ count: 0 });
  transferDelegate.findMany = async () => [];

  const response = await periodsGET(
    new NextRequest('http://localhost/api/fg-monthly/PV-A/periods?runId=45'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(runQueries, [{ where: { id: 45 } }]);
  assert.equal(body.runId, 45);
  assert.equal(body.dbSource, null);
});

test('成品月推單筆期間拒絕無效或不存在的 Run', async () => {
  const invalidRun = await periodsGET(
    new NextRequest('http://localhost/api/fg-monthly/PV-A/periods?runId=bad'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(invalidRun.status, 400);

  runDelegate.findUnique = async () => null;
  const missingRun = await periodsGET(
    new NextRequest('http://localhost/api/fg-monthly/PV-A/periods?runId=999'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  assert.equal(missingRun.status, 404);
});

test('成品月推聚合成員 API 固定使用指定 Run 與單一 DB source', async () => {
  const mode = currentDbMode();
  const runQueries: Array<Record<string, unknown>> = [];
  runDelegate.findUnique = async (args) => {
    runQueries.push(args as Record<string, unknown>);
    return {
      id: 45,
      versionCode: 'MRP-45',
      status: 'completed',
      syncCounts: {},
      runDate: new Date('2026-07-30T00:00:00.000Z'),
    };
  };
  fgMonthlyDelegate.findMany = async () => [];
  fgMonthlyDelegate.count = async () => 0;

  const response = await fgMonthlyGET(new NextRequest(
    `http://localhost/api/fg-monthly?runId=45&dbSource=${mode}`
    + '&partVersionsIn=PV-A,PV-B&includeIgnored=true',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(runQueries, [{ where: { id: 45 } }]);
  assert.equal(body.runId, 45);
  assert.equal(body.dbSource, mode);
  assert.deepEqual(body.items, []);
});

test('成品月推 totals 使用獨立回應且不查列表或來源 enrichment', async () => {
  runDelegate.findUnique = async () => ({
    id: 45,
    versionCode: 'MRP-45',
    status: 'completed',
    syncCounts: {},
    runDate: new Date('2026-07-30T00:00:00.000Z'),
  });
  const summaryQueries: Array<Record<string, unknown>> = [];
  fgMonthlyDelegate.findMany = async (args) => {
    summaryQueries.push(args as Record<string, unknown>);
    return [{
      partVersion: 'PV-A',
      erpPartNo: 'ERP-A',
      currentStockPc: 100,
      wfgStockPc: 60,
      ye1StockPc: 40,
      badStockPc: 0,
    }];
  };
  fgMonthlyDelegate.aggregate = async () => ({
    _sum: { currentStockPc: 100, badStockPc: 0 },
  });
  const periodQueries: Array<Record<string, unknown>> = [];
  periodDelegate.findMany = async (args) => {
    periodQueries.push(args as Record<string, unknown>);
    return [{
      partVersion: 'PV-A',
      periodIndex: 0,
      remainingStock: 80,
      remainingNoPlan: 70,
      plannedOutput: 10,
      demandIntegrated: 30,
      forecastQty: 30,
      ordersUnshipped: 20,
      ordersTotal: 25,
    }];
  };
  fgMonthlyDelegate.count = async () => {
    throw new Error('totals 不應查列表 count');
  };

  const response = await fgMonthlyGET(new NextRequest(
    'http://localhost/api/fg-monthly?runId=45&includeIgnored=true&totals=true',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 1);
  assert.deepEqual(body.totals.periods, [{
    periodIndex: 0,
    plannedOutput: 10,
    demandIntegrated: 30,
    forecastQty: 30,
    ordersUnshipped: 20,
    ordersTotal: 25,
    remainingStock: 80,
    remainingNoPlan: 70,
  }]);
  assert.equal(summaryQueries.length, 1);
  assert.equal('orderBy' in summaryQueries[0], false);
  assert.equal('take' in summaryQueries[0], false);
  assert.deepEqual(periodQueries[0].where, {
    mrpRunId: 45,
    isAggregated: false,
    partVersion: { in: ['PV-A'] },
  });
});

test('成品月推 totals 大集合維持整 Run period scan，避免巨大 IN 參數誤導查詢計畫', async () => {
  runDelegate.findUnique = async () => ({
    id: 45,
    versionCode: 'MRP-45',
    status: 'completed',
    syncCounts: {},
    runDate: new Date('2026-07-30T00:00:00.000Z'),
  });
  fgMonthlyDelegate.findMany = async () => Array.from({ length: 501 }, (_, index) => ({
    partVersion: `PV-${index}`,
    erpPartNo: index < 2 ? 'ERP-SHARED' : `ERP-${index}`,
    currentStockPc: 0,
    wfgStockPc: 0,
    ye1StockPc: 0,
    badStockPc: 0,
  }));
  fgMonthlyDelegate.aggregate = async () => ({ _sum: {} });
  const periodQueries: Array<{ sql: string; values: unknown[] }> = [];
  getClientForMode(currentDbMode())!.$queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    periodQueries.push({ sql: strings.join('?'), values });
    return [
      { partVersion: 'PV-0', periodIndex: 0, remainingStock: '100.25', remainingNoPlan: null,
        plannedOutput: '1.5', demandIntegrated: '2.25', forecastQty: null, ordersUnshipped: '3', ordersTotal: '4' },
      { partVersion: 'PV-1', periodIndex: 0, remainingStock: '-20.5', remainingNoPlan: null,
        plannedOutput: '0.5', demandIntegrated: '1.25', forecastQty: null, ordersUnshipped: '2', ordersTotal: '6' },
      { partVersion: 'OUTSIDE-FILTER', periodIndex: 0, remainingStock: '-9999', remainingNoPlan: '9999',
        plannedOutput: '9999', demandIntegrated: '9999', forecastQty: '9999', ordersUnshipped: '9999', ordersTotal: '9999' },
    ];
  }) as typeof originals.queryRaw;
  periodDelegate.findMany = async () => { throw new Error('large totals must avoid Decimal materialization'); };

  const response = await fgMonthlyGET(new NextRequest(
    'http://localhost/api/fg-monthly?runId=45&includeIgnored=true&totals=true',
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(periodQueries[0].values, [45, false]);
  assert.match(periodQueries[0].sql, /FROM mrp_out\.fg_monthly_periods/);
  assert.match(periodQueries[0].sql, /remaining_stock::text/);
  assert.doesNotMatch(periodQueries[0].sql, /\bIN\s*\(/);
  assert.match(response.headers.get('Server-Timing') ?? '', /totals_period_read/);
  const body = await response.json();
  assert.deepEqual(body.totals.periods, [{ periodIndex: 0, remainingStock: -20.5, remainingNoPlan: null,
    plannedOutput: 2, demandIntegrated: 3.5, forecastQty: null, ordersUnshipped: 5, ordersTotal: 10 }]);
});

test('成品月推 customerCode facet 由資料庫 groupBy 回傳計數', async () => {
  runDelegate.findUnique = async () => ({
    id: 45,
    versionCode: 'MRP-45',
    status: 'completed',
    syncCounts: {},
    runDate: new Date('2026-07-30T00:00:00.000Z'),
  });
  const groupQueries: Array<Record<string, unknown>> = [];
  fgMonthlyDelegate.groupBy = async (args) => {
    groupQueries.push(args as Record<string, unknown>);
    return [
      { customerCode: 'SM', _count: { _all: 2 } },
      { customerCode: 'SY', _count: { _all: 5 } },
    ];
  };
  fgMonthlyDelegate.findMany = async () => {
    throw new Error('facet 不應載入完整成品列');
  };

  const response = await fgMonthlyGET(new NextRequest(
    'http://localhost/api/fg-monthly?runId=45&includeIgnored=true'
    + '&facet=customerCode&facetType=enum&facetQuery=S&facetLimit=10',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.options, [
    { value: 'SM', label: 'SM', count: 2 },
    { value: 'SY', label: 'SY', count: 5 },
  ]);
  assert.equal(groupQueries.length, 1);
  assert.deepEqual(groupQueries[0].by, ['customerCode']);
  assert.deepEqual(groupQueries[0]._count, { _all: true });
});
