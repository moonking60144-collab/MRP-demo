import prisma from '@/lib/db';
import { generateWorkOrders } from '@/lib/mrp/work-order-generation';
import { emitWorkOrderStatus } from '@/lib/mrp/work-order-events';
import { WORK_ORDER_STATUS, type WorkOrderStatusEvent } from '@/lib/work-order-state';

interface QueueDeps {
  client?: typeof prisma;
  generate?: typeof generateWorkOrders;
}

const queueState = globalThis as unknown as {
  __fundaWorkOrderQueueRunning?: boolean;
  __fundaWorkOrderQueueScheduled?: boolean;
  __fundaWorkOrderQueueRequested?: boolean;
};

function toStatusEvent(transfer: {
  id: number;
  workOrderStatus: string;
  workOrderError: string | null;
  workOrderStartedAt: Date | null;
  workOrderCompletedAt: Date | null;
}): WorkOrderStatusEvent {
  return {
    transferId: transfer.id,
    workOrderStatus: transfer.workOrderStatus as WorkOrderStatusEvent['workOrderStatus'],
    workOrderError: transfer.workOrderError,
    workOrderStartedAt: transfer.workOrderStartedAt?.toISOString() ?? null,
    workOrderCompletedAt: transfer.workOrderCompletedAt?.toISOString() ?? null,
  };
}

export async function drainWorkOrderGenerationQueue(deps: QueueDeps = {}): Promise<number> {
  const client = deps.client ?? prisma;
  const generate = deps.generate ?? generateWorkOrders;
  let processed = 0;

  while (true) {
    const next = await client.productionPlanTransfer.findFirst({
      where: {
        workOrderStatus: WORK_ORDER_STATUS.QUEUED,
        mrpRunId: { not: null },
      },
      orderBy: [{ workOrderStartedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, mrpRunId: true },
    });
    if (!next) return processed;
    if (next.mrpRunId === null) return processed;

    try {
      await generate(next.id, next.mrpRunId, { client });
    } catch (error) {
      console.error(`[工令佇列] transfer ${next.id}:`, error);
    }

    const current = await client.productionPlanTransfer.findUnique({
      where: { id: next.id },
      select: {
        id: true,
        workOrderStatus: true,
        workOrderError: true,
        workOrderStartedAt: true,
        workOrderCompletedAt: true,
      },
    });
    if (!current) continue;
    emitWorkOrderStatus(toStatusEvent(current));
    processed += 1;

    if (current.workOrderStatus === WORK_ORDER_STATUS.QUEUED) {
      console.error(`[工令佇列] transfer ${next.id} 未能離開 queued，停止本輪避免重複執行。`);
      return processed;
    }
  }
}

export function scheduleWorkOrderGenerationQueue(): void {
  if (queueState.__fundaWorkOrderQueueRunning) {
    queueState.__fundaWorkOrderQueueRequested = true;
    return;
  }
  if (queueState.__fundaWorkOrderQueueScheduled) return;
  queueState.__fundaWorkOrderQueueScheduled = true;
  setTimeout(() => {
    queueState.__fundaWorkOrderQueueScheduled = false;
    if (queueState.__fundaWorkOrderQueueRunning) return;
    queueState.__fundaWorkOrderQueueRunning = true;
    void drainWorkOrderGenerationQueue()
      .catch((error) => console.error('[工令佇列] 背景執行失敗:', error))
      .finally(() => {
        queueState.__fundaWorkOrderQueueRunning = false;
        if (queueState.__fundaWorkOrderQueueRequested) {
          queueState.__fundaWorkOrderQueueRequested = false;
          scheduleWorkOrderGenerationQueue();
        }
      });
  }, 0);
}
