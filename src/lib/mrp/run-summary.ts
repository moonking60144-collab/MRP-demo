import { activeRunDurationSec } from '../run-duration';

export interface RunSummarySource {
  id: number;
  versionCode: string;
  runDate: Date;
  status: string;
  isLatest: boolean;
  createdAt: Date;
  completedAt: Date | null;
  createdBy: string | null;
  syncCounts: unknown;
  stepTiming: unknown;
  errorMessage: string | null;
  stepStatus: unknown;
}

export function toRunSummary(run: RunSummarySource) {
  const { stepStatus, ...summary } = run;
  return {
    ...summary,
    duration: activeRunDurationSec({
      stepStatus: stepStatus as Record<string, unknown> | null,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
    }),
  };
}
