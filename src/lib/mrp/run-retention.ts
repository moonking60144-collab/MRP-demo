import { Prisma, type PrismaClient } from '@prisma/client';
import prisma, {
  currentDbMode,
  getClientForMode,
  withRuntimeDbControl,
} from '../db';
import { emitRunRetentionCompleted } from './run-events';
import {
  createAutomaticRunRetentionResult,
  saveLastAutomaticRunRetentionResult,
} from './run-retention-result';
import { WORK_ORDER_STATUS } from '../work-order-state';
import {
  ACTIVE_STATUSES,
  MRP_RUN_START_LOCK_KEY,
  MRP_RUN_STATUS,
} from './run-status';
import {
  archiveRetentionGate,
  type ArchiveRetentionDeniedDecision,
  type ArchiveRetentionGate,
  type ArchiveRetentionLiveSnapshotReader,
} from '../archive/archive-retention-gate';
import { runSnapshotLockIdentity } from './run-snapshot-lock';

export interface RunRetentionConfig {
  enabled: boolean;
  retentionDays: number;
  minimumCompletedRuns: number;
  batchSize: number;
}

export interface RetentionRun {
  id: number;
  status: string;
  isLatest: boolean;
  completedAt: Date | null;
}

export interface RetentionDeleteFailure {
  runId: number;
  error: string;
}

export type RetentionDeleteAttempt =
  | { outcome: 'deleted' }
  | { outcome: 'live-gate-changed' }
  | {
      outcome: 'archive-blocked';
      block: ArchiveRetentionDeniedDecision;
    };

export interface RetentionSnapshotGuard {
  now: Date;
  config: RunRetentionConfig;
}

type RetentionEnv = Record<string, string | undefined>;

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MINIMUM_COMPLETED_RUNS = 30;
const DEFAULT_BATCH_SIZE = 1;
const CLEANUP_DELAY_MS = 5_000;

function positiveInt(
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function getRunRetentionConfig(
  env: RetentionEnv = process.env,
): RunRetentionConfig {
  return {
    enabled: ['1', 'true', 'on'].includes(
      (env.MRP_RUN_RETENTION_ENABLED ?? '').trim().toLowerCase(),
    ),
    retentionDays: positiveInt(
      env.MRP_RUN_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    ),
    minimumCompletedRuns: positiveInt(
      env.MRP_RUN_RETENTION_MIN_COMPLETED,
      DEFAULT_MINIMUM_COMPLETED_RUNS,
    ),
    batchSize: positiveInt(
      env.MRP_RUN_RETENTION_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      10,
    ),
  };
}

export function selectEligibleRetentionCandidates(
  runs: RetentionRun[],
  now: Date,
  config: RunRetentionConfig,
): number[] {
  if (!config.enabled) return [];

  const completed = runs
    .filter(
      (run) =>
        run.status === MRP_RUN_STATUS.COMPLETED &&
        run.completedAt !== null,
    )
    .sort((a, b) => {
      const byTime = b.completedAt!.getTime() - a.completedAt!.getTime();
      return byTime || b.id - a.id;
    });
  const protectedIds = new Set(
    completed.slice(0, config.minimumCompletedRuns).map((run) => run.id),
  );
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000;

  return completed
    .filter(
      (run) =>
        !run.isLatest &&
        !protectedIds.has(run.id) &&
        run.completedAt!.getTime() < cutoff,
    )
    .sort((a, b) => {
      const byTime = a.completedAt!.getTime() - b.completedAt!.getTime();
      return byTime || a.id - b.id;
    })
    .map((run) => run.id);
}

export function selectRetentionCandidates(
  runs: RetentionRun[],
  now: Date,
  config: RunRetentionConfig,
): number[] {
  return selectEligibleRetentionCandidates(runs, now, config)
    .slice(0, config.batchSize);
}

export function selectExecutableRetentionCandidates(
  eligibleRunIds: number[],
  blockedRunIds: Iterable<number>,
  batchSize: number,
): number[] {
  const blocked = new Set(blockedRunIds);
  return eligibleRunIds
    .filter((runId) => !blocked.has(runId))
    .slice(0, batchSize);
}

async function deleteRunSnapshot(
  runId: number,
  allowedStatuses: string[],
  client: PrismaClient,
  retentionGuard?: RetentionSnapshotGuard,
  gate?: ArchiveRetentionGate,
): Promise<RetentionDeleteAttempt> {
  return client.$transaction(
    async (tx) => {
      if (retentionGuard) {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(${MRP_RUN_START_LOCK_KEY})`,
        );
        const activeRun = await tx.mrpRun.findFirst({
          where: { status: { in: ACTIVE_STATUSES } },
          select: { id: true },
        });
        if (activeRun) return { outcome: 'live-gate-changed' };

        const completedRuns = await tx.mrpRun.findMany({
          where: { status: MRP_RUN_STATUS.COMPLETED },
          select: {
            id: true,
            status: true,
            isLatest: true,
            completedAt: true,
          },
        });
        const eligibleRunIds = selectEligibleRetentionCandidates(
          completedRuns,
          retentionGuard.now,
          retentionGuard.config,
        );
        if (!eligibleRunIds.includes(runId)) {
          return { outcome: 'live-gate-changed' };
        }
      }

      if (gate) {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${runSnapshotLockIdentity(runId)}, 0))`,
        );
      }

      const locked = await tx.$queryRaw<
        Array<{ id: number; status: string; is_latest: boolean }>
      >(Prisma.sql`
        SELECT id, status, is_latest
        FROM public.mrp_run
        WHERE id = ${runId}
        FOR UPDATE
      `);
      const run = locked[0];
      if (
        !run ||
        run.is_latest ||
        !allowedStatuses.includes(run.status)
      ) {
        return { outcome: 'live-gate-changed' };
      }

      const activeTransfer = await tx.productionPlanTransfer.findFirst({
        where: {
          mrpRunId: runId,
          workOrderStatus: {
            in: [WORK_ORDER_STATUS.QUEUED, WORK_ORDER_STATUS.PENDING],
          },
        },
        select: { id: true },
      });
      if (activeTransfer) {
        throw new Error(
          `Run #${runId} 尚有 queued/pending 工令轉單 #${activeTransfer.id}`,
        );
      }

      if (gate) {
        const archiveDecision = await gate(
          runId,
          tx as unknown as ArchiveRetentionLiveSnapshotReader,
        );
        if (archiveDecision.runId !== runId) {
          throw new Error(
            `Archive retention gate returned Run #${archiveDecision.runId} for Run #${runId}`,
          );
        }
        if (!archiveDecision.allowed) {
          return { outcome: 'archive-blocked', block: archiveDecision };
        }
        if (!Number.isFinite(Date.parse(archiveDecision.verifiedAt))) {
          throw new Error(
            `Archive retention gate returned invalid verification time for Run #${runId}`,
          );
        }
      }

      await tx.salesMeetingPeriod.deleteMany({ where: { mrpRunId: runId } });
      await tx.salesMeeting.deleteMany({ where: { mrpRunId: runId } });
      await tx.componentWeeklyPeriod.deleteMany({ where: { mrpRunId: runId } });
      await tx.componentWeekly.deleteMany({ where: { mrpRunId: runId } });
      await tx.fgPlanSuggestion.deleteMany({ where: { mrpRunId: runId } });
      await tx.fgMonthlyPeriod.deleteMany({ where: { mrpRunId: runId } });
      await tx.fgMonthly.deleteMany({ where: { mrpRunId: runId } });

      await tx.stagingPurchaseOrder.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingProductionPlan.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingWorkOrderMaterialMovement.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingWorkOrderBom.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingWorkOrder.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingForecast.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingOrder.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingInventoryLot.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingInventory.deleteMany({ where: { mrpRunId: runId } });
      await tx.stagingPartVersion.deleteMany({ where: { mrpRunId: runId } });

      await tx.mrpRun.delete({ where: { id: runId } });
      return { outcome: 'deleted' };
    },
    { timeout: 10 * 60_000, maxWait: 10_000 },
  );
}

