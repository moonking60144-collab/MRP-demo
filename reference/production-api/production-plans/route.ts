import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { recoverStaleWorkOrderGenerations } from '@/lib/mrp/work-order-generation';
import { scheduleWorkOrderGenerationQueue } from '@/lib/mrp/work-order-generation-queue';

/**
 * GET /api/production-plans — List production plan transfers
 * Query params:
 *   runId?: filter by specific MRP run (defaults to all)
 */
export async function GET(req: NextRequest) {
  try {
    const runIdParam = req.nextUrl.searchParams.get('runId');
    const where = runIdParam ? { mrpRunId: parseInt(runIdParam, 10) } : {};

    await recoverStaleWorkOrderGenerations(prisma, where);
    scheduleWorkOrderGenerationQueue();

    const transfers = await prisma.productionPlanTransfer.findMany({
      where,
      orderBy: { transferredAt: 'desc' },
      select: {
        id: true,
        mrpRunId: true,
        mrpVersionCode: true,
        partVersion: true,
        planSequence: true,
        customerCode: true,
        suggestedQty: true,
        completionDate: true,
        ragicRecordId: true,
        ragicPlanNo: true,
        ragicUrl: true,
        transferredAt: true,
        transferredBy: true,
        workOrderStatus: true,
        workOrderError: true,
        workOrderStartedAt: true,
        workOrderCompletedAt: true,
      },
    });

    return NextResponse.json({ transfers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
