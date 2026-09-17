import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import {
  enqueueWorkOrderGeneration,
  generateWorkOrders,
} from '@/lib/mrp/work-order-generation';
import { scheduleWorkOrderGenerationQueue } from '@/lib/mrp/work-order-generation-queue';
import { emitWorkOrderStatus } from '@/lib/mrp/work-order-events';
import { WORK_ORDER_STATUS, WorkOrderStateConflictError } from '@/lib/work-order-state';

function parseTransferId(rawTransferId: string): number | null {
  const transferId = Number(rawTransferId);
  return Number.isInteger(transferId) && transferId > 0 ? transferId : null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ transferId: string }> },
) {
  try {
    const { transferId: rawTransferId } = await params;
    const transferId = parseTransferId(rawTransferId);
    if (!transferId) {
      return NextResponse.json({ error: '無效的生產計畫轉單 ID。' }, { status: 400 });
    }
    const transfer = await prisma.productionPlanTransfer.findUnique({
      where: { id: transferId },
      select: {
        id: true,
        workOrderStatus: true,
        workOrderError: true,
        workOrderStartedAt: true,
        workOrderCompletedAt: true,
      },
    });
    if (!transfer) {
      return NextResponse.json({ error: '找不到生產計畫轉單紀錄。' }, { status: 404 });
    }
    return NextResponse.json({
      transferId: transfer.id,
      workOrderStatus: transfer.workOrderStatus,
      workOrderError: transfer.workOrderError,
      workOrderStartedAt: transfer.workOrderStartedAt,
      workOrderCompletedAt: transfer.workOrderCompletedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '讀取工令產生狀態失敗。' },
      { status: 500 },
    );
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ transferId: string }> },
) {
  try {
    const { transferId: rawTransferId } = await params;
    const transferId = parseTransferId(rawTransferId);
    if (!transferId) {
      return NextResponse.json({ error: '無效的生產計畫轉單 ID。' }, { status: 400 });
    }

    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json({ error: '找不到 MRP 執行版本。' }, { status: 404 });
    }

    const transfer = await prisma.productionPlanTransfer.findUnique({
      where: { id: transferId },
      select: { workOrderStatus: true },
    });
    if (transfer?.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN) {
      const result = await generateWorkOrders(transferId, latest.id);
      emitWorkOrderStatus({
        transferId,
        workOrderStatus: result.workOrderStatus,
        workOrderError: null,
        workOrderStartedAt: null,
        workOrderCompletedAt: result.workOrderCompletedAt?.toISOString() ?? null,
      });
      return NextResponse.json(result);
    }

    const result = await enqueueWorkOrderGeneration(transferId, latest.id);
    if (result.workOrderStatus === WORK_ORDER_STATUS.QUEUED) {
      scheduleWorkOrderGenerationQueue();
    }
    return NextResponse.json(result, {
      status: result.workOrderStatus === WORK_ORDER_STATUS.QUEUED ? 202 : 200,
    });
  } catch (err) {
    if (err instanceof WorkOrderStateConflictError) {
      return NextResponse.json(
        { error: err.message, workOrderStatus: err.workOrderStatus },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '產生工令單失敗。' },
      { status: 500 },
    );
  }
}
