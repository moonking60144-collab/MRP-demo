/**
 * MRP Run Orchestrator
 * Coordinates the full pipeline: sync → calculate → mark latest
 * Supports async execution with progress polling
 */
import type { Prisma } from '@prisma/client';
import prisma, { withRuntimeDbControl } from '../db';
import { runSync, sendRunSignal, SyncStoppedError } from '../sync/sync-engine';
import { verifyPlanQty, PlanQtyDivergenceError } from './verify-plan-qty';
import { calculateFgMonthly, calculateFgMonthlyAggregated } from './fg-monthly-engine';
import { calculateComponentWeekly } from './component-weekly-engine';
import { calculateSalesMeeting } from './sales-meeting-engine';
import { runLog, withRunLogging } from '../run-logger';
import {
  ACTIVE_STATUSES,
  MRP_RUN_START_LOCK_KEY,
  MRP_RUN_STATUS,
  STOP_REASON,
} from './run-status';
import { emitRunCompleted } from './run-events';
import { scheduleCompletedRunCleanup } from './run-retention';
import { toRunSummary } from './run-summary';
import { loadRunCalculationInputs } from './run-calculation-inputs';
import { ORDER_DEMAND_CONTRACT_V2 } from './order-demand-contract';
import {
  getActiveLocalRunIds,
  settleAllOrThrow,
  withRunAttempt,
  withSettledTimeout,
} from './run-attempt-control';

export interface MrpRunResult {
  runId: number;
  versionCode: string;
  syncCounts: Record<string, number>;
  partCount: number;
  duration: number;
  status:
    | typeof MRP_RUN_STATUS.COMPLETED
    | typeof MRP_RUN_STATUS.ERROR
    | typeof MRP_RUN_STATUS.STOPPED;
  error?: string;
}

const RUN_IN_PROGRESS_MSG =
  'Another MRP run is already in progress. Please wait for it to complete.';

/**
 * 把「啟動一次 MRP」的臨界區包進一個 interactive transaction：先以
 * pg_advisory_xact_lock 序列化所有並行的啟動請求，確認當下沒有任何 active
 * run，才執行 `fn`（建立新紀錄或把舊紀錄翻回 active）。臨界區只有「搶鎖 →
 * 查 active → fn」三步，毫秒等級；交易一結束鎖即自動釋放。
 *
 * mrp_run 那筆 active 紀錄本身就是並行鎖 —— 不再需要獨立的 session 級鎖。
 */
async function withRunStartLock<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withRuntimeDbControl(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${MRP_RUN_START_LOCK_KEY})`);
      const active = await tx.mrpRun.findFirst({
        where: { status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) throw new Error(RUN_IN_PROGRESS_MSG);
      return fn(tx);
    }),
  );
}

/** 產生 MRP 版本碼 MRP-YYYYMMDD-HHMMSS */
function generateVersionCode(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `MRP-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Execute a full MRP run: sync + calculate + finalize.
 * 先原子地建立 mrp_run 紀錄（status=syncing，這筆紀錄即並行鎖），再跑 pipeline。
 */
export async function executeMrpRun(createdBy?: string): Promise<MrpRunResult> {
  const { runId } = await withRunStartLock(async (tx) => {
    const now = new Date();
    const created = await tx.mrpRun.create({
      data: {
        versionCode: generateVersionCode(now),
        runDate: now,
        status: MRP_RUN_STATUS.SYNCING,
        orderDemandContractVersion: ORDER_DEMAND_CONTRACT_V2,
        createdBy: createdBy || 'system',
      },
    });
    return { runId: created.id };
  });
  return executePipeline(createdBy, { runId });
}

/**
 * Resume an interrupted MRP run from where it left off.
 * Reuses the same mrp_run record, skips sync steps already marked 'done', and
 * retries the rest. Calc phases (FG monthly, component weekly, sales meeting)
 * always re-run from scratch since they're idempotent over mrpRunId.
 */
