export const MRP_RETENTION_UPDATED_EVENT = 'mrp-retention-updated';

export function resolveRetentionFallbackRunId(
  selectedRunId: number | null,
  latestRunId: number | null,
  deletedRunIds: readonly number[],
): number | null {
  if (
    selectedRunId === null ||
    latestRunId === null ||
    !deletedRunIds.includes(selectedRunId)
  ) {
    return null;
  }
  return latestRunId;
}


export async function resolveMissingSelectedRunFallback(
  selectedRunId: number | null,
  latestRunId: number | null,
  runExists: (runId: number) => Promise<boolean>,
): Promise<number | null> {
  if (
    selectedRunId === null ||
    latestRunId === null ||
    selectedRunId === latestRunId
  ) {
    return null;
  }
  return await runExists(selectedRunId) ? null : latestRunId;
}
