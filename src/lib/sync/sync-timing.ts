export function accumulateSyncWallTiming(
  previousTiming: Record<string, number>,
  attemptElapsedMs: number,
): Record<string, number> {
  const previousWall = Number.isFinite(previousTiming.sync_wall) && previousTiming.sync_wall > 0
    ? previousTiming.sync_wall
    : 0;
  const attemptWall = Number.isFinite(attemptElapsedMs) && attemptElapsedMs > 0
    ? Math.round(attemptElapsedMs)
    : 0;

  return {
    ...previousTiming,
    sync_attempt_wall: attemptWall,
    sync_wall: previousWall + attemptWall,
  };
}
