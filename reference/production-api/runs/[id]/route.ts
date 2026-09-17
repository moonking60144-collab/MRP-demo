import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { MRP_RUN_STATUS } from '@/lib/mrp/run-status';
import { deleteErrorRunSnapshot } from '@/lib/mrp/run-retention';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

/**
 * GET /api/runs/:id — Get a single MRP run with details
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureRunLifecycle();
    const { id } = await params;
    const run = await prisma.mrpRun.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/runs/:id — Delete an MRP run with status 'error'
 * Cascades to all related staging and output data.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureRunLifecycle();
    const { id } = await params;
    const runId = parseInt(id, 10);

    const run = await prisma.mrpRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    if (run.status !== MRP_RUN_STATUS.ERROR) {
      return NextResponse.json(
        { error: 'Only runs with error status can be deleted' },
        { status: 400 },
      );
    }
    if (run.isLatest) {
      return NextResponse.json(
        { error: 'Cannot delete the latest run' },
        { status: 400 },
      );
    }

    const deleted = await deleteErrorRunSnapshot(runId);
    if (!deleted) {
      return NextResponse.json(
        { error: 'Run changed while deleting; refresh and try again' },
        { status: 409 },
      );
    }

    return NextResponse.json({ message: `Run ${run.versionCode} deleted` });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
