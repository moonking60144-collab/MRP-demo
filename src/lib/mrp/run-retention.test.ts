import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupCompletedRuns,
  deleteCompletedRunForRetention,
  deleteErrorRunSnapshot,
  deleteRetentionCandidates,
  getRunRetentionConfig,
  selectRetentionCandidates,
  type RetentionRun,
} from './run-retention';
import type {
  ArchiveRetentionDenialReason,
  ArchiveRetentionGate,
} from '../archive/archive-retention-gate';
import { MRP_RUN_STATUS } from './run-status';
import { WORK_ORDER_STATUS } from '../work-order-state';
import type { PrismaClient } from '@prisma/client';
import { withRuntimeDbControl } from '../db';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-07-27T00:00:00.000Z');
const verifiedArchiveGate: ArchiveRetentionGate = async (runId) => ({
  allowed: true,
  runId,
  verifiedAt: '2026-09-04T08:00:00.000Z',
});

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

test('completed Run 清理同時保留 30 天內資料與最近 30 個完成版本', () => {
  const recent = Array.from({ length: 30 }, (_, index) =>
    completedRun(100 - index, index + 1, index === 0),
  );
  const runs = [
    ...recent,
    completedRun(20, 31),
    completedRun(19, 45),
    completedRun(18, 90),
  ];

  assert.deepEqual(
    selectRetentionCandidates(runs, now, {
      enabled: true,
      retentionDays: 30,
      minimumCompletedRuns: 30,
      batchSize: 2,
    }),
    [18, 19],
  );
});

test('completed Run 清理永不選 latest、active 或未達最少保留數的版本', () => {
  const latestOld = completedRun(1, 365, true);
  const activeOld: RetentionRun = {
    id: 2,
    status: MRP_RUN_STATUS.CALCULATING,
    isLatest: false,
    completedAt: new Date(now.getTime() - 365 * DAY),
  };
  const completed = Array.from({ length: 10 }, (_, index) =>
    completedRun(20 - index, 60 + index),
  );

  assert.deepEqual(
    selectRetentionCandidates([latestOld, activeOld, ...completed], now, {
      enabled: true,
      retentionDays: 30,
      minimumCompletedRuns: 30,
      batchSize: 10,
    }),
    [],
  );
});

test('retention 只有明確 opt-in 才啟用，並限制每批最多 10 個版本', () => {
  assert.deepEqual(getRunRetentionConfig({}), {
    enabled: false,
    retentionDays: 30,
    minimumCompletedRuns: 30,
    batchSize: 1,
  });
  assert.equal(
    getRunRetentionConfig({ MRP_RUN_RETENTION_ENABLED: 'unexpected' }).enabled,
    false,
  );
  for (const enabledValue of ['1', 'true', 'on', ' TRUE ']) {
    assert.equal(
      getRunRetentionConfig({
        MRP_RUN_RETENTION_ENABLED: enabledValue,
      }).enabled,
      true,
    );
  }
  assert.deepEqual(
    getRunRetentionConfig({
      MRP_RUN_RETENTION_ENABLED: 'false',
      MRP_RUN_RETENTION_DAYS: '0',
      MRP_RUN_RETENTION_MIN_COMPLETED: '45',
      MRP_RUN_RETENTION_BATCH_SIZE: '999',
    }),
    {
      enabled: false,
      retentionDays: 30,
      minimumCompletedRuns: 45,
      batchSize: 10,
    },
  );
});

test('單一 Run 清理失敗不阻斷後續候選，並保留失敗原因', async () => {
  const attempted: number[] = [];
  const result = await deleteRetentionCandidates(
    [11, 12, 13],
    async (runId) => {
      attempted.push(runId);
      if (runId === 11) throw new Error('lock timeout');
      return { outcome: runId === 13 ? 'deleted' : 'live-gate-changed' };
    },
  );

  assert.deepEqual(attempted, [11, 12, 13]);
  assert.deepEqual(result.deletedIds, [13]);
  assert.deepEqual(result.failures, [
    { runId: 11, error: 'lock timeout' },
    { runId: 12, error: 'Run transaction gate changed before deletion' },
  ]);
});

