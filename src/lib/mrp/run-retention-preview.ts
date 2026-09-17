import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../db';
import { WORK_ORDER_STATUS } from '../work-order-state';
import {
  getRunRetentionConfig,
  selectEligibleRetentionCandidates,
  selectExecutableRetentionCandidates,
  type RunRetentionConfig,
} from './run-retention';
import { ACTIVE_STATUSES, MRP_RUN_STATUS } from './run-status';
import {
  archiveRetentionPreflight,
  getArchiveRetentionGateStatus,
  type ArchiveRetentionGateStatus,
} from '../archive/archive-retention-gate';

const RETENTION_TABLE_NAMES = [
  'mrp_out.sales_meeting_periods',
  'mrp_out.sales_meeting',
  'mrp_out.component_weekly_periods',
  'mrp_out.component_weekly',
  'mrp_out.fg_plan_suggestions',
  'mrp_out.fg_monthly_periods',
  'mrp_out.fg_monthly',
  'staging.purchase_orders',
  'staging.production_plans',
  'staging.work_order_material_movements',
  'staging.work_order_bom',
  'staging.work_orders',
  'staging.forecasts',
  'staging.orders',
  'staging.inventory_lots',
  'staging.inventory',
  'staging.part_versions',
] as const;

interface RelationSizeRow {
  tableName: string;
  totalBytes: bigint;
}

export interface RetentionPreview {
  generatedAt: string;
  config: RunRetentionConfig;
  completedRunCount: number;
  protectedCompletedRunCount: number;
  activeRuns: Array<{ id: number; status: string; versionCode: string }>;
  eligibleRunIds: number[];
  targetSelection: RetentionTargetSelection | null;
  plannedBatchRunIds: number[];
  archiveGate: ArchiveRetentionGateStatus;
  coverageReadyBatchRunIds: number[];
  blockedTransfers: Array<{
    id: number;
    mrpRunId: number | null;
    workOrderStatus: string;
  }>;
  transferReferenceCount: number;
  backlogRows: Array<{ tableName: string; rowCount: number }>;
  backlogTotalRows: number;
  rowsToDelete: Array<{ tableName: string; rowCount: number }>;
  totalRowsToDelete: number;
  relationSizes: Array<{ tableName: string; totalBytes: number }>;
}

export type RetentionCliMode = 'dry-run' | 'execute';
export type RetentionTargetState =
  | 'ready'
  | 'active-run'
  | 'not-eligible'
  | 'blocked-transfer';

export interface RetentionCliOptions {
  mode: RetentionCliMode;
  targetRunId: number | null;
}

export interface RetentionTargetSelection {
  runId: number;
  state: RetentionTargetState;
  plannedRunIds: number[];
}

export function parseRetentionCliOptions(args: string[]): RetentionCliOptions {
  let targetRunId: number | null = null;
  const modeArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--execute') {
      modeArgs.push(arg);
      continue;
    }
    if (arg === '--run-id') {
      if (targetRunId !== null) {
        throw new Error('--run-id 不可重複指定');
      }
      const value = args[index + 1];
      const parsed = Number(value);
      if (
        value === undefined ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(parsed)
      ) {
        throw new Error('--run-id 需要正整數');
      }
      targetRunId = parsed;
      index += 1;
      continue;
    }
    throw new Error(`不支援的參數: ${arg}`);
  }

  if (modeArgs.includes('--dry-run') && modeArgs.includes('--execute')) {
    throw new Error('--dry-run 與 --execute 不可同時使用');
  }

  return {
    mode: modeArgs.includes('--execute') ? 'execute' : 'dry-run',
    targetRunId,
  };
}

export function parseRetentionCliMode(args: string[]): RetentionCliMode {
  return parseRetentionCliOptions(args).mode;
}


export function selectExactRetentionTarget(
  eligibleRunIds: number[],
  blockedRunIds: Iterable<number>,
  activeRunCount: number,
  targetRunId: number,
): RetentionTargetSelection {
  if (activeRunCount > 0) {
    return { runId: targetRunId, state: 'active-run', plannedRunIds: [] };
  }
  if (!eligibleRunIds.includes(targetRunId)) {
    return { runId: targetRunId, state: 'not-eligible', plannedRunIds: [] };
  }
  if (new Set(blockedRunIds).has(targetRunId)) {
    return { runId: targetRunId, state: 'blocked-transfer', plannedRunIds: [] };
  }
  return { runId: targetRunId, state: 'ready', plannedRunIds: [targetRunId] };
}

async function countCandidateRows(
  client: PrismaClient,
  eligibleRunIds: number[],
): Promise<Array<{ tableName: string; rowCount: number }>> {
  if (eligibleRunIds.length === 0) return [];
  const where = { mrpRunId: { in: eligibleRunIds } };
  const counts = await Promise.all([
    client.salesMeetingPeriod.count({ where }),
    client.salesMeeting.count({ where }),
    client.componentWeeklyPeriod.count({ where }),
    client.componentWeekly.count({ where }),
    client.fgPlanSuggestion.count({ where }),
    client.fgMonthlyPeriod.count({ where }),
    client.fgMonthly.count({ where }),
    client.stagingPurchaseOrder.count({ where }),
    client.stagingProductionPlan.count({ where }),
    client.stagingWorkOrderMaterialMovement.count({ where }),
    client.stagingWorkOrderBom.count({ where }),
    client.stagingWorkOrder.count({ where }),
    client.stagingForecast.count({ where }),
    client.stagingOrder.count({ where }),
    client.stagingInventoryLot.count({ where }),
    client.stagingInventory.count({ where }),
    client.stagingPartVersion.count({ where }),
  ]);
  return [
    ...RETENTION_TABLE_NAMES.map((tableName, index) => ({
      tableName,
      rowCount: counts[index],
    })),
    { tableName: 'public.mrp_run', rowCount: eligibleRunIds.length },
  ];
}

