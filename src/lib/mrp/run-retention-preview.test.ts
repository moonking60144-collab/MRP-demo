import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  getRunRetentionPreview,
  parseRetentionCliMode,
  parseRetentionCliOptions,
  selectExactRetentionTarget,
} from './run-retention-preview';
import {
  selectEligibleRetentionCandidates,
  selectExecutableRetentionCandidates,
  selectRetentionCandidates,
  type RetentionRun,
} from './run-retention';
import { MRP_RUN_STATUS } from './run-status';

const now = new Date('2026-07-28T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function completedRun(id: number, daysAgo: number): RetentionRun {
  return {
    id,
    status: MRP_RUN_STATUS.COMPLETED,
    isLatest: id === 100,
    completedAt: new Date(now.getTime() - daysAgo * DAY),
  };
}

test('retention preview 列出全部 backlog，實際批次仍受 batchSize 限制', () => {
  const runs = [
    ...Array.from({ length: 30 }, (_, index) => completedRun(100 - index, index + 1)),
    completedRun(20, 31),
    completedRun(19, 45),
    completedRun(18, 90),
  ];
  const config = {
    enabled: true,
    retentionDays: 30,
    minimumCompletedRuns: 30,
    batchSize: 2,
  };

  assert.deepEqual(selectEligibleRetentionCandidates(runs, now, config), [18, 19, 20]);
  assert.deepEqual(selectRetentionCandidates(runs, now, config), [18, 19]);
});

test('retention CLI 預設 dry-run，execute 必須明確指定', () => {
  assert.equal(parseRetentionCliMode([]), 'dry-run');
  assert.equal(parseRetentionCliMode(['--dry-run']), 'dry-run');
  assert.equal(parseRetentionCliMode(['--execute']), 'execute');
  assert.deepEqual(
    parseRetentionCliOptions(['--execute', '--run-id', '8']),
    { mode: 'execute', targetRunId: 8 },
  );
  assert.throws(
    () => parseRetentionCliMode(['--dry-run', '--execute']),
    /不可同時使用/,
  );
  assert.throws(() => parseRetentionCliMode(['--force']), /不支援的參數/);
  assert.throws(() => parseRetentionCliOptions(['--run-id']), /需要正整數/);
  assert.throws(() => parseRetentionCliOptions(['--run-id', '0']), /需要正整數/);
  assert.throws(
    () => parseRetentionCliOptions(['--run-id', '8', '--run-id', '9']),
    /不可重複指定/,
  );
});

test('blocked Run 不會卡住後續可執行 retention 候選', () => {
  assert.deepEqual(
    selectExecutableRetentionCandidates([18, 19, 20], [18], 2),
    [19, 20],
  );
});


test('精確指定 Run 被 gate 阻擋時不會 fallback 到其他候選', () => {
  assert.deepEqual(
    selectExactRetentionTarget([18, 19], [18], 0, 18),
    { runId: 18, state: 'blocked-transfer', plannedRunIds: [] },
  );
  assert.deepEqual(
    selectExactRetentionTarget([18, 19], [], 1, 19),
    { runId: 19, state: 'active-run', plannedRunIds: [] },
  );
  assert.deepEqual(
    selectExactRetentionTarget([18, 19], [], 0, 20),
    { runId: 20, state: 'not-eligible', plannedRunIds: [] },
  );
  assert.deepEqual(
    selectExactRetentionTarget([18, 19], [], 0, 19),
    { runId: 19, state: 'ready', plannedRunIds: [19] },
  );
});

test('disabled production 設定仍可分開預覽 backlog 與 planned batch 且不呼叫 delete', async () => {
  const completedRuns = [
    ...Array.from({ length: 30 }, (_, index) => completedRun(100 - index, index + 1)),
    completedRun(18, 90),
    completedRun(17, 60),
    completedRun(16, 45),
  ];
  const countDelegate = {
    count: async ({ where }: { where: { mrpRunId: { in: number[] } } }) =>
      where.mrpRunId.in.length,
  };
  let deleted = false;
  let findManyCalls = 0;
  const client = {
    mrpRun: {
      findMany: async () => {
        findManyCalls += 1;
        return findManyCalls === 1 ? completedRuns : [];
      },
      delete: async () => {
        deleted = true;
      },
    },
    productionPlanTransfer: {
      findMany: async () => [],
      count: async () => 2,
    },
    salesMeetingPeriod: countDelegate,
    salesMeeting: countDelegate,
    componentWeeklyPeriod: countDelegate,
    componentWeekly: countDelegate,
    fgPlanSuggestion: countDelegate,
    fgMonthlyPeriod: countDelegate,
    fgMonthly: countDelegate,
    stagingPurchaseOrder: countDelegate,
    stagingProductionPlan: countDelegate,
    stagingWorkOrderMaterialMovement: countDelegate,
    stagingWorkOrderBom: countDelegate,
    stagingWorkOrder: countDelegate,
    stagingForecast: countDelegate,
    stagingOrder: countDelegate,
    stagingInventoryLot: countDelegate,
    stagingInventory: countDelegate,
    stagingPartVersion: countDelegate,
    $queryRaw: async () => [{
      tableName: 'staging.inventory_lots',
      totalBytes: '1024',
    }],
  } as unknown as PrismaClient;

  const preview = await getRunRetentionPreview(now, client, {
    enabled: false,
    retentionDays: 30,
    minimumCompletedRuns: 30,
    batchSize: 1,
  });

  assert.equal(deleted, false);
  assert.deepEqual(preview.eligibleRunIds, [18, 17, 16]);
  assert.deepEqual(preview.plannedBatchRunIds, [18]);
  assert.equal(preview.archiveGate.coverageReady, false);
  assert.deepEqual(preview.coverageReadyBatchRunIds, []);
  assert.equal(preview.transferReferenceCount, 2);
  assert.equal(preview.totalRowsToDelete, 18);
  assert.equal(preview.rowsToDelete.at(-1)?.rowCount, 1);
  assert.equal(preview.backlogTotalRows, 54);
  assert.equal(preview.backlogRows.at(-1)?.rowCount, 3);
  assert.deepEqual(preview.relationSizes, [{
    tableName: 'staging.inventory_lots',
    totalBytes: 1024,
  }]);
});
