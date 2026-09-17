/**
 * Server-lifecycle self-heal for MRP runs.
 *
 * Problem: PM2 reload (or any process restart) sends SIGTERM/SIGINT to Node,
 * which kills any in-flight Ragic fetches mid-call. The mrp_run row stays in
 * 'syncing' / 'calculating' forever and the UI shows a "hung" run that the
 * user can't make sense of. Since that active mrp_run row IS the concurrency
 * lock, leaving it active also blocks every subsequent run.
 *
 * This module installs:
 *
 *   1. **Startup self-heal** — at module load, finds runs in active states
 *      (status = syncing/calculating/pending/synced) and marks them as 'error'
 *      with a clear message. Their createdAt is older than the current process
 *      start, so they couldn't possibly belong to this process. Idempotent and
 *      cheap (~1 query).
 *
 *   2. **Graceful-shutdown handlers** — on SIGTERM / SIGINT, mark active runs
 *      as 'error' (best-effort, ~100ms) before exiting. Gives the operator's
 *      deploy script a clean slate.
 *
 * Explicitly activated by runtime run endpoints. It must not be imported as a
 * db.ts side effect because Next.js build workers also import server modules;
 * their SIGINT must never mutate production run state.
 */
import prisma from './db';
import { ACTIVE_STATUSES, MRP_RUN_STATUS, STOP_REASON } from './mrp/run-status';

/** Process-wide guard so handlers register and self-heal runs EXACTLY once
 *  per Node process — even when Next.js dev-server's HMR re-evaluates this
 *  module. Without `globalThis`, every HMR cycle would re-fire the startup
 *  self-heal and falsely mark any user-initiated MRP run as "orphaned" within
 *  seconds of starting. */
const G = globalThis as unknown as {
  __mrpShutdownInstalled?: boolean;
  __mrpStartupHeal?: Promise<void>;
};

async function markRunsAsInterrupted(reason: string): Promise<number> {
  try {
    const result = await prisma.mrpRun.updateMany({
      where: { status: { in: ACTIVE_STATUSES } },
      data: {
        status: MRP_RUN_STATUS.ERROR,
        errorMessage: reason,
        completedAt: new Date(),
      },
    });
    if (result.count > 0) {
      console.warn(`[shutdown-handler] Marked ${result.count} active run(s) as error: "${reason}"`);
    }
    return result.count;
  } catch (err) {
    console.error('[shutdown-handler] Failed to mark active runs as interrupted:', err);
    return 0;
  }
}

/**
 * Run once at boot. Any run that's still 'syncing'/'calculating' was started
 * by a previous process (this process just booted) and is therefore orphaned.
 */
async function startupSelfHeal(): Promise<void> {
  await markRunsAsInterrupted(STOP_REASON.STARTUP_ORPHANED);
}

/**
 * Run on SIGTERM/SIGINT. Best-effort cleanup — we have ~1.6s before SIGKILL
 * if running under PM2 with default kill_timeout. Increase `kill_timeout` in
 * ecosystem.config.js to e.g. 5000 to give us more headroom.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.warn(`[shutdown-handler] Received ${signal} — marking active runs as interrupted before exit`);
  await markRunsAsInterrupted(STOP_REASON.SHUTDOWN_SIGNAL(signal));
  // Give logs a chance to flush, then exit. We don't await prisma.$disconnect
  // because we're in shutdown — the OS will reap the connection.
  process.exit(0);
}

export async function ensureRunLifecycle(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;

  if (!G.__mrpShutdownInstalled) {
    G.__mrpShutdownInstalled = true;
    process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
  }

  if (!G.__mrpStartupHeal) {
    G.__mrpStartupHeal = startupSelfHeal();
  }
  await G.__mrpStartupHeal;
}
