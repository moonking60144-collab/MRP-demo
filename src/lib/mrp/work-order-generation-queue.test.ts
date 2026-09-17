import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { WORK_ORDER_STATUS } from '@/lib/work-order-state';
import { drainWorkOrderGenerationQueue } from './work-order-generation-queue';

interface QueueTransfer {
  id: number;
  mrpRunId: number | null;
  workOrderStatus: string;
  workOrderError: string | null;
  workOrderStartedAt: Date;
  workOrderCompletedAt: Date | null;
}

test('背景工令佇列依排隊順序逐筆執行，不會同時觸發兩個 Button 92', async () => {
  const transfers: QueueTransfer[] = [
    { id: 12, mrpRunId: 7, workOrderStatus: WORK_ORDER_STATUS.QUEUED, workOrderError: null, workOrderStartedAt: new Date('2026-07-17T08:00:02Z'), workOrderCompletedAt: null },
    { id: 10, mrpRunId: 7, workOrderStatus: WORK_ORDER_STATUS.QUEUED, workOrderError: null, workOrderStartedAt: new Date('2026-07-17T08:00:01Z'), workOrderCompletedAt: null },
  ];
  const executionOrder: number[] = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    productionPlanTransfer: {
      findFirst: async () => transfers
        .filter((item) => item.workOrderStatus === WORK_ORDER_STATUS.QUEUED)
        .sort((a, b) => a.workOrderStartedAt.getTime() - b.workOrderStartedAt.getTime() || a.id - b.id)[0] ?? null,
      findUnique: async ({ where }: { where: { id: number } }) => (
        transfers.find((item) => item.id === where.id) ?? null
      ),
    },
  } as unknown as PrismaClient;

  const processed = await drainWorkOrderGenerationQueue({
    client,
    generate: async (transferId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      executionOrder.push(transferId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const transfer = transfers.find((item) => item.id === transferId)!;
      transfer.workOrderStatus = WORK_ORDER_STATUS.SUCCEEDED;
      transfer.workOrderCompletedAt = new Date('2026-07-17T08:01:00Z');
      active -= 1;
      return {
        transferId,
        workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
        workOrderCompletedAt: transfer.workOrderCompletedAt,
        alreadyGenerated: false,
        ragicUrl: null,
      };
    },
  });

  assert.equal(processed, 2);
  assert.deepEqual(executionOrder, [10, 12]);
  assert.equal(maxActive, 1);
});

test('背景工令佇列不處理已解除 Run 關聯的稽核紀錄', async () => {
  const whereCalls: unknown[] = [];
  let generated = false;
  const client = {
    productionPlanTransfer: {
      findFirst: async ({ where }: { where: unknown }) => {
        whereCalls.push(where);
        return null;
      },
    },
  } as unknown as PrismaClient;

  const processed = await drainWorkOrderGenerationQueue({
    client,
    generate: async () => {
      generated = true;
      throw new Error('不應執行');
    },
  });

  assert.equal(processed, 0);
  assert.equal(generated, false);
  assert.deepEqual(whereCalls, [{
    workOrderStatus: WORK_ORDER_STATUS.QUEUED,
    mrpRunId: { not: null },
  }]);
});
