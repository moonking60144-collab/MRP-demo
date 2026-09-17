import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma, { currentDbMode } from './db';
import { GET } from '../app/api/sales-meeting/[partVersion]/source-records/route';
import { POST as batchPeriodsPOST } from '../app/api/sales-meeting/batch-periods/route';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const salesDelegate = prisma.salesMeeting as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const periodDelegate = prisma.salesMeetingPeriod as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const partDelegate = prisma.stagingPartVersion as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const orderDelegate = prisma.stagingOrder as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const planDelegate = prisma.stagingProductionPlan as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const originals = {
  run: runDelegate.findUnique,
  salesMany: salesDelegate.findMany,
  periods: periodDelegate.findMany,
  parts: partDelegate.findMany,
  orders: orderDelegate.findMany,
  plans: planDelegate.findMany,
};

afterEach(() => {
  runDelegate.findUnique = originals.run;
  salesDelegate.findMany = originals.salesMany;
  periodDelegate.findMany = originals.periods;
  partDelegate.findMany = originals.parts;
  orderDelegate.findMany = originals.orders;
  planDelegate.findMany = originals.plans;
});

test('產銷共享池餘額明細帶出同 ERP 成員訂單與生產計畫 Ragic 連結', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  salesDelegate.findMany = async (args) => {
    const where = (args as { where?: Record<string, unknown> }).where;
    if (where?.erpPartNo === 'ERP-01') {
      return [
        { customerCode: 'A', partVersion: 'PV-A' },
        { customerCode: 'B', partVersion: 'PV-B' },
      ];
    }
    return [{
      mrpRunId: 42,
      partVersion: 'PV-A',
      customerCode: 'A',
      erpPartNo: 'ERP-01',
      goodStockPc: 600,
      goodStockKg: 6,
      wfgStockPc: 400,
      ye1StockPc: 200,
    }];
  };
  partDelegate.findMany = async () => [{ partVersion: 'PV-A', customerPartNo: 'CP-A' }];
  periodDelegate.findMany = async () => [{
    id: 1,
    mrpRunId: 42,
    partVersion: 'PV-A',
    weekIndex: 1,
    weekLabel: 'W01',
    weekStart: new Date('2026-07-27T00:00:00.000Z'),
    demand: 100,
    supply: 50,
    remainingStock: 550,
  }];
  const orderQueries: Array<Record<string, unknown>> = [];
  orderDelegate.findMany = async (args) => {
    orderQueries.push(args as Record<string, unknown>);
    return [{
      id: 1,
      ragicRecordId: '701',
      partVersion: 'PV-B',
      orderNo: 'PO-1',
      unshippedQty: 100,
    }];
  };
  planDelegate.findMany = async () => [{
    id: 2,
    ragicRecordId: '801',
    partVersion: 'PV-B',
    erpPartNo: 'ERP-01',
    planNo: 'PP-1',
    planQty: 50,
  }];

  const response = await GET(
    new NextRequest(
      'http://localhost/api/sales-meeting/PV-A/source-records?runId=42&type=balance&weekIndex=1',
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sharedPool.isShared, true);
  assert.equal(body.orders[0].ragicUrl.endsWith('/default/forms31/2/701'), true);
  assert.equal(body.productionPlans[0].ragicUrl.endsWith('/default/d4/10/801'), true);
  assert.deepEqual(
    (orderQueries[0].where as { partVersion: unknown }).partVersion,
    { in: ['PV-A', 'PV-B'] },
  );
});

test('產銷來源明細拒絕缺少 weekIndex 的請求', async () => {
  const response = await GET(
    new NextRequest('http://localhost/api/sales-meeting/PV-A/source-records?runId=42&type=orders'),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );

  assert.equal(response.status, 400);
});

test('產銷摘要拒絕無效 scope、DB source 與跨群組成員', async () => {
  for (const query of ['scope=bad', 'scope=recent&type=production_plans', 'scope=all&dbSource=invalid']) {
    const params = new URLSearchParams({ runId: '42', type: 'orders', weekIndex: '0' });
    for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
    const response = await GET(new NextRequest(
      `http://localhost/api/sales-meeting/PV-A/source-records?${params}`,
    ), { params: Promise.resolve({ partVersion: 'PV-A' }) });
    assert.equal(response.status, 400);
  }
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00Z') });
  salesDelegate.findMany = async () => [
    { partVersion: 'PV-A', customerCode: 'A', erpPartNo: 'ERP-01' },
    { partVersion: 'PV-B', customerCode: 'B', erpPartNo: 'ERP-01' },
  ];
  partDelegate.findMany = async () => [
    { partVersion: 'PV-A', customerPartNo: 'CP-A' },
    { partVersion: 'PV-B', customerPartNo: 'CP-B' },
  ];
  const members = encodeURIComponent(JSON.stringify(['PV-A', 'PV-B']));
  const response = await GET(new NextRequest(
    `http://localhost/api/sales-meeting/PV-A/source-records?runId=42&type=orders&scope=all&memberPartVersions=${members}`,
  ), { params: Promise.resolve({ partVersion: 'PV-A' }) });
  assert.equal(response.status, 400);
});

