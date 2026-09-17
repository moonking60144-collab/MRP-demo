import { NextResponse } from 'next/server';
import { forceResetRuns } from '@/lib/mrp/run-orchestrator';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

/**
 * POST /api/runs/reset — Clear orphaned runs and ask local workers to stop.
 * A local attempt keeps its lock until the worker actually settles.
 */
export async function POST() {
  try {
    await ensureRunLifecycle();
    const { cleared, runningLocalRunIds } = await forceResetRuns();
    if (runningLocalRunIds.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          cleared,
          runningLocalRunIds,
          error: `MRP run #${runningLocalRunIds.join(', #')} 仍有 worker 執行中，已送出停止要求；為避免新舊計算交錯，尚未釋放該 run。`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      cleared,
      message: cleared > 0
        ? `Cleared ${cleared} stuck run(s). You can now start a new MRP run.`
        : 'No stuck runs found. System is ready.',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
