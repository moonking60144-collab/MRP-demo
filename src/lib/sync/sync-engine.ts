/**
 * Sync Engine: Fetches data from Ragic staging forms into PostgreSQL
 * Uses batch createMany for efficient inserts
 * Supports stop/pause via in-memory signal
 * Shows live API call status and expected record counts
 */
import prisma from '../db';
import { Prisma } from '@prisma/client';
import { fetchRagicListing, type RagicRecord } from '../ragic-client';
import { runLog, withRunLogging } from '../run-logger';
import { MRP_RUN_STATUS } from '../mrp/run-status';
import {
  calculateWorkOrderBomUsage,
  reconcileWorkOrderBomUsage,
  type IssuedQtyError,
  type IssuedQtyState,
  type WorkOrderBomUsageResult,
} from '../mrp/work-order-bom-usage';
import {
  resolveWorkOrderMaterialLedgers,
  type WorkOrderIssueAllocation,
  type WorkOrderLedgerError,
  type WorkOrderLedgerMovement,
} from '../mrp/work-order-material-ledger';
import { settleAllOrThrow } from '../mrp/run-attempt-control';
import { accumulateSyncWallTiming } from './sync-timing';
import {
  boundedConcurrency,
  mapWithBoundedConcurrency,
} from './bounded-concurrency';
import {
  RAGIC_ERP_PATHS,
  RAGIC_WORK_ORDER_MOVEMENT_PATH,
  RAGIC_SYNC_PAGE_SIZE,
  SOURCE_FIELD_MAP_PART_VERSIONS,
  SOURCE_FIELD_MAP_INVENTORY,
  SOURCE_FIELD_MAP_INVENTORY_LOTS,
  SOURCE_FIELD_MAP_ORDERS,
  SOURCE_FIELD_MAP_FORECASTS,
  SOURCE_FIELD_MAP_WORK_ORDERS,
  SOURCE_FIELD_MAP_WORK_ORDER_BOM,
  SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS,
  SOURCE_FIELD_MAP_PRODUCTION_PLANS,
  SOURCE_FIELD_MAP_PURCHASE_ORDERS,
  getSyncProjectedFields,
  getSyncFilters,
} from './field-maps';
import {
  MRP_AVAILABLE_INVENTORY_QUALITIES,
  normalizeInventoryLot,
} from './inventory-snapshot';
import {
  classifyWorkOrderMaterialUsageWarning,
  workOrderMaterialUsageWarningWhere,
  type WorkOrderMaterialUsageWarningLevel,
} from '../mrp/work-order-material-anomaly';
import { ORDER_DEMAND_CONTRACT_V2 } from '../mrp/order-demand-contract';

export type SyncStep =
  | 'part_versions'
  | 'inventory'
  | 'inventory_lots'
  | 'orders'
  | 'forecasts'
  | 'work_orders'
  | 'work_order_bom'
  | 'production_plans'
  | 'purchase_orders';

/** Human-readable labels for each sync step */
export const SYNC_STEP_LABELS: Record<SyncStep, string> = {
  part_versions:   '客戶料號版本',
  inventory:       '料號庫存',
  inventory_lots:  '在庫批號快照',
  orders:          '訂單明細',
  forecasts:       '預示量',
  work_orders:     '工令單',
  work_order_bom:  '工令單BOM',
  production_plans:'生產計畫',
  purchase_orders: '採購單明細',
};

const SYNC_STEPS: SyncStep[] = [
  'part_versions',
  'inventory',
  // Start the longest I/O step early so Form 28/Form 20 overlaps the remaining sync work.
  'work_order_bom',
  'inventory_lots',
  'orders',
  'forecasts',
  'work_orders',
  'production_plans',
  'purchase_orders',
];

/** Progress info stored per step in stepStatus JSON */
export interface StepProgress {
  status: 'pending' | 'fetching' | 'inserting' | 'done' | 'error' | 'skipped';
  label: string;
  /** Expected record count (from last run) */
  expected?: number;
  /** Records fetched so far (updates during pagination) */
  fetched?: number;
  /** Records inserted */
  inserted?: number;
  /** Step duration in ms */
  elapsed?: number;
  /** Error message */
  error?: string;
  /** Detailed API status for UI display */
  apiStatus?: string;
  warningCount?: number;
  warningMessage?: string;
  warningItems?: Array<WorkOrderBomWarningItem | InventoryLotWarningItem>;
  detailTiming?: Record<string, number>;
}

const WORK_ORDER_BOM_DETAIL_TIMING_KEYS = [
  'work_order_bom_form28_fetch',
  'work_order_bom_form28_insert',
  'work_order_bom_form20_fetch',
  'work_order_bom_ledger_resolve',
  'work_order_bom_movement_insert',
  'work_order_bom_summary_update',
] as const;

type WorkOrderBomDetailTimingKey = typeof WORK_ORDER_BOM_DETAIL_TIMING_KEYS[number];

type WorkOrderBomTimingRecorder = (
  key: WorkOrderBomDetailTimingKey,
  elapsedMs: number,
) => void;

export interface WorkOrderBomWarningItem {
  ragicRecordId: string | null;
  woNumber: string | null;
  componentNo: string | null;
  plannedUsage: number;
  unit: string | null;
  sourceType: string | null;
  processCode: string | null;
  level: WorkOrderMaterialUsageWarningLevel;
  reason: string | null;
}


export interface InventoryLotWarningItem {
  ragicRecordId: string;
  lotNo: string | null;
  erpPartNo: string;
  stockPc: number;
  stockKg: number;
  unitWeightG: number | null;
  expectedStockPc: number | null;
  stockPcDiff: number | null;
}

// ─── Stop / Pause Signal ───────────────────────────────────────
// In-memory map keyed by runId. Checked between steps.
type RunSignal = 'stop' | 'pause' | null;
const runSignals = new Map<number, RunSignal>();

// For pause: a resolve callback the engine awaits
const pauseResolvers = new Map<number, () => void>();

/** Send a signal to a running sync */
export function sendRunSignal(runId: number, signal: 'stop' | 'pause' | 'resume') {
  if (signal === 'resume') {
    runSignals.set(runId, null);
    const resolver = pauseResolvers.get(runId);
    if (resolver) {
      resolver();
      pauseResolvers.delete(runId);
    }
  } else {
    runSignals.set(runId, signal);
    // If paused and now stopping, also resolve the pause so the loop can exit
    if (signal === 'stop') {
      const resolver = pauseResolvers.get(runId);
      if (resolver) {
        resolver();
        pauseResolvers.delete(runId);
      }
    }
  }
}

/** Check signal; throws on stop, awaits on pause */
export async function checkSignal(runId: number): Promise<void> {
  const sig = runSignals.get(runId);
  if (sig === 'stop') {
    runSignals.delete(runId);
    throw new SyncStoppedError();
  }
  if (sig === 'pause') {
    // Wait until resumed or stopped
    await new Promise<void>((resolve) => {
      pauseResolvers.set(runId, resolve);
    });
    // After resume, check again in case it was a stop
    const newSig = runSignals.get(runId);
    if (newSig === 'stop') {
      runSignals.delete(runId);
      throw new SyncStoppedError();
    }
  }
}

export class SyncStoppedError extends Error {
  constructor() { super('MRP run stopped by user'); this.name = 'SyncStoppedError'; }
}

// ─── Helpers ────────────────────────────────────────────────────

function mapRecord(
  record: RagicRecord,
  fieldMap: Record<string, string>,
): Record<string, string | number | boolean | null> {
  const mapped: Record<string, string | number | boolean | null> = {};
  for (const [eid, colName] of Object.entries(fieldMap)) {
    const raw = record[eid];
    if (raw !== undefined && raw !== '') {
      mapped[colName] = raw;
    }
  }
  return mapped;
}

