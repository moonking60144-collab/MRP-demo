import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { selectRunLogDelta } from '@/lib/run-progress-contract';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureRunLifecycle();
    const { id } = await params;
    const runId = Number.parseInt(id, 10);
    const afterLogSeq = Number.parseInt(req.nextUrl.searchParams.get('afterLogSeq') || '0', 10);
    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
    }

    const run = await prisma.mrpRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        versionCode: true,
        status: true,
        createdAt: true,
        completedAt: true,
        stepStatus: true,
        syncCounts: true,
        errorMessage: true,
        logs: true,
      },
    });

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const logDelta = selectRunLogDelta(run.logs, afterLogSeq);
    return NextResponse.json({
      run: {
        id: run.id,
        versionCode: run.versionCode,
        status: run.status,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        stepStatus: run.stepStatus,
        syncCounts: run.syncCounts,
        errorMessage: run.errorMessage,
      },
      logs: logDelta.logs,
      logCursor: logDelta.nextSeq,
      logsReset: logDelta.reset,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