test('自動 retention 在 transaction 內重驗新 active Run gate', async () => {
  const runs = Array.from({ length: 31 }, (_, index) =>
    completedRun(100 - index, 31 + index, index === 0),
  );
  let activeRunChecks = 0;
  let advisoryLockCalls = 0;
  const tx = {
    $executeRaw: async () => {
      advisoryLockCalls += 1;
    },
    $queryRaw: async () => {
      throw new Error('transaction active Run gate 應先拒絕，不能鎖定候選');
    },
    productionPlanTransfer: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    mrpRun: {
      findFirst: async () => {
        activeRunChecks += 1;
        return activeRunChecks === 1 ? null : { id: 999 };
      },
      findMany: async () => runs,
      delete: async () => {
        throw new Error('新 active Run 出現後不得刪除候選');
      },
    },
  };
  const client = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => Promise<boolean>) =>
      callback(tx),
  } as unknown as PrismaClient;

  const result = await cleanupCompletedRuns(now, client, {
    enabled: true,
    retentionDays: 30,
    minimumCompletedRuns: 30,
    batchSize: 1,
  }, verifiedArchiveGate);

  assert.equal(advisoryLockCalls, 1);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.failures, [{
    runId: result.candidateIds[0],
    error: 'Run transaction gate changed before deletion',
  }]);
  assert.equal(result.candidateIds.length, 1);
});

test('自動 retention 在同一個 live transaction 內遇到未驗證 Archive 時保留候選', async () => {
  const runs = Array.from({ length: 31 }, (_, index) =>
    completedRun(100 - index, 31 + index, index === 0),
  );
  let transactionCalls = 0;
  let deleteCalls = 0;
  const tx = new Proxy({
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => runs,
    },
    productionPlanTransfer: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 70,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
  }, {
    get(target, property: string) {
      if (property in target) return target[property as keyof typeof target];
      return { deleteMany: async () => { deleteCalls += 1; } };
    },
  });
  const client = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;

  const result = await cleanupCompletedRuns(
    now,
    client,
    {
      enabled: true,
      retentionDays: 30,
      minimumCompletedRuns: 30,
      batchSize: 1,
    },
    async (runId) => ({
      allowed: false,
      runId,
      reason: 'coverage-missing',
    }),
  );

  assert.equal(result.candidateIds.length, 1);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.archiveBlocks, [{
    allowed: false,
    runId: result.candidateIds[0],
    reason: 'coverage-missing',
  }]);
  assert.equal(transactionCalls, 1);
  assert.equal(deleteCalls, 0);
});

test('queued 或 pending 工令轉單會阻擋來源 Run 清理', async () => {
  let runDeletes = 0;
  let transferWhere: unknown;
  const tx = {
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
    productionPlanTransfer: {
      findFirst: async ({ where }: { where: unknown }) => {
        transferWhere = where;
        return { id: 701 };
      },
    },
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => [
        completedRun(100, 1, true),
        completedRun(18, 40),
      ],
      delete: async () => {
        runDeletes += 1;
      },
    },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<boolean>) =>
      callback(tx),
  } as unknown as PrismaClient;

  await assert.rejects(
    deleteCompletedRunForRetention(
      18,
      {
        now,
        config: {
          enabled: true,
          retentionDays: 30,
          minimumCompletedRuns: 1,
          batchSize: 1,
        },
      },
      client,
      verifiedArchiveGate,
    ),
    /queued\/pending 工令轉單 #701/,
  );

  assert.equal(runDeletes, 0);
  assert.deepEqual(transferWhere, {
    mrpRunId: 18,
    workOrderStatus: {
      in: [WORK_ORDER_STATUS.QUEUED, WORK_ORDER_STATUS.PENDING],
    },
  });
});

test('所有 Archive 未就緒狀態都在同一個 live transaction 內 fail-closed', async () => {
  const reasons: ArchiveRetentionDenialReason[] = [
    'gate-disabled',
    'archive-not-configured',
    'source-database-mismatch',
    'archive-unreachable',
    'coverage-missing',
    'ingest-not-verified',
    'dump-hash-not-verified',
    'required-tables-not-verified',
    'live-snapshot-mismatch',
  ];
  let transactionCalls = 0;
  let deleteCalls = 0;
  const completed = [completedRun(100, 1, true), completedRun(18, 90)];
  const tx = new Proxy({
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => completed,
    },
    productionPlanTransfer: { findFirst: async () => null },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
  }, {
    get(target, property: string) {
      if (property in target) return target[property as keyof typeof target];
      return { deleteMany: async () => { deleteCalls += 1; } };
    },
  });
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;

  for (const reason of reasons) {
    const result = await deleteCompletedRunForRetention(
      18,
      {
        now,
        config: {
          enabled: true,
          retentionDays: 30,
          minimumCompletedRuns: 1,
          batchSize: 1,
        },
      },
      client,
      async (runId) => ({ allowed: false, runId, reason }),
    );
    assert.deepEqual(result, {
      outcome: 'archive-blocked',
      block: { allowed: false, runId: 18, reason },
    });
  }

  assert.equal(transactionCalls, reasons.length);
  assert.equal(deleteCalls, 0);
});

