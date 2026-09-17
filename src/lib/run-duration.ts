/**
 * Active execution time across one or more attempts at a run.
 *
 * Wall-clock from `created_at` to `completed_at` overstates the duration
 * for any run that was interrupted and later resumed — the gap between
 * attempts is idle time, not "running" time.
 *
 * The orchestrator stamps `step_status._totalActiveMs` after each pipeline
 * attempt (see executePipeline in run-orchestrator.ts). When present, that's
 * the truth. We fall back to wall-clock for runs from before that field
 * existed so the column never shows blank.
 */
export function activeRunDurationSec(run: {
  stepStatus?: Record<string, unknown> | null;
  createdAt?: string | Date | null;
  completedAt?: string | Date | null;
}): number | null {
  const totalActiveMs = readTotalActiveMs(run.stepStatus);
  if (totalActiveMs !== null) return Math.round(totalActiveMs / 1000);

  if (run.completedAt && run.createdAt) {
    const start = new Date(run.createdAt).getTime();
    const end = new Date(run.completedAt).getTime();
    return Math.round((end - start) / 1000);
  }
  return null;
}

function readTotalActiveMs(stepStatus: Record<string, unknown> | null | undefined): number | null {
  if (!stepStatus || typeof stepStatus !== 'object') return null;
  const v = (stepStatus as Record<string, unknown>)._totalActiveMs;
  if (typeof v === 'number' && v > 0) return v;
  return null;
}

export function formatDurationSec(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatDurationMs(milliseconds: number | null | undefined): string {
  if (
    milliseconds === null ||
    milliseconds === undefined ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const roundedSeconds = Math.round(seconds);
  return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
}

export function formatRunPhaseTiming(
  stepTiming: Record<string, number> | null | undefined,
): string | null {
  if (!stepTiming) return null;
  const phases = [
    ['同步', stepTiming.sync_wall],
    ['驗證', stepTiming.verify_plan_qty],
    ['計算', stepTiming.calculation],
  ] as const;
  const visible = phases.filter(([, value]) => typeof value === 'number' && Number.isFinite(value));
  if (visible.length === 0) return null;
  return visible.map(([label, value]) => `${label} ${formatDurationMs(value)}`).join(' · ');
}
