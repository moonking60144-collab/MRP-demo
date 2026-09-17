import prisma from '@/lib/db';
import { recoverStaleWorkOrderGenerations } from '@/lib/mrp/work-order-generation';
import { scheduleWorkOrderGenerationQueue } from '@/lib/mrp/work-order-generation-queue';
import { onWorkOrderStatus } from '@/lib/mrp/work-order-events';
import { WORK_ORDER_STATUS, type WorkOrderStatusEvent } from '@/lib/work-order-state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  await recoverStaleWorkOrderGenerations(prisma, {});
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      let syncing = true;
      const buffered = new Map<number, WorkOrderStatusEvent>();
      unsubscribe = onWorkOrderStatus((event) => {
        if (syncing) {
          buffered.set(event.transferId, event);
          return;
        }
        send({ type: 'work-order-status', ...event });
      });

      const active = await prisma.productionPlanTransfer.findMany({
        where: {
          workOrderStatus: { not: WORK_ORDER_STATUS.IDLE },
        },
        select: {
          id: true,
          workOrderStatus: true,
          workOrderError: true,
          workOrderStartedAt: true,
          workOrderCompletedAt: true,
        },
      });
      const statuses: WorkOrderStatusEvent[] = active.map((transfer) => ({
        transferId: transfer.id,
        workOrderStatus: transfer.workOrderStatus as WorkOrderStatusEvent['workOrderStatus'],
        workOrderError: transfer.workOrderError,
        workOrderStartedAt: transfer.workOrderStartedAt?.toISOString() ?? null,
        workOrderCompletedAt: transfer.workOrderCompletedAt?.toISOString() ?? null,
      }));
      send({ type: 'sync', statuses });
      syncing = false;
      for (const event of buffered.values()) {
        send({ type: 'work-order-status', ...event });
      }
      buffered.clear();
      scheduleWorkOrderGenerationQueue();

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ka\n\n'));
        } catch {
          cleanup();
        }
      }, 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
