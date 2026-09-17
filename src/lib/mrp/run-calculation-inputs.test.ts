import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { StagingInventory } from '@prisma/client';
import prisma from '../db';
import { getRunInventoryRows, loadRunCalculationInputs } from './run-calculation-inputs';

const row = { id: 1, mrpRunId: 28, erpPartNo: 'ERP-001' } as StagingInventory;
const inputs = {
  runDate: new Date('2026-07-27T00:00:00.000Z'),
  orderDemandContractVersion: 'order-demand-v2-manual-close' as const,
  partVersionRows: [],
  inventoryRows: [row],
  orderRows: [],
  forecastRows: [],
  workOrderRows: [],
  workOrderBomRows: [],
  productionPlanRows: [],
  purchaseOrderRows: [],
};

type FindManyDelegate = {
  findMany: (args: unknown) => Promise<unknown[]>;
};
type FindUniqueDelegate = {
  findUnique: (args: unknown) => Promise<{
    runDate: Date;
    orderDemandContractVersion: string;
  } | null>;
};

const runDelegate = prisma.mrpRun as unknown as FindUniqueDelegate;
const rowDelegates = [
  prisma.stagingPartVersion,
  prisma.stagingInventory,
  prisma.stagingOrder,
  prisma.stagingForecast,
  prisma.stagingWorkOrder,
  prisma.stagingWorkOrderBom,
  prisma.stagingProductionPlan,
  prisma.stagingPurchaseOrder,
] as unknown as FindManyDelegate[];
const originalFindUnique = runDelegate.findUnique;
const originalFindMany = rowDelegates.map((delegate) => delegate.findMany);

afterEach(() => {
  runDelegate.findUnique = originalFindUnique;
  rowDelegates.forEach((delegate, index) => {
    delegate.findMany = originalFindMany[index];
  });
});

test('計算輸入的八張 staging 表並行讀取', async () => {
  let started = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadRow = async () => {
    started++;
    if (started === rowDelegates.length) release();
    await gate;
    return [];
  };

  runDelegate.findUnique = async () => ({
    runDate: new Date('2026-07-27T00:00:00.000Z'),
    orderDemandContractVersion: 'order-demand-v2-manual-close',
  });
  rowDelegates.forEach((delegate) => {
    delegate.findMany = loadRow;
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const loaded = await Promise.race([
      loadRunCalculationInputs(29),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('staging loaders did not start in parallel')),
          1_000,
        );
      }),
    ]);

    assert.equal(started, rowDelegates.length);
    assert.equal(loaded.runDate.toISOString(), '2026-07-27T00:00:00.000Z');
    assert.equal(loaded.orderDemandContractVersion, 'order-demand-v2-manual-close');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

test('計算引擎有共用快照時不再重讀 staging inventory', async () => {
  let calls = 0;
  const rows = await getRunInventoryRows(
    28,
    inputs,
    async () => {
      calls++;
      return [];
    },
  );

  assert.equal(calls, 0);
  assert.equal(rows[0], row);
});

test('獨立執行 engine 時保留 staging inventory fallback', async () => {
  let receivedRunId: number | null = null;
  const rows = await getRunInventoryRows(31, undefined, async (runId) => {
    receivedRunId = runId;
    return [row];
  });

  assert.equal(receivedRunId, 31);
  assert.equal(rows[0], row);
});