export async function resumeMrpRun(runId: number, createdBy?: string): Promise<MrpRunResult> {
  // 原子地把要 resume 的舊紀錄翻回 active —— 翻完它就持有並行鎖。
  await withRunStartLock(async (tx) => {
    const target = await tx.mrpRun.findUnique({ where: { id: runId } });
    if (!target) throw new Error(`Cannot resume: run #${runId} not found`);
    if (target.status === MRP_RUN_STATUS.COMPLETED) {
      throw new Error(`Cannot resume run #${runId}: already completed`);
    }
    await tx.mrpRun.update({
      where: { id: runId },
      data: { status: MRP_RUN_STATUS.SYNCING },
    });
  });
  return executePipeline(createdBy, { resumeRunId: runId });
}

/**
 * Record a phase timeout without detaching the underlying work. The timeout is
 * reported only after that work settles, so the run cannot be marked resumable
 * while an old worker is still capable of writing staging/output rows.
 */
const PHASE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per phase
async function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return withSettledTimeout(label, p, PHASE_TIMEOUT_MS);
}

async function recordStepTiming(runId: number, key: string, elapsedMs: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE public.mrp_run
    SET step_timing = jsonb_set(
      COALESCE(step_timing, '{}'::jsonb),
      ${`{${key}}`}::text[],
      ${JSON.stringify(elapsedMs)}::jsonb
    )
    WHERE id = ${runId}
  `;
}

/**
 * Internal pipeline execution. The caller (executeMrpRun / resumeMrpRun) must
 * have already claimed the concurrency lock via withRunStartLock — i.e. an
 * mrp_run record in an active status already exists for `opts.runId` /
 * `opts.resumeRunId`.
 */
async function executePipeline(
  createdBy?: string,
  opts?: { runId?: number; resumeRunId?: number },
): Promise<MrpRunResult> {
  const runId = opts?.resumeRunId ?? opts?.runId;
  if (runId == null) throw new Error('Cannot execute MRP pipeline without a run id');
  return withRunAttempt(runId, () => executePipelineAttempt(createdBy, opts));
}

async function executePipelineAttempt(
  createdBy?: string,
  opts?: { runId?: number; resumeRunId?: number },
): Promise<MrpRunResult> {
  const startTime = Date.now();

  // Read accumulated active time from any prior attempts so this attempt's
  // elapsed ms is *added* to the total, not replacing it. Used by the UI's
  // duration display (sum of attempts, excluding idle gaps).
  const priorActiveMs = opts?.resumeRunId
    ? await readTotalActiveMs(opts.resumeRunId)
    : 0;

  // 追蹤這次 pipeline 對應的 runId，catch 區塊用這個直接定位要標 error 的
  // row，避免「findFirst 找最近 active run」誤標別人的 run。現在不論 fresh
  // 或 resume，runId 都在進 pipeline 前就由 withRunStartLock 建好/翻好了。
  let knownRunId: number | null = opts?.resumeRunId ?? opts?.runId ?? null;

  try {
    // 1. Sync from Ragic. The mrp_run record already exists (pre-created by
    // withRunStartLock); runSync populates/reuses it via runId / resumeRunId.
    // Ragic page fetches have their own AbortController timeout. This outer
    // deadline records an overlong phase, but waits for the underlying sync to
    // settle before the run becomes resumable.
    const { runId, versionCode, counts } = await withTimeout(
      'Sync (Ragic)',
      runSync(createdBy, { runId: opts?.runId, resumeRunId: opts?.resumeRunId }),
    );
    knownRunId = runId;

    // Wrap the calc phases in the per-run logging context so their runLog.*
    // calls (and any nested ones) are captured into mrp_run.logs alongside
    // the sync logs and shown in the 顯示詳細日誌 UI.
    return await withRunLogging(runId, async () => {
    // 1b. Verify Ragic plan_qty (1027890) didn't drift before we trust it for calc.
    // Always runs on resume too — between attempts, Ragic state or sync staging
    // may have changed, so caching a prior 'done' would risk trusting fresh data
    // we never re-verified.
    const stepBeforeVerify = await getStepStatus(runId);
    await prisma.mrpRun.update({
      where: { id: runId },
      data: {
        stepStatus: {
          ...stepBeforeVerify,
          _phase: 'verifying_plan_qty',
          _verifyProgress: { checked: 0, total: 0 },
        } as object,
      },
    });

    const verifyStartedAt = Date.now();
    await withTimeout(
      'Verify plan_qty',
      verifyPlanQty(runId, {
        runId,  // enables stop-signal checks between batches
        onProgress: async (checked, total) => {
          const cur = await getStepStatus(runId);
          await prisma.mrpRun.update({
            where: { id: runId },
            data: {
              stepStatus: {
                ...cur,
                _verifyProgress: { checked, total },
              } as object,
            },
          });
        },
      }),
    );
    await recordStepTiming(runId, 'verify_plan_qty', Date.now() - verifyStartedAt);

    // 2. Update status to calculating with progress info
    await prisma.mrpRun.update({
      where: { id: runId },
      data: {
        status: MRP_RUN_STATUS.CALCULATING,
        stepStatus: {
          ...(await getStepStatus(runId)),
          _phase: 'calculating',
          _calcProgress: { status: 'running', partsProcessed: 0 },
        } as object,
      },
    });

    // 3-5. 並行跑三大 engine group。calc 階段全部讀 staging 寫 mrp_out 不同分區，
    //      互相獨立、不打 Ragic 沒 rate limit 顧慮：
    //        A: fgMonthly per-version → aggregated（內部序列；aggregated 從 per 聚合）
    //        B: component-weekly W / B / D（內部並行 3，不同 mrpType 寫不同分區）
    //        C: salesMeeting
    //      副作用：原本每階段寫 _phase 的細分階段更新拿掉了，dashboard _phase 會停在
    //      'calculating' 直到 completed；UI 過渡狀態 loss of granularity 換並行收益。
    runLog.info(`[Run #${runId}] Phase: calculating (FG monthly + component-weekly W/B/D + sales-meeting, parallel)`);
    const calculationStartedAt = Date.now();
    const calculationInputsStartedAt = Date.now();
    const calculationInputs = await withTimeout(
      'Load calculation inputs',
      loadRunCalculationInputs(runId),
    );
    runLog.info(
      `[Run #${runId}] Calculation inputs loaded: ${calculationInputs.inventoryRows.length} inventory rows in ${Date.now() - calculationInputsStartedAt}ms`,
    );
    await recordStepTiming(
      runId,
      'calculation_inputs',
      Date.now() - calculationInputsStartedAt,
    );

    const fgChain = (async () => {
      const r = await runRecordedStep(
        runId,
        'fg_monthly',
        'FG monthly (per-version)',
        () => calculateFgMonthly(runId, calculationInputs),
      );
      await runRecordedStep(
        runId,
        'fg_monthly_aggregated',
        'FG monthly (aggregated)',
        () => calculateFgMonthlyAggregated(runId, calculationInputs, r.aggregationSource),
      );
      return r.partCount;
    })();

    const componentChain = (async () => {
      const counts: Record<string, number> = {};
      await settleAllOrThrow((['W', 'B', 'D'] as const).map(async (mrpType) => {
        const r = await runRecordedStep(
          runId,
          `component_weekly_${mrpType.toLowerCase()}`,
          `Component weekly (${mrpType})`,
          () => calculateComponentWeekly(runId, mrpType, calculationInputs),
        );
        counts[mrpType] = r.materialCount;
      }));
      return counts;
    })();

    const salesChain = runRecordedStep(
      runId,
      'sales_meeting',
      'Sales meeting weekly',
      () => calculateSalesMeeting(runId, calculationInputs),
    ).then((r) => r.partCount);

    const [partCount, componentCounts, salesMeetingCount] = await settleAllOrThrow([
      fgChain,
      componentChain,
      salesChain,
    ] as const);
    await recordStepTiming(runId, 'calculation', Date.now() - calculationStartedAt);

    // 6. Mark this run as latest, un-mark previous
    await prisma.$transaction([
      prisma.mrpRun.updateMany({
        where: { isLatest: true },
        data: { isLatest: false },
      }),
      prisma.mrpRun.update({
        where: { id: runId },
        data: {
          status: MRP_RUN_STATUS.COMPLETED,
          isLatest: true,
          completedAt: new Date(),
          stepStatus: {
            ...(await getStepStatus(runId)),
            _phase: 'completed',
            _calcProgress: { status: 'done', partsProcessed: partCount },
            _componentCounts: componentCounts,
            _salesMeetingCount: salesMeetingCount,
            _totalActiveMs: priorActiveMs + (Date.now() - startTime),
          } as object,
        },
      }),
    ]);

    // 通知所有連線中的 client 有新 run 完成（SSE 端點訂閱此事件後推播）。
    emitRunCompleted({ latestRunId: runId, versionCode });
    scheduleCompletedRunCleanup();

    const duration = Date.now() - startTime;

    return {
      runId,
      versionCode,
      syncCounts: counts,
      partCount,
      duration,
      status: MRP_RUN_STATUS.COMPLETED,
    };
    });
  } catch (err) {
    const isUserStop = err instanceof SyncStoppedError;
    const isDrift = err instanceof PlanQtyDivergenceError;
    const isStopped = isUserStop || isDrift;
    const msg = err instanceof Error ? err.message : String(err);
    const stopReason = isDrift
      ? STOP_REASON.PLAN_QTY_DRIFT(
          err.totalDiverged,
          err.divergences.slice(0, 3).map(d => `${d.recordId}(diff=${d.diff})`).join(', '),
        )
      : isUserStop
        ? STOP_REASON.USER_STOP
        : msg;

    // 用 knownRunId 直接定位這次 pipeline 自己的 run，不要 findFirst 猜
    // (原本 findFirst 在多 worker / 並行場景會誤標別人的 run)。如果連
    // knownRunId 都還沒拿到 (sync 第一秒就 throw)，那就什麼都不動 —
    // 此時任何「active」run 都不是這次造成的。
    if (knownRunId !== null) {
      try {
        const stuckRun = await prisma.mrpRun.findUnique({
          where: { id: knownRunId },
        });
        if (stuckRun) {
          const priorStep = (stuckRun.stepStatus as Record<string, unknown> | null) ?? {};
          await prisma.mrpRun.update({
            where: { id: stuckRun.id },
            data: {
              status: isStopped ? MRP_RUN_STATUS.STOPPED : MRP_RUN_STATUS.ERROR,
              errorMessage: isStopped ? stopReason : msg,
              completedAt: new Date(),
              stepStatus: {
                ...priorStep,
                _totalActiveMs: priorActiveMs + (Date.now() - startTime),
                // 公式漂移時把結構化 divergence 寫進 stepStatus，dashboard 拿來
                // 跳中文 modal（含每筆生產計畫單號 + Ragic 直達連結）。
                ...(isDrift ? { _planQtyDivergences: err.divergences } : {}),
              } as object,
            },
          });
        }
      } catch {
        // Best-effort DB cleanup — don't mask the original error
      }
    }

    return {
      runId: 0,
      versionCode: '',
      syncCounts: {},
      partCount: 0,
      duration: Date.now() - startTime,
      status: isStopped ? MRP_RUN_STATUS.STOPPED : MRP_RUN_STATUS.ERROR,
      error: isStopped ? stopReason : msg,
    };
  }
}