test('近期與全部摘要範圍涵蓋前期及遠期，餘缺沿用群組快照、不加總共享庫存或生產計畫', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00Z') });
  const summaries = [
    { partVersion: 'PV-A', customerCode: 'A', erpPartNo: 'ERP-01', goodStockPc: 1000,
      outstanding04: 30, fgDiff04: 970, totalOrderDemand: 120, totalFgDiff: 800 },
    { partVersion: 'PV-A-V01', customerCode: 'A', erpPartNo: 'ERP-01', goodStockPc: 1000,
      outstanding04: 40, fgDiff04: 830, totalOrderDemand: 40, totalFgDiff: 700 },
  ];
  salesDelegate.findMany = async args => (args as { where: { erpPartNo?: string } }).where.erpPartNo
    ? [...summaries, { partVersion: 'PV-B', customerCode: 'B' }]
    : summaries;
  partDelegate.findMany = async () => summaries.map(row => ({ partVersion: row.partVersion, customerPartNo: 'CP-A' }));
  periodDelegate.findMany = async () => { throw new Error('摘要不應讀週期表'); };
  planDelegate.findMany = async () => { throw new Error('不含生產計畫的摘要不應讀生產計畫'); };
  const record = (id: string, date: string | null, qty: number, overrides: Record<string, unknown> = {}) => ({
    id, mrpRunId: 42, partVersion: 'PV-A', ragicRecordId: id, orderNo: `PO-${id}`,
    designatedShipDate: date ? new Date(date) : null, unshippedQty: qty,
    shipmentStatus: '未結案', salesStatus: '未結案', ...overrides,
  });
  const records = [
    record('prior', '2026-07-26T00:00:00Z', 10),
    record('week1', '2026-07-27T00:00:00Z', 20),
    record('week4-end', '2026-08-23T23:59:59.999Z', 40, { partVersion: 'PV-A-V01' }),
    record('week5', '2026-08-24T00:00:00Z', 30),
    record('future', '2026-12-08T00:00:00Z', 60),
    record('shared-other', '2026-08-01T00:00:00Z', 100, { partVersion: 'PV-B' }),
    record('no-date', null, 999),
    record('closed', '2026-08-01T00:00:00Z', 999, { salesStatus: '結案' }),
    record('shipped', '2026-08-01T00:00:00Z', 999, { shipmentStatus: '結案' }),
    record('zero', '2026-08-01T00:00:00Z', 0),
    record('wrong-run', '2026-08-01T00:00:00Z', 999, { mrpRunId: 41 }),
  ];
  orderDelegate.findMany = async args => {
    const { where } = args as { where: { mrpRunId: number; partVersion: { in: string[] };
      shipmentStatus: string; salesStatus: string; unshippedQty: { gt: number };
      designatedShipDate: { lte?: Date; not?: null } } };
    return records.filter(row => row.mrpRunId === where.mrpRunId
      && where.partVersion.in.includes(row.partVersion)
      && row.shipmentStatus === where.shipmentStatus && row.salesStatus === where.salesStatus
      && row.unshippedQty > where.unshippedQty.gt && row.designatedShipDate !== null
      && (!where.designatedShipDate.lte || row.designatedShipDate <= where.designatedShipDate.lte));
  };
  const members = encodeURIComponent(JSON.stringify(['PV-A', 'PV-A-V01']));
  for (const scope of ['recent', 'all']) {
    for (const type of ['orders', 'balance']) {
      const response = await GET(new NextRequest(
        `http://localhost/api/sales-meeting/PV-A/source-records?runId=42&type=${type}&scope=${scope}&dbSource=${currentDbMode()}&memberPartVersions=${members}`,
      ), { params: Promise.resolve({ partVersion: 'PV-A' }) });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.runId, 42);
      assert.equal(body.dbSource, currentDbMode());
      assert.equal(body.scope, scope);
      assert.equal(body.summary.goodStockPc, 1000);
      assert.equal(body.summaryBalance.demand, scope === 'recent' ? 70 : 160);
      assert.equal(body.summaryBalance.remainingStock, scope === 'recent' ? 830 : 700);
      assert.equal(body.summaryBalance.includesProductionPlans, false);
      assert.deepEqual(body.productionPlans, []);
      const expected = scope === 'recent'
        ? ['prior', 'week1', 'week4-end'] : ['prior', 'week1', 'week4-end', 'week5', 'future'];
      if (type === 'balance') expected.push('shared-other');
      assert.deepEqual(body.orders.map((row: { id: string }) => row.id), expected);
      assert.equal(body.summaryBalance.members.length, 2);
    }
  }
});

