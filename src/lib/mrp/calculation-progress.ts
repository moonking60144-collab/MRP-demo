const CALCULATION_PROGRESS_INTERVAL_MS = 1000;

export function createCalculationProgressThrottle(
  now: () => number = Date.now,
): () => boolean {
  let nextReportAt = now() + CALCULATION_PROGRESS_INTERVAL_MS;

  return () => {
    const currentTime = now();
    if (currentTime < nextReportAt) return false;
    nextReportAt = currentTime + CALCULATION_PROGRESS_INTERVAL_MS;
    return true;
  };
}