/** Helper to read current stepStatus from DB */
async function getStepStatus(runId: number): Promise<Record<string, unknown>> {
  const run = await prisma.mrpRun.findUnique({ where: { id: runId }, select: { stepStatus: true } });
  return (run?.stepStatus as Record<string, unknown>) || {};
}

/** Read accumulated active-execution ms from a prior run's stepStatus._totalActiveMs */
async function runRecordedStep<T>(
  runId: number,
  key: string,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await withTimeout(label, task());
  await recordStepTiming(runId, key, Date.now() - startedAt);
  return result;
}

async function readTotalActiveMs(runId: number): Promise<number> {
  const ss = await getStepStatus(runId);
  const v = ss._totalActiveMs;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * Get live progress for an MRP run (used by polling endpoint)
 */
export async function getRunProgress(runId: number) {
  const run = await prisma.mrpRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      versionCode: true,
      status: true,
      createdAt: true,
      completedAt: true,
      stepStatus: true,
      stepTiming: true,
      syncCounts: true,
      errorMessage: true,
    },
  });

  if (!run) return null;

  return {
    runId: run.id,
    versionCode: run.versionCode,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    steps: run.stepStatus,
    timing: run.stepTiming,
    syncCounts: run.syncCounts,
    errorMessage: run.errorMessage,
  };
}