test('客戶料號來源明細彙總成員版本且不跨到同 ERP 其他客戶料號', async () => {
  runDelegate.findUnique = async () => ({ runDate: new Date('2026-07-27T00:00:00.000Z') });
  salesDelegate.findMany = async (args) => {
    const where = (args as { where?: Record<string, unknown> }).where;
    if (where?.erpPartNo === 'ERP-01') {
      return [
        { customerCode: 'SY', partVersion: 'PV-A' },
        { customerCode: 'SY', partVersion: 'PV-A-V01' },
        { customerCode: 'SM', partVersion: 'PV-OTHER' },
      ];
    }
    return [
      {
        mrpRunId: 42,
        partVersion: 'PV-A',
        customerCode: 'SY',
        erpPartNo: 'ERP-01',
        goodStockPc: 600,
        goodStockKg: 6,
        wfgStockPc: 400,
        ye1StockPc: 200,
      },
      {
        mrpRunId: 42,
        partVersion: 'PV-A-V01',
        customerCode: 'SY',
        erpPartNo: 'ERP-01',
        goodStockPc: 600,
        goodStockKg: 6,
        wfgStockPc: 400,
        ye1StockPc: 200,
      },
    ];
  };
  partDelegate.findMany = async () => [
    { partVersion: 'PV-A', customerPartNo: 'CP-A' },
    { partVersion: 'PV-A-V01', customerPartNo: 'CP-A' },
  ];
  periodDelegate.findMany = async () => [
    {
      id: 1,
      mrpRunId: 42,
      partVersion: 'PV-A',
      weekIndex: 1,
      weekLabel: 'W01',
      weekStart: new Date('2026-07-27T00:00:00.000Z'),
      demand: 100,
      supply: 50,
      remainingStock: 500,
    },
    {
      id: 2,
      mrpRunId: 42,
      partVersion: 'PV-A-V01',
      weekIndex: 1,
      weekLabel: 'W01',
      weekStart: new Date('2026-07-27T00:00:00.000Z'),
      demand: 200,
      supply: 0,
      remainingStock: 450,
    },
  ];
  const orderQueries: Array<Record<string, unknown>> = [];
  orderDelegate.findMany = async (args) => {
    orderQueries.push(args as Record<string, unknown>);
    return [];
  };
  planDelegate.findMany = async () => [];

  const members = encodeURIComponent(JSON.stringify(['PV-A', 'PV-A-V01']));
  const response = await GET(
    new NextRequest(
      `http://localhost/api/sales-meeting/PV-A/source-records?runId=42&type=orders&weekIndex=1&memberPartVersions=${members}`,
    ),
    { params: Promise.resolve({ partVersion: 'PV-A' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.customerPartNo, 'CP-A');
  assert.deepEqual(body.memberPartVersions, ['PV-A', 'PV-A-V01']);
  assert.equal(body.period.demand, 300);
  assert.equal(body.period.remainingStock, 450);
  assert.deepEqual(
    (orderQueries[0].where as { partVersion: unknown }).partVersion,
    { in: ['PV-A', 'PV-A-V01'] },
  );
});

test('產銷 batch periods 固定使用指定 Run 與 DB source 並彙總成員版本', async () => {
  const mode = currentDbMode();
  runDelegate.findUnique = async () => ({ id: 42 });
  salesDelegate.findMany = async () => [
    { partVersion: 'PV-A', customerCode: 'SY', erpPartNo: 'ERP-01' },
    { partVersion: 'PV-A-V01', customerCode: 'SY', erpPartNo: 'ERP-01' },
  ];
  partDelegate.findMany = async () => [
    { partVersion: 'PV-A', customerPartNo: 'CP-A' },
    { partVersion: 'PV-A-V01', customerPartNo: 'CP-A' },
  ];
  periodDelegate.findMany = async () => [
    {
      id: 1,
      mrpRunId: 42,
      partVersion: 'PV-A',
      weekIndex: 1,
      weekLabel: 'W01',
      weekStart: new Date('2026-07-27T00:00:00.000Z'),
      demand: 100,
      supply: 50,
      remainingStock: 500,
    },
    {
      id: 2,
      mrpRunId: 42,
      partVersion: 'PV-A-V01',
      weekIndex: 1,
      weekLabel: 'W01',
      weekStart: new Date('2026-07-27T00:00:00.000Z'),
      demand: 200,
      supply: 0,
      remainingStock: 450,
    },
  ];

  const response = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/sales-meeting/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 42,
        dbSource: mode,
        groups: [{
          partVersion: 'PV-A',
          memberPartVersions: ['PV-A', 'PV-A-V01'],
        }],
      }),
    },
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.runId, 42);
  assert.equal(body.dbSource, mode);
  assert.equal(body.periods['PV-A'][0].demand, 300);
  assert.equal(body.periods['PV-A'][0].remainingStock, 450);
});

test('產銷 batch periods 拒絕無效 Run 與 DB source', async () => {
  const invalidSource = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/sales-meeting/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 42,
        dbSource: 'invalid',
        groups: [{ partVersion: 'PV-A', memberPartVersions: ['PV-A'] }],
      }),
    },
  ));
  assert.equal(invalidSource.status, 400);

  const invalidRun = await batchPeriodsPOST(new NextRequest(
    'http://localhost/api/sales-meeting/batch-periods',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'bad',
        groups: [{ partVersion: 'PV-A', memberPartVersions: ['PV-A'] }],
      }),
    },
  ));
  assert.equal(invalidRun.status, 400);
});