function pinRetentionClient(client: PrismaClient): PrismaClient {
  if (client !== prisma) return client;
  const pinned = getClientForMode(currentDbMode());
  if (!pinned) throw new Error('目前 MRP 資料庫沒有可固定的 Prisma client');
  return pinned;
}

export async function deleteErrorRunSnapshot(
  runId: number,
  client: PrismaClient = prisma,
): Promise<boolean> {
  return withRuntimeDbControl(async () => {
    const result = await deleteRunSnapshot(
      runId,
      [MRP_RUN_STATUS.ERROR],
      pinRetentionClient(client),
    );
    return result.outcome === 'deleted';
  });
}

async function deleteCompletedRunForRetentionPinned(
  runId: number,
  retentionGuard: RetentionSnapshotGuard,
  client: PrismaClient,
  gate: ArchiveRetentionGate,
): Promise<RetentionDeleteAttempt> {
  return deleteRunSnapshot(
    runId,
    [MRP_RUN_STATUS.COMPLETED],
    client,
    retentionGuard,
    gate,
  );
}

export async function deleteCompletedRunForRetention(
  runId: number,
  retentionGuard: RetentionSnapshotGuard,
  client: PrismaClient = prisma,
  gate: ArchiveRetentionGate = archiveRetentionGate,
): Promise<RetentionDeleteAttempt> {
  return withRuntimeDbControl(() =>
    deleteCompletedRunForRetentionPinned(
      runId,
      retentionGuard,
      pinRetentionClient(client),
      gate,
    ),
  );
}

