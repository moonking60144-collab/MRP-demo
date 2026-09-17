import { NextRequest, NextResponse } from 'next/server';
import { sendRunSignal } from '@/lib/sync/sync-engine';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

/**
 * POST /api/runs/:id/signal — Send stop/pause/resume signal to a running MRP run
 * Body: { "action": "stop" | "pause" | "resume" }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureRunLifecycle();
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (isNaN(runId)) {
      return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (!['stop', 'pause', 'resume'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be: stop, pause, or resume' },
        { status: 400 },
      );
    }

    sendRunSignal(runId, action as 'stop' | 'pause' | 'resume');

    return NextResponse.json({ ok: true, runId, action });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
