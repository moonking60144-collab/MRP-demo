import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { resumeMrpRun, getActiveRun, clearStaleRuns } from '@/lib/mrp/run-orchestrator';
import { isDeploying } from '@/lib/deploy-status';
import { MRP_RUN_STATUS } from '@/lib/mrp/run-status';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';
import { RagicPreflightError, requireRagicPreflight } from '@/lib/ragic-health';
import {
  DatabasePreflightError,
  requireDatabasePreflight,
} from '@/lib/db-health-server';

/**
 * POST /api/runs/:id/resume — Resume an interrupted run from where it left off.
 *
 * Reuses the same mrp_run record. Sync steps already marked 'done' are skipped;
 * the rest are retried from a clean slate (their staging rows are wiped first).
 * Calc phases re-run from scratch.
 *
 * Allowed states: error, stopped, syncing/calculating (treated as orphaned).
 * Forbidden: completed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (Number.isNaN(runId)) {
      return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
    }

    if (await isDeploying()) {
      return NextResponse.json(
        { updating: true, retryAfterSeconds: 10 },
        { status: 423 },
      );
    }

    await requireDatabasePreflight();
    await ensureRunLifecycle();

    await clearStaleRuns();

    const active = await getActiveRun();
    if (active && active.id !== runId) {
      return NextResponse.json(
        { error: 'Another MRP run is already in progress', activeRunId: active.id },
        { status: 409 },
      );
    }

    const run = await prisma.mrpRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    if (run.status === MRP_RUN_STATUS.COMPLETED) {
      return NextResponse.json(
        { error: `Run #${runId} is already completed` },
        { status: 400 },
      );
    }

    await requireRagicPreflight();

    const body = await req.json().catch(() => ({}));
    const createdBy = body.createdBy || 'web-user';

    const runPromise = resumeMrpRun(runId, createdBy);

    const result = await Promise.race([
      runPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);

    if (result && result.status === MRP_RUN_STATUS.ERROR) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    if (result) {
      return NextResponse.json(result);
    }

    return NextResponse.json({
      runId,
      versionCode: run.versionCode,
      status: MRP_RUN_STATUS.SYNCING,
      resumed: true,
      message: `Resuming run #${runId}. Poll GET /api/runs/${runId} for progress.`,
    });
  } catch (err) {
    if (err instanceof DatabasePreflightError) {
      return NextResponse.json(
        {
          code: 'DATABASE_SCHEMA_INCOMPLETE',
          error: `${err.message} MRP 未繼續執行。`,
          dbHealth: err.health,
        },
        { status: 503 },
      );
    }
    if (err instanceof RagicPreflightError) {
      return NextResponse.json(
        { error: err.message, ragicHealth: err.health },
        { status: 503 },
      );
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('already in progress')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
