import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { RunCalculationInputs } from './run-calculation-inputs';
import prisma from '../db';
import { calculateSalesMeeting } from './sales-meeting-engine';

const salesMeetingDelegate = prisma.salesMeeting as unknown as {
  deleteMany: (args: unknown) => Promise<unknown>;
  createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
};
const periodDelegate = prisma.salesMeetingPeriod as unknown as {
  deleteMany: (args: unknown) => Promise<unknown>;
  createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
};
const progressClient = prisma as unknown as {
  $executeRaw: (...args: unknown[]) => Promise<unknown>;
};

const originalDeleteSales = salesMeetingDelegate.deleteMany;
const originalCreateSales = salesMeetingDelegate.createMany;
const originalDeletePeriods = periodDelegate.deleteMany;
const originalCreatePeriods = periodDelegate.createMany;
const originalExecuteRaw = progressClient.$executeRaw;

afterEach(() => {
  salesMeetingDelegate.deleteMany = originalDeleteSales;
  salesMeetingDelegate.createMany = originalCreateSales;
  periodDelegate.deleteMany = originalDeletePeriods;
  periodDelegate.createMany = originalCreatePeriods;
  progressClient.$executeRaw = originalExecuteRaw;
});

test('產銷摘要保留客戶代碼與 HD1、YE1 Run 快照', async () => {
  const summaries: Array<Record<string, unknown>> = [];
  salesMeetingDelegate.deleteMany = async () => ({ count: 0 });
  periodDelegate.deleteMany = async () => ({ count: 0 });
  salesMeetingDelegate.createMany = async ({ data }) => {
    summaries.push(...data);
    return { count: data.length };
  };
  periodDelegate.createMany = async ({ data }) => ({ count: data.length });
  progressClient.$executeRaw = async () => 1;

  const inputs = {
    runDate: new Date('2026-07-27T00:00:00.000Z'),
    partVersionRows: [{
      partVersion: 'PV-SY-01',
      erpPartNo: 'ERP-01',
      customerCode: 'SY',
      unit: 'pc',
    }],
    inventoryRows: [{
      erpPartNo: 'ERP-01',
      goodStockPc: 600,
      goodStockKg: 6,
      inStockPc: 600,
      inStockKg: 6,
      wfgStockPc: 400,
      ye1StockPc: 200,
      badStockPc: 10,
      badStockKg: 0.1,
      unit: 'pc',
      purchaseLeadWeeks: 8,
    }],
    orderRows: [],
    forecastRows: [],
    workOrderRows: [],
    workOrderBomRows: [],
    productionPlanRows: [],
    purchaseOrderRows: [],
  } as unknown as RunCalculationInputs;

  const result = await calculateSalesMeeting(42, inputs);

  assert.equal(result.partCount, 1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.customerCode, 'SY');
  assert.equal(summaries[0]?.wfgStockPc, 400);
  assert.equal(summaries[0]?.ye1StockPc, 200);
  assert.equal(summaries[0]?.goodStockPc, 600);
});
