import { NextRequest, NextResponse } from 'next/server';
import {
  clearStaleRuns,
  executeMrpRun,
  getActiveRun,
  listRunDetails,
  listRuns,
} from '@/lib/mrp/run-orchestrator';
import { isDeploying } from '@/lib/deploy-status';
import { MRP_RUN_STATUS } from '@/lib/mrp/run-status';
import { setApplySkipFgInventory } from '@/lib/app-settings';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';
import { scheduleWorkOrderGenerationQueue } from '@/lib/mrp/work-order-generation-queue';
import { RagicPreflightError, requireRagicPreflight } from '@/lib/ragic-health';
import {
  DatabasePreflightError,
  requireDatabasePreflight,
} from '@/lib/db-health-server';

/**
 * GET /api/runs — summary list by default
 * GET /api/runs?includeDetails=1 — legacy full-list compatibility
 */
export async function GET(request: NextRequest) {
  try {
    await ensureRunLifecycle();
    scheduleWorkOrderGenerationQueue();
    const includeDetails = request.nextUrl.searchParams.get('includeDetails') === '1';
    const runs = includeDetails ? await listRunDetails() : await listRuns();
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/runs — Start a new MRP run
 * The run executes in the background. Client should poll GET /api/runs/:id for progress.
 */
export async function POST(req: NextRequest) {
  try {
    // Block new runs while deploy.sh is mid-build, so we don't start a sync
    // that pm2 reload is about to SIGINT. Dashboard handles 423 with a banner
    // and auto-retries when the deploy finishes.
    if (await isDeploying()) {
      return NextResponse.json(
        { updating: true, retryAfterSeconds: 10 },
        { status: 423 },
      );
    }

    await requireDatabasePreflight();
    await ensureRunLifecycle();

    // Auto-cleanup: 把卡在 active 狀態過久的 run 標為 stale（門檻見 clearStaleRuns）
    await clearStaleRuns();

    // Check if a run is already active
    const active = await getActiveRun();
    if (active) {
      return NextResponse.json(
        { error: 'Another MRP run is already in progress', activeRunId: active.id },
        { status: 409 },
      );
    }

    await requireRagicPreflight();

    const body = await req.json().catch(() => ({}));
    const createdBy = body.createdBy || 'web-user';

    // 「不計算成品庫存」開關 —— 仿照 Ragic 預設不歸零;勾選才把該設定料件庫存當 0。
    // 存進 app_settings,計算階段的 fg-monthly engine 讀取套用。
    await setApplySkipFgInventory(body.applySkipFgInventory === true);

    // Fire and forget — run in background
    const runPromise = executeMrpRun(createdBy);

    // Give it a moment to create the run record and start syncing
    // so we can return the runId to the client
    const result = await Promise.race([
      runPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);

    if (result && result.status === MRP_RUN_STATUS.ERROR) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    if (result) {
      // Completed very quickly (unlikely but possible)
      return NextResponse.json(result);
    }

    // Run is still going — find the newly created run record
    const newRun = await getActiveRun();
    if (newRun) {
      return NextResponse.json({
        runId: newRun.id,
        versionCode: newRun.versionCode,
        status: newRun.status,
        message: 'MRP run started. Poll GET /api/runs/' + newRun.id + ' for progress.',
      });
    }

    // Fallback: couldn't find the run, but it was started
    // Wait for it to complete (original blocking behavior)
    const finalResult = await runPromise;
    return NextResponse.json(finalResult);
  } catch (err) {
    if (err instanceof DatabasePreflightError) {
      return NextResponse.json(
        {
          code: 'DATABASE_SCHEMA_INCOMPLETE',
          error: `${err.message} MRP 未開始執行。`,
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
