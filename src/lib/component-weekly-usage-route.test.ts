import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET } from '../app/api/component-weekly/[materialPartNo]/usage-details/route';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const periodDelegate = prisma.componentWeeklyPeriod as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const bomDelegate = prisma.stagingWorkOrderBom as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const summaryDelegate = prisma.componentWeekly as unknown as {
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const inventoryDelegate = prisma.stagingInventory as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const lotDelegate = prisma.stagingInventoryLot as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const purchaseDelegate = prisma.stagingPurchaseOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const workOrderDelegate = prisma.stagingWorkOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const movementDelegate = prisma.stagingWorkOrderMaterialMovement as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const originals = {
  run: runDelegate.findUnique,
  periods: periodDelegate.findMany,
  boms: bomDelegate.findMany,
  summary: summaryDelegate.findFirst,
  inventory: inventoryDelegate.findMany,
  lots: lotDelegate.findMany,
  purchases: purchaseDelegate.findMany,
  workOrders: workOrderDelegate.findMany,
  movements: movementDelegate.findMany,
};

afterEach(() => {
  runDelegate.findUnique = originals.run;
  periodDelegate.findMany = originals.periods;
  bomDelegate.findMany = originals.boms;
  summaryDelegate.findFirst = originals.summary;
  inventoryDelegate.findMany = originals.inventory;
  lotDelegate.findMany = originals.lots;
  purchaseDelegate.findMany = originals.purchases;
  workOrderDelegate.findMany = originals.workOrders;
  movementDelegate.findMany = originals.movements;
});

function stubUsageRoute(
  inventoryRows: Array<Record<string, unknown>>,
  onInventoryQuery?: (args: unknown) => void,
  details: {
    periods?: Array<Record<string, unknown>>;
    bomRows?: Array<Record<string, unknown>>;
    inventoryLots?: Array<Record<string, unknown>>;
    workOrders?: Array<Record<string, unknown>>;
    movements?: Array<Record<string, unknown>>;
    onMovementQuery?: (args: unknown) => void;
  } = {},
) {
  runDelegate.findUnique = async () => ({
    versionCode: 'MRP-TEST',
    runDate: new Date('2026-08-05T00:00:00.000Z'),
  });
  periodDelegate.findMany = async () => details.periods ?? [{
    weekIndex: 1,
    weekLabel: 'W01 08/03',
    weekStart: new Date('2026-08-03T00:00:00.000Z'),
    usage: 0,
    receipts: 0,
    remainingStock: 0,
  }];
  bomDelegate.findMany = async () => details.bomRows ?? [];
  summaryDelegate.findFirst = async () => ({
    unit: 'pc',
    goodStockPc: 0,
    goodStockKg: 0,
    badStockPc: 0,
    badStockKg: 0,
    avgWeeklyUsage: 0,
    stockWeeks: 0,
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
    shortageStartWeek: null,
    shortageStartDate: null,
    shortageQty: 0,
    weeksUntilOrder: null,
    orderByDate: null,
    purchaseAction: 'lead_time_missing',
    overduePurchaseQty: 0,
    overduePurchaseCount: 0,
    futurePurchaseQty: 0,
    futurePurchaseCount: 0,
    nextPurchaseReceiptDate: null,
  });
  inventoryDelegate.findMany = async (args) => {
    onInventoryQuery?.(args);
    return inventoryRows;
  };
  lotDelegate.findMany = async () => details.inventoryLots ?? [];
  purchaseDelegate.findMany = async () => [];
  workOrderDelegate.findMany = async () => details.workOrders ?? [];
  movementDelegate.findMany = async (args) => {
    details.onMovementQuery?.(args);
    const rows = details.movements ?? [];
    const selectedWorkOrders = (
      args as { where?: { workOrderNo?: { in?: string[] } } }
    ).where?.workOrderNo?.in;
    return selectedWorkOrders
      ? rows.filter((row) => selectedWorkOrders.includes(String(row.workOrderNo)))
      : rows;
  };
}

async function getUsageDetails(mrpType = 'B', weekIndex: number | 'all' = 'all') {
  return GET(
    new NextRequest(
      `http://localhost/api/component-weekly/ERP-B/usage-details?mrpType=${mrpType}&runId=54&weekIndex=${weekIndex}`,
    ),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
}

test('元件週推明細回傳本 Run 採購前置期的 Source 料號主檔來源', async () => {
  let inventoryQuery: unknown;
  stubUsageRoute([{
    id: 1,
    sourceRecordId: '2401',
    erpPartNo: 'ERP-B',
    subtypeCode: null,
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
  }], (args) => {
    inventoryQuery = args;
  });

  const response = await getUsageDetails();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.inventorySource, {
    sourceRecordId: '2401',
    erpPartNo: 'ERP-B',
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
    ambiguous: false,
    candidateCount: 1,
  });
  assert.deepEqual(inventoryQuery, {
    where: { mrpRunId: 54, erpPartNo: 'ERP-B' },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      sourceRecordId: true,
      erpPartNo: true,
      subtypeCode: true,
      purchaseLeadWeeks: true,
      purchaseLeadWeeksConfigured: true,
    },
  });
});

