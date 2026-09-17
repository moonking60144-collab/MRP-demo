import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRunRetentionStatus } from './run-retention-status';
import { MRP_RUN_STATUS } from './run-status';
import type { RetentionRun } from './run-retention';

const now = new Date('2026-07-29T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function completedRun(
  id: number,
  daysAgo: number,
  isLatest = false,
): RetentionRun {
  return {
    id,
    status: MRP_RUN_STATUS.COMPLETED,
    isLatest,
    completedAt: new Date(now.getTime() - daysAgo * DAY),
  };
}

test('retention 停用時仍顯示唯讀 eligible backlog', () => {
  const status = buildRunRetentionStatus({
    runs: [
      completedRun(10, 1, true),
      completedRun(9, 2),
      completedRun(8, 40),
      completedRun(7, 50),
    ],
    blockedRunIds: [],
    activeRun: false,
    config: {
      enabled: false,
      retentionDays: 30,
      minimumCompletedRuns: 2,
      batchSize: 1,
    },
    archiveGate: {
      enabled: false,
      coverageReady: false,
      reason: 'gate-disabled',
    },
    now,
    lastAutomaticResult: null,
  });

  assert.equal(status.config.enabled, false);
  assert.equal(status.eligibleRunCount, 2);
  assert.equal(status.nextEligibleRunId, 7);
  assert.equal(status.nextCoverageReadyRunId, null);
  assert.deepEqual(status.archiveGate, {
    enabled: false,
    coverageReady: false,
    reason: 'gate-disabled',
  });
});

test('retention 停用時即使 Archive 已就緒也沒有可清理候選', () => {
  const status = buildRunRetentionStatus({
    runs: [completedRun(10, 1, true), completedRun(7, 50)],
    blockedRunIds: [],
    activeRun: false,
    config: { enabled: false, retentionDays: 30, minimumCompletedRuns: 1, batchSize: 1 },
    archiveGate: { enabled: true, coverageReady: true, reason: null },
    now,
    lastAutomaticResult: null,
  });
  assert.equal(status.nextEligibleRunId, 7);
  assert.equal(status.nextCoverageReadyRunId, null);
});

test('retention 維護狀態排除 transfer blocker 並保留 eligible 總數', () => {
  const status = buildRunRetentionStatus({
    runs: [
      completedRun(10, 1, true),
      completedRun(9, 2),
      completedRun(8, 40),
      completedRun(7, 50),
    ],
    blockedRunIds: [7],
    activeRun: true,
    config: {
      enabled: true,
      retentionDays: 30,
      minimumCompletedRuns: 2,
      batchSize: 1,
    },
    archiveGate: {
      enabled: true,
      coverageReady: true,
      reason: null,
    },
    now,
    lastAutomaticResult: null,
  });

  assert.equal(status.activeRun, true);
  assert.equal(status.eligibleRunCount, 2);
  assert.equal(status.blockedRunCount, 1);
  assert.equal(status.nextEligibleRunId, 8);
  assert.equal(status.nextCoverageReadyRunId, null);
});