/**
 * Get the latest completed MRP run
 */
export async function getLatestRun(client: typeof prisma = prisma) {
  return client.mrpRun.findFirst({
    where: { isLatest: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      versionCode: true,
      runDate: true,
      status: true,
      orderDemandContractVersion: true,
      isLatest: true,
      createdAt: true,
      completedAt: true,
      createdBy: true,
      syncCounts: true,
      errorMessage: true,
    },
  });
}

/**
 * Get all MRP runs (recent first)
 */
export async function listRuns(limit = 20) {
  const runs = await prisma.mrpRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      versionCode: true,
      runDate: true,
      status: true,
      isLatest: true,
      createdAt: true,
      completedAt: true,
      createdBy: true,
      syncCounts: true,
      stepTiming: true,
      errorMessage: true,
      stepStatus: true,
    },
  });
  return runs.map(toRunSummary);
}

export async function listRunDetails(limit = 20) {
  return prisma.mrpRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Get the most recent active (non-completed, non-error) run
 */
export async function getActiveRun() {
  return prisma.mrpRun.findFirst({
    where: { status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      versionCode: true,
      status: true,
      createdAt: true,
    },
  });
}

/**
 * Clear stale runs that are stuck in active status.
 * Marks any run that's been in an active state for more than `maxMinutes` as
 * 'error'. The mrp_run record IS the concurrency lock, so flipping it out of
 * an active status is what frees the system for the next run.
 * Returns the number of runs cleaned up.
 *
 * process-local attempt 一律排除，即使超過門檻也不能只改 DB status 釋放；
 * 真正卡死的本機 worker 必須等待停止或重啟 process，避免新舊計算交錯。
 */
export async function clearStaleRuns(maxMinutes = 35): Promise<number> {
  const cutoff = new Date(Date.now() - maxMinutes * 60 * 1000);
  const activeLocalRunIds = getActiveLocalRunIds();

  const result = await prisma.mrpRun.updateMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      createdAt: { lt: cutoff },
      ...(activeLocalRunIds.length > 0 ? { id: { notIn: activeLocalRunIds } } : {}),
    },
    data: {
      status: MRP_RUN_STATUS.ERROR,
      errorMessage: STOP_REASON.STALE_CLEANUP(maxMinutes),
      completedAt: new Date(),
    },
  });

  return result.count;
}

/**
 * Clear orphaned active runs regardless of age. A run still registered in this
 * process receives a stop signal but remains active until its worker settles.
 */
export async function forceResetRuns(): Promise<{
  cleared: number;
  runningLocalRunIds: number[];
}> {
  const runningLocalRunIds = getActiveLocalRunIds();
  for (const runId of runningLocalRunIds) sendRunSignal(runId, 'stop');

  const result = await prisma.mrpRun.updateMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      ...(runningLocalRunIds.length > 0 ? { id: { notIn: runningLocalRunIds } } : {}),
    },
    data: {
      status: MRP_RUN_STATUS.ERROR,
      errorMessage: STOP_REASON.FORCE_RESET,
      completedAt: new Date(),
    },
  });

  return { cleared: result.count, runningLocalRunIds };
}