test('孤兒 BOM 保留在排除明細，但不污染上方工令需求與剩餘需求合計', async () => {
  stubUsageRoute([], undefined, { bomRows: [{
    sourceRecordId: '23670', componentNo: 'ERP-B', woNumber: null,
    sourceType: '採購', processCode: null, unit: 'pc', minUsage: 451,
    issuedQty: 0, remainingUsage: null, issuedQtyState: 'unknown',
    issuedQtyError: 'unlinked_work_order', issuedDetailCount: 0,
    movementState: 'fallback', movementError: 'movement_source_unavailable',
    startDate: new Date('2026-08-04T00:00:00Z'),
  }] });
  const response = await getUsageDetails();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.materialSummary.plannedUsage, 0, 'ORPHAN_SUMMARY_EXCLUSION');
  assert.equal(body.materialSummary.remainingUsage, 0);
  assert.equal(body.excluded[0].plannedUsage, 451);
  assert.equal(body.excluded[0].reason, 'unlinked_work_order');
});

test('元件週推明細遇到重複 ERP 主檔時固定顯示最新快照但停用來源連結', async () => {
  stubUsageRoute([
    {
      id: 1,
      sourceRecordId: '2401',
      erpPartNo: 'ERP-B',
      subtypeCode: null,
      purchaseLeadWeeks: 12,
      purchaseLeadWeeksConfigured: true,
    },
    {
      id: 2,
      sourceRecordId: '2402',
      erpPartNo: 'ERP-B',
      subtypeCode: null,
      purchaseLeadWeeks: 26,
      purchaseLeadWeeksConfigured: true,
    },
  ]);

  const response = await getUsageDetails();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.inventorySource, {
    sourceRecordId: null,
    erpPartNo: 'ERP-B',
    purchaseLeadWeeks: 26,
    purchaseLeadWeeksConfigured: true,
    ambiguous: true,
    candidateCount: 2,
  });
});

test('W 元件週推明細只以合法線材 subtype 計算主檔來源數', async () => {
  stubUsageRoute([
    {
      id: 2,
      sourceRecordId: '2402',
      erpPartNo: 'ERP-B',
      subtypeCode: 'OTHER',
      purchaseLeadWeeks: 26,
      purchaseLeadWeeksConfigured: true,
    },
    {
      id: 1,
      sourceRecordId: '2401',
      erpPartNo: 'ERP-B',
      subtypeCode: 'MTRL-WR',
      purchaseLeadWeeks: 12,
      purchaseLeadWeeksConfigured: true,
    },
  ]);

  const response = await getUsageDetails('W');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.inventorySource, {
    sourceRecordId: '2401',
    erpPartNo: 'ERP-B',
    purchaseLeadWeeks: 12,
    purchaseLeadWeeksConfigured: true,
    ambiguous: false,
    candidateCount: 1,
  });
});

test('元件週推明細遇到未確認領退料時摘要保留未知，不把空值偽裝成 0', async () => {
  stubUsageRoute([], undefined, {
    bomRows: [{
      sourceRecordId: '24105',
      componentNo: 'ERP-B',
      woNumber: 'DEMO-WO-101',
      sourceType: '內製',
      processCode: '鍛造',
      unit: 'pc',
      minUsage: 2220,
      alreadyPicked: 'No',
      issuedQty: 4493,
      grossIssuedQty: 2226,
      consumedQty: null,
      returnedQty: null,
      netIssuedQty: null,
      reservedQty: null,
      remainingUsage: null,
      overIssuedQty: null,
      issuedQtyState: 'unknown',
      issuedDetailCount: 4,
      issuedQtyError: 'issue_state_mismatch',
      movementState: 'unknown',
      movementDetailCount: 6,
      movementError: 'movement_consumption_exceeds_issue',
      startDate: new Date('2026-07-15T00:00:00.000Z'),
    }],
    workOrders: [{
      sourceRecordId: '29770',
      woNumber: 'DEMO-WO-101',
      erpPartNo: 'FG-01',
      status: '未結案',
      startDate: new Date('2026-07-15T00:00:00.000Z'),
    }],
  });

  const response = await getUsageDetails();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.excluded[0]?.grossIssuedQty, 2226);
  assert.equal(body.excluded[0]?.returnedQty, null);
  assert.equal(body.excluded[0]?.netIssuedQty, null);
  assert.equal(body.excluded[0]?.remainingUsage, null);
  assert.equal(body.materialSummary.grossIssuedQty, 2226);
  assert.equal(body.materialSummary.returnedQty, null);
  assert.equal(body.materialSummary.netIssuedQty, null);
  assert.equal(body.materialSummary.remainingUsage, null);
});