test('Archive lookup 失敗或放行證據 identity/time 錯誤時中止 live transaction', async () => {
  let transactionCalls = 0;
  const completed = [completedRun(100, 1, true), completedRun(18, 90)];
  const tx = {
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => completed,
    },
    productionPlanTransfer: { findFirst: async () => null },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;
  const guard = {
    now,
    config: { enabled: true, retentionDays: 30, minimumCompletedRuns: 1, batchSize: 1 },
  };
  const cases: Array<{ gate: ArchiveRetentionGate; error: RegExp }> = [
    { gate: async () => { throw new Error('Archive connection unavailable'); }, error: /connection unavailable/ },
    {
      gate: async () => ({ allowed: true, runId: 19, verifiedAt: now.toISOString() }),
      error: /returned Run #19 for Run #18/,
    },
    {
      gate: async (runId) => ({ allowed: true, runId, verifiedAt: 'invalid' }),
      error: /invalid verification time/,
    },
  ];
  for (const { gate, error } of cases) {
    await assert.rejects(deleteCompletedRunForRetention(18, guard, client, gate), error);
  }
  assert.equal(transactionCalls, cases.length, 'ARCHIVE_FAILURE_ROLLS_BACK_TRANSACTION');
});

test('自動清理使用正式 gate，即使啟用旗標但 reader 未設定仍保留 Run', async () => {
  const previous = process.env.MRP_RUN_ARCHIVE_GATE_ENABLED;
  process.env.MRP_RUN_ARCHIVE_GATE_ENABLED = 'true';
  let transactionCalls = 0;
  const runs = [completedRun(100, 1, true), completedRun(18, 90)];
  const tx = {
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => runs,
    },
    productionPlanTransfer: { findFirst: async () => null },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
  };
  const client = {
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => runs,
    },
    productionPlanTransfer: { findMany: async () => [] },
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;
  try {
    const result = await cleanupCompletedRuns(now, client, {
      enabled: true, retentionDays: 30, minimumCompletedRuns: 1, batchSize: 1,
    });
    assert.deepEqual(result, {
      candidateIds: [18], deletedIds: [], failures: [],
      archiveBlocks: [{ allowed: false, runId: 18, reason: 'archive-not-configured' }],
    });
    assert.equal(transactionCalls, 1, 'ARCHIVE_DENIAL_INSIDE_LIVE_TRANSACTION');
  } finally {
    if (previous === undefined) delete process.env.MRP_RUN_ARCHIVE_GATE_ENABLED;
    else process.env.MRP_RUN_ARCHIVE_GATE_ENABLED = previous;
  }
});

test('ERROR-only 刪除入口不能刪除已完成或 latest Run', async () => {
  for (const row of [
    { id: 18, status: MRP_RUN_STATUS.COMPLETED, is_latest: false },
    { id: 18, status: MRP_RUN_STATUS.ERROR, is_latest: true },
  ]) {
    let transferCalls = 0;
    const fixed = {
      $queryRaw: async () => [row],
      productionPlanTransfer: {
        findFirst: async () => { transferCalls += 1; return null; },
      },
      mrpRun: { delete: async () => undefined },
    };
    const tx = new Proxy(fixed, {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target];
        return { deleteMany: async () => undefined };
      },
    });
    const client = {
      $transaction: async (callback: (value: typeof tx) => Promise<boolean>) => callback(tx),
    } as unknown as PrismaClient;
    assert.equal(await deleteErrorRunSnapshot(18, client), false, 'ERROR_DELETE_STATUS_BOUNDARY');
    assert.equal(transferCalls, 0);
  }
});

