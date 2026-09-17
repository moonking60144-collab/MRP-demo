import { NextResponse } from 'next/server';
import { getActiveRun } from '@/lib/mrp/run-orchestrator';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

/**
 * GET /api/runs/active — lightweight check for deploy scripts.
 *
 * Returns `{ active: true, runId, versionCode, status }` if any run is
 * currently in syncing/calculating/pending/synced state, otherwise
 * `{ active: false }`.
 *
 * Intended for autodeploy / pm2 reload guards:
 *
 *   if curl -sf http://localhost:3000/api/runs/active | grep -q '"active":true'; then
 *     echo "MRP run in progress — skipping reload"; exit 0
 *   fi
 *
 * See README "Deploy safety" section.
 */
export async function GET() {
  try {
    await ensureRunLifecycle();
    const run = await getActiveRun();
    if (!run) return NextResponse.json({ active: false });
    return NextResponse.json({
      active: true,
      runId: run.id,
      versionCode: run.versionCode,
      status: run.status,
      startedAt: run.createdAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