test('週別明細保留選取工令異動表，但批號狀態取得同 Run 同料號的後續再領用脈絡', async () => {
  let movementQuery: unknown;
  stubUsageRoute([], undefined, {
    periods: [
      {
        weekIndex: 0,
        weekLabel: '前期',
        weekStart: null,
        usage: 100,
        receipts: 0,
        remainingStock: -100,
      },
      {
        weekIndex: 1,
        weekLabel: 'W01 08/03',
        weekStart: new Date('2026-08-03T00:00:00.000Z'),
        usage: 100,
        receipts: 0,
        remainingStock: -200,
      },
    ],
    bomRows: [
      {
        sourceRecordId: '2801',
        componentNo: 'ERP-B',
        woNumber: 'WO-RETURN',
        unit: 'pc',
        minUsage: 100,
        issuedQty: 0,
        grossIssuedQty: 0,
        consumedQty: 0,
        returnedQty: 0,
        netIssuedQty: 0,
        reservedQty: 0,
        remainingUsage: 100,
        overIssuedQty: 0,
        issuedQtyState: 'known',
        issuedDetailCount: 1,
        movementState: 'known',
        movementDetailCount: 1,
        startDate: new Date('2026-07-20T00:00:00.000Z'),
      },
      {
        sourceRecordId: '2802',
        componentNo: 'ERP-B',
        woNumber: 'WO-REISSUE',
        unit: 'pc',
        minUsage: 100,
        issuedQty: 0,
        grossIssuedQty: 0,
        consumedQty: 0,
        returnedQty: 0,
        netIssuedQty: 0,
        reservedQty: 0,
        remainingUsage: 100,
        overIssuedQty: 0,
        issuedQtyState: 'known',
        issuedDetailCount: 1,
        movementState: 'known',
        movementDetailCount: 1,
        startDate: new Date('2026-08-05T00:00:00.000Z'),
      },
    ],
    workOrders: [
      {
        sourceRecordId: '9601',
        woNumber: 'WO-RETURN',
        erpPartNo: 'FG-01',
        status: '未結案',
        startDate: new Date('2026-07-20T00:00:00.000Z'),
      },
      {
        sourceRecordId: '9602',
        woNumber: 'WO-REISSUE',
        erpPartNo: 'FG-02',
        status: '未結案',
        startDate: new Date('2026-08-05T00:00:00.000Z'),
      },
    ],
    movements: [
      {
        sourceRecordId: '2001',
        workOrderNo: 'WO-RETURN',
        componentNo: 'ERP-B',
        inventoryLotNo: 'LOT-1',
        movementDate: new Date('2026-07-20T00:00:00.000Z'),
        movementType: '退料',
        movementQtyPc: 100,
      },
      {
        sourceRecordId: '2002',
        workOrderNo: 'WO-REISSUE',
        componentNo: 'ERP-B',
        inventoryLotNo: 'LOT-1',
        movementDate: new Date('2026-08-05T00:00:00.000Z'),
        movementType: '領料',
        movementQtyPc: -100,
      },
    ],
    onMovementQuery: (args) => {
      movementQuery = args;
    },
  });

  const response = await getUsageDetails('B', 0);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.movements.map((row: { workOrderNo: string }) => row.workOrderNo), ['WO-RETURN']);
  assert.deepEqual(
    body.movementContext.map((row: { workOrderNo: string }) => row.workOrderNo),
    ['WO-RETURN', 'WO-REISSUE'],
  );
  assert.deepEqual(
    (movementQuery as { where: Record<string, unknown> }).where,
    { mrpRunId: 54, componentNo: 'ERP-B' },
  );
});

test('未排程待領用需求在明細契約中明確回報，不只併入前期', async () => {
  stubUsageRoute([], undefined, {
    bomRows: [{
      sourceRecordId: '2801',
      componentNo: 'ERP-B',
      woNumber: 'WO-UNSCHEDULED',
      unit: 'pc',
      minUsage: 125,
      issuedQty: 0,
      grossIssuedQty: 0,
      consumedQty: 0,
      returnedQty: 0,
      netIssuedQty: 0,
      reservedQty: 0,
      remainingUsage: 125,
      overIssuedQty: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 0,
      movementState: 'fallback',
      movementDetailCount: 0,
      startDate: null,
    }],
    workOrders: [{
      sourceRecordId: '9601',
      woNumber: 'WO-UNSCHEDULED',
      erpPartNo: 'FG-01',
      status: '未結案',
      startDate: null,
    }],
  });

  const response = await getUsageDetails();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.unscheduledDemand, { count: 1, qty: 125 });
  assert.equal(body.included[0]?.dateSource, 'missing');
});