test('精確 retention 刪除在 transaction 內重驗 active Run gate', async () => {
  let advisoryLockCalls = 0;
  let runDeletes = 0;
  const tx = {
    $executeRaw: async () => {
      advisoryLockCalls += 1;
    },
    $queryRaw: async () => {
      throw new Error('active Run gate 應先拒絕，不能鎖定或刪除目標 Run');
    },
    mrpRun: {
      findFirst: async () => ({ id: 99 }),
      findMany: async () => {
        throw new Error('active Run gate 應先拒絕，不應重新選擇候選');
      },
      delete: async () => {
        runDeletes += 1;
      },
    },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<boolean>) =>
      callback(tx),
  } as unknown as PrismaClient;

  assert.equal(
    (await deleteCompletedRunForRetention(
      18,
      {
        now,
        config: {
          enabled: true,
          retentionDays: 30,
          minimumCompletedRuns: 30,
          batchSize: 1,
        },
      },
      client,
      verifiedArchiveGate,
    )).outcome,
    'live-gate-changed',
  );
  assert.equal(advisoryLockCalls, 1);
  assert.equal(runDeletes, 0);
});


test('精確 retention 刪除在 transaction 內重驗 retention eligibility', async () => {
  let advisoryLockCalls = 0;
  let targetLockCalls = 0;
  let runDeletes = 0;
  const tx = {
    $executeRaw: async () => {
      advisoryLockCalls += 1;
    },
    $queryRaw: async () => {
      targetLockCalls += 1;
      return [];
    },
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => [],
      delete: async () => {
        runDeletes += 1;
      },
    },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<boolean>) =>
      callback(tx),
  } as unknown as PrismaClient;

  assert.equal(
    (await deleteCompletedRunForRetention(
      18,
      {
        now,
        config: {
          enabled: true,
          retentionDays: 30,
          minimumCompletedRuns: 30,
          batchSize: 1,
        },
      },
      client,
      verifiedArchiveGate,
    )).outcome,
    'live-gate-changed',
  );
  assert.equal(advisoryLockCalls, 1);
  assert.equal(targetLockCalls, 0);
  assert.equal(runDeletes, 0);
});

test('精確 retention 從候選重驗到 Archive gate 結束前持有資料庫切換鎖', async () => {
  const runs = [completedRun(100, 1, true), completedRun(18, 90)];
  let enterGate!: () => void;
  let releaseGate!: () => void;
  const gateEntered = new Promise<void>((resolve) => { enterGate = resolve; });
  const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tx = {
    mrpRun: {
      findFirst: async () => null,
      findMany: async () => runs,
    },
    productionPlanTransfer: { findFirst: async () => null },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.COMPLETED,
      is_latest: false,
    }],
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  } as unknown as PrismaClient;
  const deletion = deleteCompletedRunForRetention(
    18,
    {
      now,
      config: {
        enabled: true,
        retentionDays: 30,
        minimumCompletedRuns: 1,
        batchSize: 1,
      },
    },
    client,
    async (runId, live) => {
      assert.equal(runId, 18);
      assert.equal(live, tx);
      enterGate();
      await gateRelease;
      return { allowed: false, runId, reason: 'coverage-missing' };
    },
  );

  await gateEntered;
  let databaseSwitchSectionRan = false;
  const queuedDatabaseSwitch = withRuntimeDbControl(async () => {
    databaseSwitchSectionRan = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(databaseSwitchSectionRan, false);

  releaseGate();
  assert.deepEqual(await deletion, {
    outcome: 'archive-blocked',
    block: { allowed: false, runId: 18, reason: 'coverage-missing' },
  });
  await queuedDatabaseSwitch;
  assert.equal(databaseSwitchSectionRan, true);
});

test('Error Run 清理明確刪除工令領退料 movement，且不需 Archive coverage', async () => {
  const deletedDelegates: string[] = [];
  const fixed = {
    $queryRaw: async () => [{
      id: 18,
      status: MRP_RUN_STATUS.ERROR,
      is_latest: false,
    }],
    productionPlanTransfer: {
      findFirst: async () => null,
    },
    mrpRun: {
      delete: async () => {
        deletedDelegates.push('mrpRun');
      },
    },
  };
  const tx = new Proxy(fixed, {
    get(target, property: string) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return {
        deleteMany: async () => {
          deletedDelegates.push(property);
        },
      };
    },
  });
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<boolean>) =>
      callback(tx),
  } as unknown as PrismaClient;

  assert.equal(
    await deleteErrorRunSnapshot(18, client),
    true,
  );
  assert.ok(deletedDelegates.includes('stagingWorkOrderMaterialMovement'));
  assert.equal(deletedDelegates.at(-1), 'mrpRun');
});