async function loadRelationSizes(
  client: PrismaClient,
): Promise<Array<{ tableName: string; totalBytes: number }>> {
  const relationNames = [...RETENTION_TABLE_NAMES, 'public.mrp_run'];
  const rows = await client.$queryRaw<RelationSizeRow[]>(Prisma.sql`
    SELECT stats.schemaname || '.' || stats.relname AS "tableName",
           pg_total_relation_size(stats.relid)::bigint AS "totalBytes"
    FROM pg_stat_user_tables AS stats
    WHERE stats.schemaname || '.' || stats.relname
      IN (${Prisma.join(relationNames)})
    ORDER BY pg_total_relation_size(stats.relid) DESC
  `);
  return rows.map((row) => ({
    tableName: row.tableName,
    totalBytes: Number(row.totalBytes),
  }));
}

export async function getRunRetentionPreview(
  now = new Date(),
  client: PrismaClient = prisma,
  config: RunRetentionConfig = getRunRetentionConfig(),
  targetRunId: number | null = null,
): Promise<RetentionPreview> {
  const [completedRuns, activeRuns] = await Promise.all([
    client.mrpRun.findMany({
      where: { status: MRP_RUN_STATUS.COMPLETED },
      select: {
        id: true,
        status: true,
        isLatest: true,
        completedAt: true,
      },
    }),
    client.mrpRun.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true, status: true, versionCode: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  const eligibleRunIds = selectEligibleRetentionCandidates(
    completedRuns,
    now,
    { ...config, enabled: true },
  );
  const [blockedTransfers, transferReferenceCount, relationSizes] =
    await Promise.all([
      eligibleRunIds.length === 0
        ? []
        : client.productionPlanTransfer.findMany({
            where: {
              mrpRunId: { in: eligibleRunIds },
              workOrderStatus: {
                in: [WORK_ORDER_STATUS.QUEUED, WORK_ORDER_STATUS.PENDING],
              },
            },
            select: { id: true, mrpRunId: true, workOrderStatus: true },
            orderBy: { id: 'asc' },
          }),
      eligibleRunIds.length === 0
        ? 0
        : client.productionPlanTransfer.count({
            where: { mrpRunId: { in: eligibleRunIds } },
          }),
      loadRelationSizes(client),
    ]);
  const blockedRunIds = blockedTransfers.flatMap((transfer) =>
    transfer.mrpRunId === null ? [] : [transfer.mrpRunId],
  );
  const targetSelection = targetRunId === null
    ? null
    : selectExactRetentionTarget(
        eligibleRunIds,
        blockedRunIds,
        activeRuns.length,
        targetRunId,
      );
  const plannedBatchRunIds = targetSelection
    ? targetSelection.plannedRunIds
    : activeRuns.length > 0
      ? []
      : selectExecutableRetentionCandidates(
          eligibleRunIds,
          blockedRunIds,
          config.batchSize,
        );
  let archiveGate = getArchiveRetentionGateStatus();
  let archiveReadyRunIds: number[] = [];
  if (archiveGate.enabled && archiveGate.reason === null && plannedBatchRunIds.length > 0) {
    const decisions = await Promise.all(
      plannedBatchRunIds.map((runId) => archiveRetentionPreflight(runId)),
    );
    archiveReadyRunIds = decisions
      .filter((decision) => decision.allowed)
      .map((decision) => decision.runId);
    archiveGate = archiveReadyRunIds.length > 0
      ? { enabled: true, coverageReady: true, reason: null }
      : {
          enabled: true,
          coverageReady: false,
          reason: decisions[0]?.allowed === false
            ? decisions[0].reason
            : null,
        };
  }
  const coverageReadyBatchRunIds = config.enabled
    ? archiveReadyRunIds
    : [];
  const [backlogRows, rowsToDelete] = await Promise.all([
    countCandidateRows(client, eligibleRunIds),
    countCandidateRows(client, plannedBatchRunIds),
  ]);

  return {
    generatedAt: now.toISOString(),
    config,
    completedRunCount: completedRuns.length,
    protectedCompletedRunCount: completedRuns.length - eligibleRunIds.length,
    activeRuns,
    eligibleRunIds,
    targetSelection,
    plannedBatchRunIds,
    archiveGate,
    coverageReadyBatchRunIds,
    blockedTransfers,
    transferReferenceCount,
    backlogRows,
    backlogTotalRows: backlogRows.reduce(
      (total, table) => total + table.rowCount,
      0,
    ),
    rowsToDelete,
    totalRowsToDelete: rowsToDelete.reduce(
      (total, table) => total + table.rowCount,
      0,
    ),
    relationSizes,
  };
}