async function cleanupCompletedRunsPinned(
  now = new Date(),
  client: PrismaClient,
  config: RunRetentionConfig = getRunRetentionConfig(),
  gate: ArchiveRetentionGate = archiveRetentionGate,
): Promise<{
  candidateIds: number[];
  deletedIds: number[];
  archiveBlocks: ArchiveRetentionDeniedDecision[];
  failures: RetentionDeleteFailure[];
}> {
  if (!config.enabled) {
    return {
      candidateIds: [],
      deletedIds: [],
      archiveBlocks: [],
      failures: [],
    };
  }

  const activeRun = await client.mrpRun.findFirst({
    where: { status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  if (activeRun) {
    return {
      candidateIds: [],
      deletedIds: [],
      archiveBlocks: [],
      failures: [],
    };
  }

  const runs = await client.mrpRun.findMany({
    where: { status: MRP_RUN_STATUS.COMPLETED },
    select: {
      id: true,
      status: true,
      isLatest: true,
      completedAt: true,
    },
  });
  const eligibleRunIds = selectEligibleRetentionCandidates(runs, now, config);
  const blockedTransfers = eligibleRunIds.length === 0
    ? []
    : await client.productionPlanTransfer.findMany({
        where: {
          mrpRunId: { in: eligibleRunIds },
          workOrderStatus: {
            in: [WORK_ORDER_STATUS.QUEUED, WORK_ORDER_STATUS.PENDING],
          },
        },
        select: { mrpRunId: true },
      });
  const candidateIds = selectExecutableRetentionCandidates(
    eligibleRunIds,
    blockedTransfers.flatMap((transfer) =>
      transfer.mrpRunId === null ? [] : [transfer.mrpRunId]),
    config.batchSize,
  );
  const { deletedIds, archiveBlocks, failures } = await deleteRetentionCandidates(
    candidateIds,
    (runId) =>
      deleteCompletedRunForRetentionPinned(
        runId,
        { now, config },
        client,
        gate,
      ),
  );

  return { candidateIds, deletedIds, archiveBlocks, failures };
}

export async function cleanupCompletedRuns(
  now = new Date(),
  client: PrismaClient = prisma,
  config: RunRetentionConfig = getRunRetentionConfig(),
  gate: ArchiveRetentionGate = archiveRetentionGate,
): Promise<{
  candidateIds: number[];
  deletedIds: number[];
  archiveBlocks: ArchiveRetentionDeniedDecision[];
  failures: RetentionDeleteFailure[];
}> {
  return withRuntimeDbControl(() =>
    cleanupCompletedRunsPinned(now, pinRetentionClient(client), config, gate),
  );
}

export async function deleteRetentionCandidates(
  candidateIds: number[],
  deleteOne: (runId: number) => Promise<RetentionDeleteAttempt>,
): Promise<{
  deletedIds: number[];
  archiveBlocks: ArchiveRetentionDeniedDecision[];
  failures: RetentionDeleteFailure[];
}> {
  const deletedIds: number[] = [];
  const archiveBlocks: ArchiveRetentionDeniedDecision[] = [];
  const failures: RetentionDeleteFailure[] = [];

  for (const runId of candidateIds) {
    try {
      const result = await deleteOne(runId);
      if (result.outcome === 'deleted') {
        deletedIds.push(runId);
      } else if (result.outcome === 'archive-blocked') {
        archiveBlocks.push(result.block);
      } else {
        failures.push({
          runId,
          error: 'Run transaction gate changed before deletion',
        });
      }
    } catch (error) {
      failures.push({
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deletedIds, archiveBlocks, failures };
}

const retentionGlobal = globalThis as typeof globalThis & {
  __mrpRunRetentionTimer?: ReturnType<typeof setTimeout>;
};

export function scheduleCompletedRunCleanup(): void {
  if (!getRunRetentionConfig().enabled || retentionGlobal.__mrpRunRetentionTimer) {
    return;
  }

  retentionGlobal.__mrpRunRetentionTimer = setTimeout(() => {
    retentionGlobal.__mrpRunRetentionTimer = undefined;
    const startedAt = new Date();
    const publish = async (
      result: ReturnType<typeof createAutomaticRunRetentionResult>,
    ) => {
      try {
        await saveLastAutomaticRunRetentionResult(result);
      } catch (error) {
        console.error('[RunRetention] Failed to save automatic cleanup result:', error);
      }
      emitRunRetentionCompleted({ result });
    };

    void cleanupCompletedRuns(startedAt)
      .then(async ({ candidateIds, deletedIds, archiveBlocks, failures }) => {
        const result = createAutomaticRunRetentionResult({
          startedAt,
          completedAt: new Date(),
          candidateIds,
          deletedIds,
          archiveBlocks,
          failureCount: failures.length,
        });
        await publish(result);
        if (deletedIds.length > 0) {
          console.info(`[RunRetention] Deleted completed run(s): ${deletedIds.join(', ')}`);
        }
        for (const block of archiveBlocks) {
          console.info(
            `[RunRetention] Preserved completed run #${block.runId}: ${block.reason}`,
          );
        }
        for (const failure of failures) {
          console.error(
            `[RunRetention] Failed to delete completed run #${failure.runId}: ${failure.error}`,
          );
        }
      })
      .catch(async (error) => {
        const result = createAutomaticRunRetentionResult({
          startedAt,
          completedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        });
        await publish(result);
        console.error('[RunRetention] Cleanup failed:', error);
      });
  }, CLEANUP_DELAY_MS);
  retentionGlobal.__mrpRunRetentionTimer.unref?.();
}
