import type { PrismaClient } from '@prisma/client';
import prisma from '../db';
import { WORK_ORDER_STATUS } from '../work-order-state';
import {
  getRunRetentionConfig,
  selectEligibleRetentionCandidates,
  selectExecutableRetentionCandidates,
  type RetentionRun,
  type RunRetentionConfig,
} from './run-retention';
import {
  getLastAutomaticRunRetentionResult,
  type AutomaticRunRetentionResult,
} from './run-retention-result';
import { ACTIVE_STATUSES, MRP_RUN_STATUS } from './run-status';
import {
  getArchiveRetentionGateStatus,
  getArchiveRetentionGateStatusForRun,
  type ArchiveRetentionGateStatus,
} from '../archive/archive-retention-gate';

export interface RunRetentionStatus {
  config: RunRetentionConfig;
  activeRun: boolean;
  completedRunCount: number;
  eligibleRunCount: number;
  blockedRunCount: number;
  nextEligibleRunId: number | null;
  nextCoverageReadyRunId: number | null;
  archiveGate: ArchiveRetentionGateStatus;
  lastAutomaticResult: AutomaticRunRetentionResult | null;
}

interface BuildRunRetentionStatusInput {
  runs: RetentionRun[];
  blockedRunIds: Iterable<number>;
  activeRun: boolean;
  config: RunRetentionConfig;
  archiveGate: ArchiveRetentionGateStatus;
  now: Date;
  lastAutomaticResult: AutomaticRunRetentionResult | null;
}

interface GetRunRetentionStatusOptions {
  client?: PrismaClient;
  now?: Date;
  activeRun?: boolean;
}

function evaluationConfig(config: RunRetentionConfig): RunRetentionConfig {
  return config.enabled ? config : { ...config, enabled: true };
}

export function buildRunRetentionStatus(
  input: BuildRunRetentionStatusInput,
): RunRetentionStatus {
  const eligibleRunIds = selectEligibleRetentionCandidates(
    input.runs,
    input.now,
    evaluationConfig(input.config),
  );
  const blocked = new Set(input.blockedRunIds);
  const blockedRunCount = eligibleRunIds.filter((runId) =>
    blocked.has(runId)).length;
  const nextEligibleRunId = selectExecutableRetentionCandidates(
    eligibleRunIds,
    blocked,
    1,
  )[0] ?? null;
  const nextCoverageReadyRunId = !input.config.enabled || input.activeRun || !input.archiveGate.coverageReady
    ? null
    : nextEligibleRunId;

  return {
    config: input.config,
    activeRun: input.activeRun,
    completedRunCount: input.runs.length,
    eligibleRunCount: eligibleRunIds.length,
    blockedRunCount,
    nextEligibleRunId,
    nextCoverageReadyRunId,
    archiveGate: input.archiveGate,
    lastAutomaticResult: input.lastAutomaticResult,
  };
}

export async function getRunRetentionStatus(
  options: GetRunRetentionStatusOptions = {},
): Promise<RunRetentionStatus> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const config = getRunRetentionConfig();
  const [activeRunRow, runs, lastAutomaticResult] = await Promise.all([
    options.activeRun === undefined
      ? client.mrpRun.findFirst({
          where: { status: { in: ACTIVE_STATUSES } },
          select: { id: true },
        })
      : Promise.resolve(null),
    client.mrpRun.findMany({
      where: { status: MRP_RUN_STATUS.COMPLETED },
      select: {
        id: true,
        status: true,
        isLatest: true,
        completedAt: true,
      },
    }),
    getLastAutomaticRunRetentionResult(client),
  ]);
  const eligibleRunIds = selectEligibleRetentionCandidates(
    runs,
    now,
    evaluationConfig(config),
  );
  const blockedTransfers =
    eligibleRunIds.length === 0
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
  const blockedRunIds = blockedTransfers.flatMap((transfer) =>
    transfer.mrpRunId === null ? [] : [transfer.mrpRunId]);
  const nextEligibleRunId = selectExecutableRetentionCandidates(
    eligibleRunIds,
    blockedRunIds,
    1,
  )[0] ?? null;
  const archiveGate = nextEligibleRunId === null
    ? getArchiveRetentionGateStatus()
    : await getArchiveRetentionGateStatusForRun(nextEligibleRunId);

  return buildRunRetentionStatus({
    runs,
    blockedRunIds,
    activeRun: options.activeRun ?? Boolean(activeRunRow),
    config,
    archiveGate,
    now,
    lastAutomaticResult,
  });
}