export function parseNum(val: string | undefined | null): number {
  if (!val || val === '') return 0;
  const cleaned = String(val).replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parseNullableNum(val: unknown): number | null {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const parsed = Number.parseFloat(String(val).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(val: string | undefined | null): Date | null {
  if (!val || val === '') return null;
  const d = new Date(val.replace(/\//g, '-'));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Get expected record counts from the last successful run's syncCounts
 */
async function getExpectedCounts(): Promise<Record<string, number>> {
  const lastRun = await prisma.mrpRun.findFirst({
    where: { status: { in: [MRP_RUN_STATUS.COMPLETED, MRP_RUN_STATUS.SYNCED] } },
    orderBy: { createdAt: 'desc' },
    select: { syncCounts: true },
  });
  return (lastRun?.syncCounts as Record<string, number>) || {};
}

// ─── Main Sync ──────────────────────────────────────────────────

// Delete staging rows for a single step+run so a resumed run can re-insert
// from a clean slate without colliding with rows from the interrupted attempt.
async function clearStagingForStep(runId: number, step: SyncStep): Promise<void> {
  switch (step) {
    case 'part_versions':    await prisma.stagingPartVersion.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'inventory':        await prisma.stagingInventory.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'inventory_lots':   await prisma.stagingInventoryLot.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'orders':           await prisma.stagingOrder.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'forecasts':        await prisma.stagingForecast.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'work_orders':      await prisma.stagingWorkOrder.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'work_order_bom':
      await prisma.stagingWorkOrderMaterialMovement.deleteMany({ where: { mrpRunId: runId } });
      await prisma.stagingWorkOrderBom.deleteMany({ where: { mrpRunId: runId } });
      return;
    case 'production_plans': await prisma.stagingProductionPlan.deleteMany({ where: { mrpRunId: runId } }); return;
    case 'purchase_orders':  await prisma.stagingPurchaseOrder.deleteMany({ where: { mrpRunId: runId } }); return;
  }
}

export interface RunSyncOptions {
  /** When set, reuses an existing mrp_run, skips steps already 'done', and retries the rest. */
  resumeRunId?: number;
  /**
   * A fresh mrp_run record already created up-front by the orchestrator (its
   * existence is the concurrency lock). When set, runSync populates this
   * record instead of creating a new one. Ignored if `resumeRunId` is set.
   */
  runId?: number;
}

export async function runSync(createdBy?: string, opts?: RunSyncOptions): Promise<{
  runId: number;
  versionCode: string;
  counts: Record<string, number>;
}> {
  const syncWallStart = Date.now();
  const resumeRunId = opts?.resumeRunId;
  const now = new Date();

  // Get WHERE filters matching original Ragic JS logic
  const monthStart = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/01`;
  const filters = getSyncFilters(monthStart);

  let run: { id: number; versionCode: string };
  let stepProgress: Record<string, StepProgress>;
  const counts: Record<string, number> = {};
  let stepTiming: Record<string, number> = {};
  let syncWallBeforeAttempt = 0;
  let reconcileStartedAt: number | null = null;
  let expectedCounts: Record<string, number>;

  if (resumeRunId) {
    const existing = await prisma.mrpRun.findUnique({ where: { id: resumeRunId } });
    if (!existing) throw new Error(`Cannot resume: run #${resumeRunId} not found`);
    if (existing.status === 'completed') {
      throw new Error(`Cannot resume run #${resumeRunId}: already completed`);
    }

    run = { id: existing.id, versionCode: existing.versionCode };
    stepProgress = (existing.stepStatus as unknown as Record<string, StepProgress>) || {};
    Object.assign(counts, (existing.syncCounts as Record<string, number>) || {});
    Object.assign(stepTiming, (existing.stepTiming as Record<string, number>) || {});
    syncWallBeforeAttempt = Number.isFinite(stepTiming.sync_wall) && stepTiming.sync_wall > 0
      ? stepTiming.sync_wall
      : 0;
    expectedCounts = await getExpectedCounts();

    runLog.info(`\n${'='.repeat(60)}`);
    runLog.info(`[Sync] ↻ Resuming run #${run.id} ${run.versionCode}`);
    runLog.info(`${'='.repeat(60)}`);
    runLog.info(`[Sync] Month start for filters: ${monthStart}`);

    // Reset non-done steps back to pending and wipe their partial staging rows.
    // 'done' steps are kept as-is (skipped on the next loop pass).
    let resumeFromIdx = -1;
    for (let i = 0; i < SYNC_STEPS.length; i++) {
      const step = SYNC_STEPS[i];
      const sp = stepProgress[step];
      const isDone = sp?.status === 'done';
      if (!isDone) {
        if (resumeFromIdx === -1) resumeFromIdx = i;
        await clearStagingForStep(run.id, step);
        stepProgress[step] = {
          status: 'pending',
          label: SYNC_STEP_LABELS[step],
          expected: sp?.expected ?? expectedCounts[step] ?? undefined,
        };
        // Drop any partial counts/timing for this step so they're recomputed cleanly
        delete counts[step];
        delete stepTiming[step];
        if (step === 'work_order_bom') {
          for (const key of WORK_ORDER_BOM_DETAIL_TIMING_KEYS) delete stepTiming[key];
        }
      } else {
        // Seed counts/timing from the prior attempt's stepStatus so the final
        // syncCounts blob reflects all 8 tables, not just the resumed ones
        // (the failed run never wrote partial syncCounts).
        if (typeof sp?.inserted === 'number') counts[step] = sp.inserted;
        if (typeof sp?.elapsed === 'number') stepTiming[step] = sp.elapsed;
        runLog.info(`[Sync] ⊙ ${step} already complete (${sp?.inserted ?? 0} rows) — skipping`);
      }
    }

    if (resumeFromIdx === -1) {
      runLog.info(`[Sync] All steps already done — nothing to resume`);
    } else {
      runLog.info(`[Sync] Resuming from step ${resumeFromIdx + 1}/${SYNC_STEPS.length}: ${SYNC_STEPS[resumeFromIdx]}`);
    }

    await prisma.mrpRun.update({
      where: { id: run.id },
      data: {
        status: MRP_RUN_STATUS.SYNCING,
        errorMessage: null,
        completedAt: null,
        stepStatus: stepProgress as object,
        syncCounts: counts,
        stepTiming,
      },
    });
  } else {
    runLog.info(`\n${'='.repeat(60)}`);
    runLog.info(`[Sync] Starting MRP sync`);
    runLog.info(`${'='.repeat(60)}`);
    runLog.info(`[Sync] Month start for filters: ${monthStart}`);

    expectedCounts = await getExpectedCounts();
    const totalExpected = Object.values(expectedCounts).reduce((a, b) => a + (b || 0), 0);
    if (totalExpected > 0) {
      runLog.info(`[Sync] Expected totals from last run: ${totalExpected} records across ${Object.keys(expectedCounts).length} tables`);
    } else {
      runLog.info(`[Sync] First run — no expected counts available`);
    }

    stepProgress = {};
    for (const step of SYNC_STEPS) {
      stepProgress[step] = {
        status: 'pending',
        label: SYNC_STEP_LABELS[step],
        expected: expectedCounts[step] || undefined,
      };
    }
    stepProgress['_meta'] = {
      status: 'pending',
      label: '',
      expected: totalExpected || undefined,
    } as StepProgress;

    if (opts?.runId) {
      // 紀錄已由 orchestrator 的 withRunStartLock 原子地建好（status 已 active，
      // 這筆紀錄即並行鎖）。這裡只把 fresh 的 stepProgress 寫進去，不再 create。
      const updated = await prisma.mrpRun.update({
        where: { id: opts.runId },
        data: { stepStatus: stepProgress as object },
      });
      run = { id: updated.id, versionCode: updated.versionCode };
      runLog.info(`[Sync] Using pre-created run #${run.id} ${run.versionCode}`);
    } else {
      const versionCode = `MRP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      const created = await prisma.mrpRun.create({
        data: {
          versionCode,
          runDate: now,
          status: MRP_RUN_STATUS.SYNCING,
          orderDemandContractVersion: ORDER_DEMAND_CONTRACT_V2,
          createdBy: createdBy || 'system',
          stepStatus: stepProgress as object,
        },
      });
      run = { id: created.id, versionCode: created.versionCode };
      runLog.info(`[Sync] Created run #${run.id} ${run.versionCode}`);
    }
  }

  const saveProgress = async (extraData?: Record<string, unknown>) => {
    await prisma.mrpRun.update({
      where: { id: run.id },
      data: { stepStatus: stepProgress as object, ...extraData },
    });
  };

  // Wrap the entire pipeline inside the per-run logging context so every
  // runLog.* call (including those nested in fetchRagicListing's heartbeat
  // and retry loops) is captured and periodically flushed to mrp_run.logs.
  return withRunLogging(run.id, async () => {
  try {
    // Worker pool 跑 SYNC_STEPS。Ragic doc 建議 sequential，5 req/sec 是 review 門檻；
    // 我們維持並發 2，與 verify_plan_qty 並發 2 疊加後瞬時最多 ~4 req/sec，留 1 buffer。
    // env SYNC_CONCURRENCY 可調（部署後若實測 Ragic 沒抗議再往上加）。
    const concurrency = Math.max(1, Number(process.env.SYNC_CONCURRENCY) || 2);

    const runSingleStep = async (step: SyncStep): Promise<void> => {
      const stepIdx = SYNC_STEPS.indexOf(step) + 1;

      // Skip steps already completed in a previous (interrupted) run when resuming.
      if (stepProgress[step]?.status === 'done') return;

      // ── Check stop/pause before each step ──
      await checkSignal(run.id);

      const stepStart = Date.now();
      const expectedForStep = expectedCounts[step] || 0;
      const detailTiming: Record<string, number> = {};
      const recordWorkOrderBomTiming: WorkOrderBomTimingRecorder = (key, elapsedMs) => {
        stepTiming[key] = elapsedMs;
        detailTiming[key] = elapsedMs;
        stepProgress[step] = { ...stepProgress[step], detailTiming };
      };

      runLog.info(`\n[Sync] ── Step ${stepIdx}/${SYNC_STEPS.length}: ${SYNC_STEP_LABELS[step]} (${step}) ──`);
      if (expectedForStep > 0) {
        runLog.info(`[Sync] Expected: ~${expectedForStep} records`);
      }

      stepProgress[step] = {
        status: 'fetching',
        label: SYNC_STEP_LABELS[step],
        expected: expectedForStep || undefined,
        fetched: 0,
        apiStatus: 'calling Ragic API...',
      };
      await saveProgress();

      const path = RAGIC_ERP_PATHS[step];
      const filterSets = filters[step] || [{ where: [] }];
      runLog.info(`[Sync] Fetching from ERP source: ${path} (${filterSets.length} filter set(s))`);

      // part_versions / inventory need fields omitted by listing mode. Listing
      // responses are also narrowed to staging fields; full work-order BOM
      // responses stay unprojected because remaining-use calculation needs
      // their native issue-detail subtable.
      const defaultUseListing = step !== 'part_versions' && step !== 'inventory';

      const allRecords = new Map<string, RagicRecord>();
      let stepFetchElapsedMs = 0;
      for (let fi = 0; fi < filterSets.length; fi++) {
        const fs = filterSets[fi];
        const useListing = fs.listing ?? defaultUseListing;
        const projectedFields = getSyncProjectedFields(step, useListing);
        const filterDesc = fs.where.map(w => `${w.fieldId}${w.operator}${w.value}`).join(' & ') || '(no filter)';
        const responseMode = projectedFields
          ? ` (projected ${projectedFields.length} fields)`
          : useListing
            ? ''
            : ' (listing=false)';
        runLog.info(`[Sync]   filter set ${fi + 1}/${filterSets.length}: ${filterDesc}${responseMode}`);

        stepProgress[step] = {
          ...stepProgress[step],
          apiStatus: `Ragic API: filter ${fi + 1}/${filterSets.length} → ${path}${useListing ? '' : ' (full)'}`,
        };
        await saveProgress();

        const filterStart = Date.now();
        const whereClause = fs.where.map(w => ({
          fieldId: w.fieldId,
          operator: w.operator as 'eq' | 'gte' | 'lt' | 'like' | 'regex' | 'lte' | 'gt',
          value: w.value,
        }));
        let pageRecords: RagicRecord[];
        try {
          pageRecords = await fetchRagicListing({
            path,
            limit: RAGIC_SYNC_PAGE_SIZE,
            where: whereClause,
            listing: useListing,
            includeSubtables: !useListing && projectedFields ? false : undefined,
            fetchDomainIds: projectedFields,
          });
        } catch (err) {
          const filterMs = Date.now() - filterStart;
          stepFetchElapsedMs += filterMs;
          if (step === 'work_order_bom') {
            recordWorkOrderBomTiming('work_order_bom_form28_fetch', stepFetchElapsedMs);
          }
          const elapsedSec = (filterMs / 1000).toFixed(1);
          const msg = err instanceof Error ? err.message : String(err);
          runLog.error(`[Sync] ✗ ${step} filter ${fi + 1} failed after ${elapsedSec}s: ${msg}`);
          throw new Error(`${step} (filter ${fi + 1}/${filterSets.length}, ${path}, ${filterDesc}) failed after ${elapsedSec}s: ${msg}`);
        }
        for (const rec of pageRecords) {
          allRecords.set(rec._ragic_id, rec);
        }
        const filterMs = Date.now() - filterStart;
        stepFetchElapsedMs += filterMs;
        runLog.info(`[Sync]   → ${pageRecords.length} records in ${(filterMs / 1000).toFixed(1)}s (total unique: ${allRecords.size})`);
      }
      if (step === 'work_order_bom') {
        recordWorkOrderBomTiming('work_order_bom_form28_fetch', stepFetchElapsedMs);
      }
      const records = Array.from(allRecords.values());
      const fetched = records.length;

      stepProgress[step] = {
        ...stepProgress[step],
        fetched,
        apiStatus: `fetched ${fetched} records`,
      };
      await saveProgress();

      runLog.info(`[Sync] Fetched ${fetched} records from Ragic`);

      await checkSignal(run.id);

      stepProgress[step] = {
        ...stepProgress[step],
        status: 'inserting',
        apiStatus: `inserting ${fetched} rows into DB...`,
      };
      await saveProgress();

      runLog.info(`[Sync] Inserting ${fetched} records into DB (${step})...`);
      const insertStart = Date.now();
      let inserted = 0;
      try {
        inserted = records.length > 0
          ? await batchInsert(run.id, step, records, recordWorkOrderBomTiming)
          : 0;
      } catch (err) {
        const elapsedSec = ((Date.now() - insertStart) / 1000).toFixed(1);
        const msg = err instanceof Error ? err.message : String(err);
        runLog.error(`[Sync] ✗ ${step} DB insert failed after ${elapsedSec}s: ${msg}`);
        throw new Error(`${step} DB insert (${fetched} rows) failed after ${elapsedSec}s: ${msg}`);
      }
      const insertMs = Date.now() - insertStart;
      runLog.info(
        step === 'work_order_bom'
          ? `[Sync]   work_order_bom staging and movement enrichment done in ${(insertMs / 1000).toFixed(1)}s`
          : `[Sync]   DB insert done in ${(insertMs / 1000).toFixed(1)}s`,
      );

      let warningCount = 0;
      let warningMessage: string | undefined;
      let warningItems: Array<WorkOrderBomWarningItem | InventoryLotWarningItem> | undefined;
      if (step === 'inventory_lots') {
        const where = {
          mrpRunId: run.id,
          quantityAnomaly: true,
          qualityStatus: { in: [...MRP_AVAILABLE_INVENTORY_QUALITIES] },
        };
        const [count, rows] = await Promise.all([
          prisma.stagingInventoryLot.count({ where }),
          prisma.stagingInventoryLot.findMany({
            where,
            orderBy: [{ erpPartNo: 'asc' }, { lotNo: 'asc' }],
            take: 50,
            select: {
              ragicRecordId: true,
              lotNo: true,
              erpPartNo: true,
              stockPc: true,
              stockKg: true,
              unitWeightG: true,
              expectedStockPc: true,
              stockPcDiff: true,
            },
          }),
        ]);
        warningCount = count;
        warningItems = rows.map((row) => ({
          ragicRecordId: row.ragicRecordId,
          lotNo: row.lotNo,
          erpPartNo: row.erpPartNo,
          stockPc: Number(row.stockPc) || 0,
          stockKg: Number(row.stockKg) || 0,
          unitWeightG: row.unitWeightG == null ? null : Number(row.unitWeightG),
          expectedStockPc: row.expectedStockPc == null ? null : Number(row.expectedStockPc),
          stockPcDiff: row.stockPcDiff == null ? null : Number(row.stockPcDiff),
        }));
        if (warningCount > 0) {
          warningMessage = `${warningCount} 筆可用在庫批號的 pc 與 kg／單位重不一致，MRP 保留 Ragic 原值並列為資料異常`;
          runLog.warn(`[Sync] inventory_lots has ${warningCount} available lots with quantity anomalies; original Ragic stock_pc preserved`);
        }
      }

      const elapsed = Date.now() - stepStart;
      runLog.info(`[Sync] ✓ ${step} done: ${inserted} rows in ${(elapsed / 1000).toFixed(1)}s`);
      stepProgress[step] = {
        status: 'done',
        label: SYNC_STEP_LABELS[step],
        expected: expectedForStep || undefined,
        fetched,
        inserted,
        elapsed,
        apiStatus: 'complete',
        warningCount: warningCount || undefined,
        warningMessage,
        warningItems,
        detailTiming: Object.keys(detailTiming).length > 0 ? detailTiming : undefined,
      };
      counts[step] = inserted;
      if (step === 'inventory_lots') counts.inventory_lot_validation_v1 = 1;
      stepTiming[step] = elapsed;
      await saveProgress();
    };

    // 任一 worker 拿任一 step 跑完就搶下一個。任一 step throw → aborted 旗標阻止其他
    // worker shift 新 step；已經 in-flight 的工作必須全部 settle，外層才能把 run 標成
    // error/stopped 並開放 Resume，避免舊 worker 在下一次 attempt 開始後繼續寫入。
    const queue: SyncStep[] = [...SYNC_STEPS];
    let aborted = false;
    const workers = Array.from({ length: concurrency }, async () => {
      while (!aborted && queue.length > 0) {
        const step = queue.shift();
        if (!step) break;
        try {
          await runSingleStep(step);
        } catch (err) {
          aborted = true;
          throw err;
        }
      }
    });
    await settleAllOrThrow(workers);

    await checkSignal(run.id);
    const unlinkedBomCount = await reconcileWorkOrderBomLinks(run.id);
    runLog.info(`[Sync] Excluded ${unlinkedBomCount} BOM rows without a linked open work order`);
    let warningMessage: string | undefined;
    const warningWhere = workOrderMaterialUsageWarningWhere(run.id);
    const [count, rows] = await Promise.all([
      prisma.stagingWorkOrderBom.count({
        where: warningWhere,
      }),
      prisma.stagingWorkOrderBom.findMany({
        where: warningWhere,
        orderBy: [{ woNumber: 'asc' }, { componentNo: 'asc' }],
        take: 50,
        select: {
          ragicRecordId: true,
          woNumber: true,
          componentNo: true,
          minUsage: true,
          unit: true,
          sourceType: true,
          processCode: true,
          issuedQtyState: true,
          issuedQtyError: true,
          movementState: true,
          movementError: true,
        },
      }),
    ]);
    const warningCount = count;
    const warningItems = rows.flatMap((row) => {
      const warning = classifyWorkOrderMaterialUsageWarning(row);
      return warning ? [{
        ragicRecordId: row.ragicRecordId,
        woNumber: row.woNumber,
        componentNo: row.componentNo,
        plannedUsage: Number(row.minUsage) || 0,
        unit: row.unit,
        sourceType: row.sourceType,
        processCode: row.processCode,
        level: warning.level,
        reason: warning.reason,
      }] : [];
    });
    if (warningCount > 0) {
      warningMessage = `${warningCount} 筆工令用料資料異常；無法確認者已排除，主子表不一致者仍依領料子表計算`;
      runLog.warn(`[Sync] work_order_bom has ${warningCount} blocking or review usage warnings`);
    }
    stepProgress.work_order_bom = {
      ...stepProgress.work_order_bom,
      warningCount: warningCount || undefined,
      warningMessage,
      warningItems,
    };

    const statusPayload = stepProgress as unknown as Record<string, unknown>;
    statusPayload._phase = 'reconciling_inventory';
    statusPayload._inventoryReconcile = {
      status: 'inserting',
      label: '庫存批號快照聚合',
      apiStatus: 'reconciling inventory lots...',
    } satisfies StepProgress;
    await saveProgress();

    runLog.info('[Sync] Reconciling inventory lot snapshot...');
    reconcileStartedAt = Date.now();
    const reconcile = await reconcileInventorySnapshot(run.id);
    stepTiming.inventory_reconcile = reconcile.elapsedMs;
    statusPayload._inventoryReconcile = {
      status: 'done',
      label: '庫存批號快照聚合',
      inserted: reconcile.updatedRows,
      elapsed: reconcile.elapsedMs,
      apiStatus: `complete (${reconcile.updatedRows} changed)`,
    } satisfies StepProgress;

    const totalSynced = Object.values(counts).reduce((a, b) => a + b, 0);
    const syncAttemptWallMs = Date.now() - syncWallStart;
    stepTiming = accumulateSyncWallTiming(
      { ...stepTiming, sync_wall: syncWallBeforeAttempt },
      syncAttemptWallMs,
    );
    const syncWallMs = stepTiming.sync_wall;
    runLog.info(`[Sync] Inventory snapshot reconciled: ${reconcile.updatedRows} changed rows in ${(reconcile.elapsedMs / 1000).toFixed(1)}s`);
    runLog.info(`\n${'='.repeat(60)}`);
    runLog.info(`[Sync] ✓ All steps complete: ${totalSynced} total records in ${(syncWallMs / 1000).toFixed(1)}s wall time`);
    runLog.info(`${'='.repeat(60)}\n`);

    await saveProgress({
      status: MRP_RUN_STATUS.SYNCED,
      syncCounts: counts,
      stepTiming,
    });

    // Cleanup signal
    runSignals.delete(run.id);

    return { runId: run.id, versionCode: run.versionCode, counts };
  } catch (err) {
    const isStopped = err instanceof SyncStoppedError;
    stepTiming = accumulateSyncWallTiming(
      { ...stepTiming, sync_wall: syncWallBeforeAttempt },
      Date.now() - syncWallStart,
    );

    // Mark remaining steps as skipped if stopped
    if (isStopped) {
      runLog.info(`\n[Sync] ■ Run stopped by user`);
      for (const step of SYNC_STEPS) {
        if (stepProgress[step].status === 'pending') {
          stepProgress[step].status = 'skipped';
        }
        if (stepProgress[step].status === 'fetching' || stepProgress[step].status === 'inserting') {
          stepProgress[step].status = 'skipped';
          stepProgress[step].apiStatus = 'stopped';
        }
      }
    } else {
      runLog.error(`\n[Sync] ✗ Error:`, err instanceof Error ? err.message : err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const reconcileProgress = stepProgress._inventoryReconcile;
      if (reconcileProgress?.status === 'inserting') {
        const elapsed = reconcileStartedAt === null
          ? undefined
          : Date.now() - reconcileStartedAt;
        reconcileProgress.status = 'error';
        reconcileProgress.error = errorMessage;
        reconcileProgress.apiStatus = 'error';
        reconcileProgress.elapsed = elapsed;
        if (elapsed !== undefined) stepTiming.inventory_reconcile = elapsed;
      } else {
        const currentStep = SYNC_STEPS.find(s =>
          stepProgress[s].status === 'fetching' || stepProgress[s].status === 'inserting'
        );
        if (currentStep) {
          stepProgress[currentStep].status = 'error';
          stepProgress[currentStep].error = errorMessage;
          stepProgress[currentStep].apiStatus = 'error';
        }
      }
    }

    await saveProgress({
      status: isStopped ? MRP_RUN_STATUS.STOPPED : MRP_RUN_STATUS.ERROR,
      errorMessage: err instanceof Error ? err.message : String(err),
      syncCounts: counts,
      stepTiming,
    });

    runSignals.delete(run.id);
    throw err;
  }
  });
}

// ─── Batch Insert (createMany) ──────────────────────────────────

async function batchInsert(
  runId: number,
  step: SyncStep,
  records: RagicRecord[],
  recordTiming: WorkOrderBomTimingRecorder,
): Promise<number> {
  switch (step) {
    case 'part_versions':    return batchPartVersions(runId, records);
    case 'inventory':        return batchInventory(runId, records);
    case 'inventory_lots':   return batchInventoryLots(runId, records);
    case 'orders':           return batchOrders(runId, records);
    case 'forecasts':        return batchForecasts(runId, records);
    case 'work_orders':      return batchWorkOrders(runId, records);
    case 'work_order_bom':   return batchWorkOrderBom(runId, records, recordTiming);
    case 'production_plans': return batchProductionPlans(runId, records);
    case 'purchase_orders':  return batchPurchaseOrders(runId, records);
    default: return 0;
  }
}

// Normalize part_version like Ragic d4/21 (`.trim()`) plus CRLF→LF.
// `.trim()` strips ASCII whitespace including tabs, newlines, and carriage returns
// so trailing `\t` or `\r\n` from Ragic exports are removed and inter-table joins line up.
function normPv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  return s === '' ? null : s;
}

// Chunk createMany inserts so a single 3000-row table doesn't pin ~hundreds of MB
// in Prisma's payload buffer all at once. Helps stay under PM2's max_memory_restart
// and shortens each call so SIGINT mid-insert loses less work.
const CREATE_MANY_CHUNK = 500;

async function chunkedCreateMany<T>(
  data: T[],
  insert: (chunk: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < data.length; i += CREATE_MANY_CHUNK) {
    const { count } = await insert(data.slice(i, i + CREATE_MANY_CHUNK));
    total += count;
  }
  return total;
}

// A 300-lot Form 20 filter stays near 5 KB with the current lot format and halves request count.
const WORK_ORDER_MOVEMENT_QUERY_CHUNK = 300;
const WORK_ORDER_MOVEMENT_UPDATE_CHUNK = 400;

function normalizeMovementIdentity(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function escapeRagicRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseOptionalNum(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function workOrderIssueRows(record: RagicRecord): Array<Record<string, unknown>> {
  const issueBucket = (record as unknown as Record<string, unknown>)['_subtable_1006278'];
  return issueBucket && typeof issueBucket === 'object' && !Array.isArray(issueBucket)
    ? Object.values(issueBucket as Record<string, unknown>).filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
}

function ledgerErrorToIssuedQtyError(
  error: WorkOrderLedgerError | null,
): IssuedQtyError | null {
  if (error === 'ledger_attribution_ambiguous') return 'movement_bom_mapping_ambiguous';
  if (error === 'ledger_balance_missing') return 'movement_issue_balance_missing';
  if (error === 'ledger_handoff_incomplete') return 'movement_lot_handoff_incomplete';
  if (error === 'ledger_issue_not_found') return 'movement_issue_not_found';
  return null;
}

async function updateWorkOrderBomMovementSummaries(
  updates: Array<{
    id: number;
    grossIssuedQty: number | null;
    consumedQty: number | null;
    returnedQty: number | null;
    netIssuedQty: number | null;
    reservedQty: number | null;
    remainingUsage: number | null;
    overIssuedQty: number | null;
    issuedQtyState: IssuedQtyState;
    movementState: string;
    movementDetailCount: number;
    movementError: IssuedQtyError | null;
  }>,
): Promise<void> {
  for (let index = 0; index < updates.length; index += WORK_ORDER_MOVEMENT_UPDATE_CHUNK) {
    const chunk = updates.slice(index, index + WORK_ORDER_MOVEMENT_UPDATE_CHUNK);
    const values = chunk.map((row) => Prisma.sql`(
      CAST(${row.id} AS INTEGER),
      CAST(${row.grossIssuedQty} AS NUMERIC),
      CAST(${row.consumedQty} AS NUMERIC),
      CAST(${row.returnedQty} AS NUMERIC),
      CAST(${row.netIssuedQty} AS NUMERIC),
      CAST(${row.reservedQty} AS NUMERIC),
      CAST(${row.remainingUsage} AS NUMERIC),
      CAST(${row.overIssuedQty} AS NUMERIC),
      CAST(${row.issuedQtyState} AS TEXT),
      CAST(${row.movementState} AS TEXT),
      CAST(${row.movementDetailCount} AS INTEGER),
      CAST(${row.movementError} AS TEXT)
    )`);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE staging.work_order_bom AS bom
      SET gross_issued_qty = snapshot.gross_issued_qty,
          consumed_qty = snapshot.consumed_qty,
          returned_qty = snapshot.returned_qty,
          net_issued_qty = snapshot.net_issued_qty,
          reserved_qty = snapshot.reserved_qty,
          remaining_usage = snapshot.remaining_usage,
          over_issued_qty = snapshot.over_issued_qty,
          issued_qty_state = snapshot.issued_qty_state,
          movement_state = snapshot.movement_state,
          movement_detail_count = snapshot.movement_detail_count,
          movement_error = snapshot.movement_error
      FROM (
        VALUES ${Prisma.join(values)}
      ) AS snapshot(
        id,
        gross_issued_qty,
        consumed_qty,
        returned_qty,
        net_issued_qty,
        reserved_qty,
        remaining_usage,
        over_issued_qty,
        issued_qty_state,
        movement_state,
        movement_detail_count,
        movement_error
      )
      WHERE bom.id = snapshot.id
    `);
  }
}

async function enrichWorkOrderBomMovementSnapshot(
  runId: number,
  allocations: WorkOrderIssueAllocation[],
  recordTiming: WorkOrderBomTimingRecorder,
): Promise<void> {
  const bomRows = await prisma.stagingWorkOrderBom.findMany({
    where: { mrpRunId: runId },
    select: {
      id: true,
      ragicRecordId: true,
      woNumber: true,
      componentNo: true,
      unit: true,
      minUsage: true,
      issuedQty: true,
      remainingUsage: true,
      issuedQtyState: true,
      issuedDetailCount: true,
      issuedQtyError: true,
    },
  });
  const inventoryLots = [...new Set(
    allocations
      .map((allocation) => allocation.inventoryLotNo.trim())
      .filter(Boolean),
  )];

  const allowedInventoryLots = new Set(inventoryLots.map(normalizeMovementIdentity));
  const records = new Map<string, RagicRecord>();
  const form20FetchStartedAt = Date.now();
  try {
    const chunks = Array.from(
      { length: Math.ceil(inventoryLots.length / WORK_ORDER_MOVEMENT_QUERY_CHUNK) },
      (_, index) => inventoryLots.slice(
        index * WORK_ORDER_MOVEMENT_QUERY_CHUNK,
        (index + 1) * WORK_ORDER_MOVEMENT_QUERY_CHUNK,
      ),
    );
    const form20Concurrency = boundedConcurrency(
      process.env.FORM20_FETCH_CONCURRENCY,
      2,
      2,
    );
    let completedLots = 0;
    let fetchedRecords = 0;
    const pages = await mapWithBoundedConcurrency(
      chunks,
      form20Concurrency,
      async (chunk) => {
        await checkSignal(runId);
        const regex = `^(?:${chunk.map(escapeRagicRegex).join('|')})$`;
        const page = await fetchRagicListing({
          path: RAGIC_WORK_ORDER_MOVEMENT_PATH,
          limit: RAGIC_SYNC_PAGE_SIZE,
          listing: true,
          fetchDomainIds: Object.keys(SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS),
          where: [{ fieldId: '1005418', operator: 'regex', value: regex }],
        });
        completedLots += chunk.length;
        fetchedRecords += page.length;
        runLog.info(
          `[Sync] Form 20 lot ledger ${completedLots}/${inventoryLots.length} lots → ${fetchedRecords} fetched records (concurrency ${form20Concurrency})`,
        );
        return page;
      },
    );
    for (const page of pages) {
      for (const record of page) records.set(record._ragic_id, record);
    }
  } catch (error) {
    recordTiming('work_order_bom_form20_fetch', Date.now() - form20FetchStartedAt);
    const fallbackUpdateStartedAt = Date.now();
    await prisma.stagingWorkOrderBom.updateMany({
      where: { mrpRunId: runId },
      data: {
        movementState: 'fallback',
        movementError: 'movement_source_unavailable',
      },
    });
    recordTiming('work_order_bom_summary_update', Date.now() - fallbackUpdateStartedAt);
    runLog.warn(
      `[Sync] Form 20 movement snapshot unavailable; retaining Form 28 fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  recordTiming('work_order_bom_form20_fetch', Date.now() - form20FetchStartedAt);

  const ledgerResolveStartedAt = Date.now();
  const ledgerMovements: WorkOrderLedgerMovement[] = [...records.values()].flatMap((record) => {
    const mapped = mapRecord(record, SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS);
    const inventoryLotNo = String(mapped.inventory_lot_no ?? '').trim();
    if (!inventoryLotNo || !allowedInventoryLots.has(normalizeMovementIdentity(inventoryLotNo))) {
      return [];
    }
    return [{
      ragicRecordId: record._ragic_id,
      workOrderNo: mapped.work_order_no ? String(mapped.work_order_no).trim() || null : null,
      bomItemKey: mapped.bom_item_key ? String(mapped.bom_item_key).trim() || null : null,
      inventoryLotNo,
      componentNo: mapped.component_no ? String(mapped.component_no).trim() || null : null,
      movementDate: parseDate(mapped.movement_date as string),
      basisType: mapped.basis_type ? String(mapped.basis_type).trim() || null : null,
      movementType: mapped.movement_type ? String(mapped.movement_type).trim() || null : null,
      inputUnit: mapped.input_unit ? String(mapped.input_unit).trim() || null : null,
      inputQtyPc: parseOptionalNum(mapped.input_qty_pc),
      inputQtyKg: parseOptionalNum(mapped.input_qty_kg),
      movementQtyPc: parseOptionalNum(mapped.movement_qty_pc),
      movementQtyKg: parseOptionalNum(mapped.movement_qty_kg),
    }];
  });
  const resolution = resolveWorkOrderMaterialLedgers({
    allocations,
    movements: ledgerMovements,
  });
  const bomRowsByRagicId = new Map(
    bomRows.flatMap((row) => row.ragicRecordId ? [[row.ragicRecordId, row] as const] : []),
  );
  const attributedMovementsByBomId = new Map<string, WorkOrderLedgerMovement[]>();
  const movementRows = ledgerMovements.flatMap((movement) => {
    const bomRecordId = resolution.attributedBomRecordIds.get(movement.ragicRecordId);
    if (!bomRecordId) return [];
    const bom = bomRowsByRagicId.get(bomRecordId);
    const workOrderNo = String(bom?.woNumber ?? movement.workOrderNo ?? '').trim();
    if (!workOrderNo) return [];

    const attributed = attributedMovementsByBomId.get(bomRecordId) ?? [];
    attributed.push(movement);
    attributedMovementsByBomId.set(bomRecordId, attributed);

    return [{
      mrpRunId: runId,
      ragicRecordId: movement.ragicRecordId,
      workOrderNo,
      bomItemKey: movement.bomItemKey,
      inventoryLotNo: movement.inventoryLotNo,
      componentNo: bom?.componentNo ?? movement.componentNo,
      movementDate: movement.movementDate,
      basisType: movement.basisType,
      movementType: movement.movementType,
      inputUnit: movement.inputUnit,
      inputQtyPc: movement.inputQtyPc,
      inputQtyKg: movement.inputQtyKg,
      movementQtyPc: movement.movementQtyPc,
      movementQtyKg: movement.movementQtyKg,
    }];
  });
  let ledgerResolveMs = Date.now() - ledgerResolveStartedAt;

  const movementInsertStartedAt = Date.now();
  await chunkedCreateMany(
    movementRows,
    (chunk) => prisma.stagingWorkOrderMaterialMovement.createMany({
      data: chunk,
      skipDuplicates: true,
    }),
  );
  recordTiming('work_order_bom_movement_insert', Date.now() - movementInsertStartedAt);

  const summaryBuildStartedAt = Date.now();
  const updates = bomRows.map((row) => {
    const bomRecordId = row.ragicRecordId ?? '';
    const ledgerSummary = resolution.summaries.get(bomRecordId);
    const attributedMovements = attributedMovementsByBomId.get(bomRecordId) ?? [];
    const formUsage: WorkOrderBomUsageResult = {
      issuedQty: row.issuedQty === null ? null : Number(row.issuedQty),
      remainingUsage: row.remainingUsage === null ? null : Number(row.remainingUsage),
      issuedQtyState: row.issuedQtyState as IssuedQtyState,
      issuedDetailCount: row.issuedDetailCount,
      issuedQtyError: row.issuedQtyError as IssuedQtyError | null,
    };
    const ledgerError: WorkOrderLedgerError | null = ledgerSummary?.error
      ?? (
        formUsage.issuedQtyState === 'known' && formUsage.issuedDetailCount > 0
          ? 'ledger_issue_not_found'
          : null
      );
    const result = reconcileWorkOrderBomUsage({
      plannedUsage: Number(row.minUsage) || 0,
      bomUnit: row.unit,
      ledgerIssuedQty: ledgerSummary
        ? ledgerSummary.grossIssuedQty
        : ledgerError
          ? null
          : undefined,
      formUsage,
      movements: attributedMovements,
      movementSourceAvailable: true,
      movementSourceError: ledgerErrorToIssuedQtyError(ledgerError),
    });
    return { id: row.id, ...result };
  });
  ledgerResolveMs += Date.now() - summaryBuildStartedAt;
  recordTiming('work_order_bom_ledger_resolve', ledgerResolveMs);

  const summaryUpdateStartedAt = Date.now();
  await updateWorkOrderBomMovementSummaries(updates);
  recordTiming('work_order_bom_summary_update', Date.now() - summaryUpdateStartedAt);
  runLog.info(
    `[Sync] Form 20 lot ledger examined ${ledgerMovements.length} records, stored ${movementRows.length} attributed records, and reconciled ${updates.length} BOM rows`,
  );
}

async function batchPartVersions(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_PART_VERSIONS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      partVersion: normPv(m.part_version) ?? '',
      erpPartNo: m.erp_part_no ? String(m.erp_part_no).trim() || null : null,
      customerCode: m.customer_code ? String(m.customer_code) : null,
      customerPartNo: m.customer_part_no ? String(m.customer_part_no) : null,
      forgingMachine: m.forging_machine ? String(m.forging_machine) : null,
      firstProcess: m.first_process ? String(m.first_process) : null,
      forgingParent: m.forging_parent ? String(m.forging_parent) : null,
      processBomVersion: m.process_bom_version ? String(m.process_bom_version) : null,
      surfaceTreatment: m.surface_treatment ? String(m.surface_treatment) : null,
      productStatus: m.product_status ? String(m.product_status) : null,
      versionStatus: m.version_status ? String(m.version_status) : null,
      unitWeightG: parseNum(m.unit_weight_g as string),
      mainMaterialKg: parseNum(m.main_material_kg as string),
      targetStockPeriods: parseNum(m.target_stock_periods as string) || null,
      sortGroup: Math.round(parseNum(m.sort_group as string)) || null,
      skipFgInventory: m.skip_fg_inventory === 'Yes' || m.skip_fg_inventory === 'true',
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingPartVersion.createMany({ data: chunk }));
}

export function mapInventoryRecord(
  runId: number,
  record: RagicRecord,
) {
  const mapped = mapRecord(record, SOURCE_FIELD_MAP_INVENTORY);
  const purchaseLeadWeeks = parseNullableNum(mapped.purchase_lead_weeks);
  return {
    mrpRunId: runId,
    ragicRecordId: record._ragic_id,
    erpPartNo: String(mapped.erp_part_no || '').trim(),
    subtypeCode: mapped.subtype_code ? String(mapped.subtype_code) : null,
    itemStatus: mapped.item_status ? String(mapped.item_status) : null,
    goodStockPc: parseNum(mapped.good_stock_pc as string),
    goodStockKg: parseNum(mapped.good_stock_kg as string),
    inStockPc: 0,
    inStockKg: 0,
    wfgStockPc: 0,
    wfgStockKg: 0,
    ye1StockPc: 0,
    ye1StockKg: 0,
    badStockPc: parseNum(mapped.bad_stock_pc as string),
    badStockKg: parseNum(mapped.bad_stock_kg as string),
    unit: null,
    purchaseLeadWeeks: purchaseLeadWeeks ?? 0,
    purchaseLeadWeeksConfigured: purchaseLeadWeeks !== null,
  };
}

async function batchInventory(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((record) => mapInventoryRecord(runId, record));
  return chunkedCreateMany(data, (chunk) => prisma.stagingInventory.createMany({ data: chunk }));
}

async function batchInventoryLots(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.flatMap((record) => {
    const mapped = mapRecord(record, SOURCE_FIELD_MAP_INVENTORY_LOTS);
    const lot = normalizeInventoryLot({
      ragicRecordId: record._ragic_id,
      lotNo: mapped.lot_no,
      erpPartNo: mapped.erp_part_no,
      warehouseCode: mapped.warehouse_code,
      stockStatus: mapped.stock_status,
      qualityStatus: mapped.quality_status,
      stockPc: mapped.stock_pc,
      stockKg: mapped.stock_kg,
      unitWeightG: mapped.unit_weight_g,
      sourceWorkOrderNo: mapped.source_work_order_no,
      sourceWorkOrderType: mapped.source_work_order_type,
    });
    return lot ? [{ mrpRunId: runId, ...lot }] : [];
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingInventoryLot.createMany({
    data: chunk,
    skipDuplicates: true,
  }));
}

export async function reconcileInventorySnapshot(
  runId: number,
  db: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma,
): Promise<{ updatedRows: number; elapsedMs: number }> {
  const startedAt = Date.now();
  // Fresh run IDs are absent from planner statistics. Materializing one exact
  // numeric lookup map prevents PostgreSQL from rescanning the lot aggregate
  // once per inventory row when it underestimates the new run at one row.
  const updatedRows = await db.$executeRaw(Prisma.sql`
    WITH summary AS MATERIALIZED (
      SELECT erp_part_no,
             COALESCE(SUM(stock_pc), 0) AS in_stock_pc,
             COALESCE(SUM(stock_kg), 0) AS in_stock_kg,
             COALESCE(SUM(stock_pc) FILTER (WHERE UPPER(BTRIM(COALESCE(warehouse_code, ''))) <> 'YE1'), 0) AS wfg_stock_pc,
             COALESCE(SUM(stock_kg) FILTER (WHERE UPPER(BTRIM(COALESCE(warehouse_code, ''))) <> 'YE1'), 0) AS wfg_stock_kg,
             COALESCE(SUM(stock_pc) FILTER (WHERE UPPER(BTRIM(COALESCE(warehouse_code, ''))) = 'YE1'), 0) AS ye1_stock_pc,
             COALESCE(SUM(stock_kg) FILTER (WHERE UPPER(BTRIM(COALESCE(warehouse_code, ''))) = 'YE1'), 0) AS ye1_stock_kg
      FROM staging.inventory_lots
      WHERE mrp_run_id = ${runId}
        AND quality_status IN (${Prisma.join([...MRP_AVAILABLE_INVENTORY_QUALITIES])})
      GROUP BY erp_part_no
    ), summary_map AS MATERIALIZED (
      SELECT COALESCE(
        jsonb_object_agg(
          erp_part_no,
          jsonb_build_array(
            in_stock_pc,
            in_stock_kg,
            wfg_stock_pc,
            wfg_stock_kg,
            ye1_stock_pc,
            ye1_stock_kg
          )
        ),
        '{}'::jsonb
      ) AS by_erp
      FROM summary
    ), reconciled AS MATERIALIZED (
      SELECT inventory.id,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 0)::numeric, 0) AS in_stock_pc,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 1)::numeric, 0) AS in_stock_kg,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 2)::numeric, 0) AS wfg_stock_pc,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 3)::numeric, 0) AS wfg_stock_kg,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 4)::numeric, 0) AS ye1_stock_pc,
             COALESCE((summary_map.by_erp -> inventory.erp_part_no ->> 5)::numeric, 0) AS ye1_stock_kg
      FROM staging.inventory AS inventory
      CROSS JOIN summary_map
      WHERE inventory.mrp_run_id = ${runId}
    )
    UPDATE staging.inventory AS inventory
    SET in_stock_pc = reconciled.in_stock_pc,
        in_stock_kg = reconciled.in_stock_kg,
        wfg_stock_pc = reconciled.wfg_stock_pc,
        wfg_stock_kg = reconciled.wfg_stock_kg,
        ye1_stock_pc = reconciled.ye1_stock_pc,
        ye1_stock_kg = reconciled.ye1_stock_kg
    FROM reconciled
    WHERE inventory.id = reconciled.id
      AND (
        inventory.in_stock_pc IS DISTINCT FROM reconciled.in_stock_pc
        OR inventory.in_stock_kg IS DISTINCT FROM reconciled.in_stock_kg
        OR inventory.wfg_stock_pc IS DISTINCT FROM reconciled.wfg_stock_pc
        OR inventory.wfg_stock_kg IS DISTINCT FROM reconciled.wfg_stock_kg
        OR inventory.ye1_stock_pc IS DISTINCT FROM reconciled.ye1_stock_pc
        OR inventory.ye1_stock_kg IS DISTINCT FROM reconciled.ye1_stock_kg
      )
  `);

  return { updatedRows, elapsedMs: Date.now() - startedAt };
}

export async function reconcileWorkOrderBomLinks(
  runId: number,
  db: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma,
): Promise<number> {
  // Form 28 的未結案欄位可能在解除 Link 後殘留；兩份快照完成後才以工令主表核對。
  return db.$executeRaw(Prisma.sql`
    UPDATE staging.work_order_bom AS bom
    SET issued_qty_state = 'unknown',
        issued_qty_error = 'unlinked_work_order',
        remaining_usage = NULL
    WHERE bom.mrp_run_id = ${runId}
      AND NOT EXISTS (
        SELECT 1 FROM staging.work_orders AS wo
        WHERE wo.mrp_run_id = bom.mrp_run_id
          AND NULLIF(BTRIM(wo.wo_number), '') = NULLIF(BTRIM(bom.wo_number), '')
          AND BTRIM(wo.status) = '未結案'
      )
      AND (bom.issued_qty_error IS DISTINCT FROM 'unlinked_work_order'
        OR bom.issued_qty_state IS DISTINCT FROM 'unknown'
        OR bom.remaining_usage IS NOT NULL)
  `);
}

async function batchOrders(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_ORDERS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      partVersion: normPv(m.part_version),
      orderNo: m.order_no ? String(m.order_no) : null,
      customerPartNo: m.customer_part_no ? String(m.customer_part_no) : null,
      orderQty: parseNum(m.order_qty as string),
      preparedQty: parseNullableNum(m.prepared_qty),
      unprepQty: parseNum(m.unprep_qty as string),
      shippedQty: parseNullableNum(m.shipped_qty),
      unshippedQty: parseNum(m.unshipped_qty as string),
      soldQty: parseNullableNum(m.sold_qty),
      unsoldQty: parseNum(m.unsold_qty as string),
      orderType: m.order_type ? String(m.order_type) : null,
      deliveryDate: parseDate(m.delivery_date as string),
      designatedShipDate: parseDate(m.designated_ship_date as string),
      shipmentStatus: m.shipment_status ? String(m.shipment_status) : null,
      salesStatus: m.sales_status ? String(m.sales_status) : null,
      prepStatus: m.prep_status ? String(m.prep_status) : null,
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingOrder.createMany({ data: chunk }));
}

async function batchForecasts(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_FORECASTS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      partVersion: normPv(m.part_version),
      forecastQty: parseNum(m.forecast_qty as string),
      forecastStart: parseDate(m.forecast_start as string),
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingForecast.createMany({ data: chunk }));
}

async function batchWorkOrders(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_WORK_ORDERS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      woNumber: m.wo_number ? String(m.wo_number) : null,
      partVersion: normPv(m.part_version),
      erpPartNo: m.erp_part_no ? String(m.erp_part_no) : null,
      subProcessCode: m.sub_process_code ? String(m.sub_process_code) : null,
      jobOrderCode: m.job_order_code ? String(m.job_order_code) : null,
      woQty: parseNum(m.wo_qty as string),
      startDate: parseDate(m.start_date as string),
      endDate: parseDate(m.end_date as string),
      status: m.status ? String(m.status) : null,
      alreadyPicked: m.already_picked ? String(m.already_picked) : null,
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingWorkOrder.createMany({ data: chunk }));
}

async function batchWorkOrderBom(
  runId: number,
  records: RagicRecord[],
  recordTiming: WorkOrderBomTimingRecorder,
): Promise<number> {
  const allocations: WorkOrderIssueAllocation[] = [];
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_WORK_ORDER_BOM);
    const minUsage = parseNum(m.min_usage as string);
    const issueRows = workOrderIssueRows(r);
    const usage = calculateWorkOrderBomUsage({
      plannedUsage: minUsage,
      bomUnit: m.unit,
      alreadyPicked: m.already_picked,
      issueRows,
    });
    for (const issueRow of issueRows) {
      if (String(issueRow['1006339'] ?? '').trim().toLowerCase() !== 'yes') continue;
      const inventoryLotNo = String(issueRow['1006277'] ?? '').trim();
      const workOrderNo = String(m.wo_number ?? '').trim();
      const componentNo = String(m.component_no ?? '').trim();
      if (!inventoryLotNo || !workOrderNo || !componentNo) continue;
      allocations.push({
        bomRecordId: r._ragic_id,
        workOrderNo,
        bomItemKey: String(issueRow['1006280'] ?? '').trim() || null,
        componentNo,
        inventoryLotNo,
        unit: m.unit,
        issuedAt: parseDate(issueRow['1006859'] as string),
      });
    }
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      componentNo: m.component_no ? String(m.component_no) : null,
      woNumber: m.wo_number ? String(m.wo_number) : null,
      sourceType: m.source_type ? String(m.source_type) : null,
      processCode: m.process_code ? String(m.process_code) : null,
      unit: m.unit ? String(m.unit) : null,
      minUsage,
      alreadyPicked: m.already_picked ? String(m.already_picked) : null,
      issuedQty: usage.issuedQty,
      grossIssuedQty: usage.issuedQty,
      consumedQty: null,
      returnedQty: usage.issuedQty === null ? null : 0,
      netIssuedQty: usage.issuedQty,
      reservedQty: null,
      remainingUsage: usage.remainingUsage,
      overIssuedQty: usage.issuedQty === null
        ? null
        : Math.max(usage.issuedQty - minUsage, 0),
      issuedQtyState: usage.issuedQtyState,
      issuedDetailCount: usage.issuedDetailCount,
      issuedQtyError: usage.issuedQtyError,
      movementState: 'fallback',
      movementDetailCount: 0,
      movementError: null,
      startDate: parseDate(m.start_date as string),
    };
  });
  const form28InsertStartedAt = Date.now();
  let inserted = 0;
  try {
    inserted = await chunkedCreateMany(
      data,
      (chunk) => prisma.stagingWorkOrderBom.createMany({ data: chunk }),
    );
  } finally {
    recordTiming('work_order_bom_form28_insert', Date.now() - form28InsertStartedAt);
  }
  await enrichWorkOrderBomMovementSnapshot(runId, allocations, recordTiming);
  return inserted;
}

async function batchProductionPlans(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_PRODUCTION_PLANS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      planNo: m.plan_no ? String(m.plan_no) : null,
      partVersion: normPv(m.part_version),
      erpPartNo: m.erp_part_no ? String(m.erp_part_no) : null,
      planQty: parseNum(m.plan_qty as string),
      completionDate: parseDate(m.completion_date as string),
      reportedQty: parseNum(m.reported_qty as string),
      closedQty: parseNum(m.closed_qty as string),
      status: null,
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingProductionPlan.createMany({ data: chunk }));
}

async function batchPurchaseOrders(runId: number, records: RagicRecord[]): Promise<number> {
  const data = records.map((r) => {
    const m = mapRecord(r, SOURCE_FIELD_MAP_PURCHASE_ORDERS);
    return {
      mrpRunId: runId,
      ragicRecordId: r._ragic_id,
      productNo: m.product_no ? String(m.product_no) : null,
      deliveryDate: parseDate(m.delivery_date as string),
      unreceivedQty: parseNum(m.unreceived_qty as string),
      category: m.category ? String(m.category) : null,
      status: m.status ? String(m.status) : null,
    };
  });
  return chunkedCreateMany(data, (chunk) => prisma.stagingPurchaseOrder.createMany({ data: chunk }));
}
