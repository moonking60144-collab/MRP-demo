/**
 * Post-sync gate that verifies Ragic-computed plan_qty (EID 1027890) against our
 * self-computed value. Halts the MRP run with PlanQtyDivergenceError when Ragic's
 * formula has drifted (e.g. AC11 → AD11 column shift made LAST(AC11) point at the
 * wrong column).
 *
 * Ragic-friendliness: choose the random sample first, then preload those Form [10]
 * records in one filtered full-listing GET. Full verification keeps the all-open
 * preload. If the bulk request fails or omits a target, fall back to the original
 * concurrency-2 single-record GETs with 500ms delay.
 *
 * Tunable via env:
 *   VERIFY_PLAN_QTY_SAMPLE_SIZE    default 30    (0 = full check; uses all-open preload)
 *   VERIFY_PLAN_QTY_CONCURRENCY    default 2     (single-record fallback only)
 *   VERIFY_PLAN_QTY_BATCH_DELAY_MS default 500   (single-record fallback only)
 *   VERIFY_PLAN_QTY_TOLERANCE      default 1     (absolute, to absorb rounding)
 *   VERIFY_PLAN_QTY_DRY_RUN        default false (warn-only, never throws)
 *   VERIFY_PLAN_QTY_MAX_REPORTED   default 50    (cap on divergences kept in memory)
 *
 * See: project_ragic_formula_drift_and_fallback.md, reference_ragic_api_endpoints.md
 */
import { fetchRagicListing, fetchRagicRecord, type RagicFullRecord } from '../ragic-client';
import { OPEN_PRODUCTION_PLAN_WHERE } from '../sync/field-maps';
import { checkSignal } from '../sync/sync-engine';
import { prisma } from '../db';
import { runLog } from '../run-logger';
import { config } from '../config';
import { computePlanQty } from './compute-plan-qty';

/** Plan that's being verified after sync. */
export interface PlanCandidate {
  ragicRecordId: string;
  ragicPlanQty: number;
  planNo?: string | null;
}

/** Single divergence reported to the user / errorMessage. */
export interface PlanQtyDivergence {
  recordId: string;
  ragic: number;
  ours: number;
  diff: number;
  reason?: 'fetch_failed' | 'mismatch';
  /** 業務識別：生產計畫單號 (Ragic EID 1006542)。fetch_failed 時可能無。 */
  planNo?: string;
  /** 業務識別：客戶料號版本 (Ragic EID 1006546)。fetch_failed 時可能無。 */
  partVersion?: string;
  /** 該筆 Ragic listing 頁 URL — 給 UI 直接連結點開 */
  ragicUrl?: string;
}

export interface PlanQtyFetchFailure {
  recordId: string;
  message: string;
  ragicUrl: string;
}

/** Thrown when one or more records diverge beyond tolerance (non-dry-run). */
export class PlanQtyDivergenceError extends Error {
  constructor(
    public readonly summary: string,
    /** Reported divergences (may be a truncated subset; see {@link totalDiverged} for the full count). */
    public readonly divergences: PlanQtyDivergence[],
    public readonly checked: number,
    /** True total of divergent records, unaffected by maxReported cap. */
    public readonly totalDiverged: number,
  ) {
    super(summary);
    this.name = 'PlanQtyDivergenceError';
  }
}

export class PlanQtyVerificationUnavailableError extends Error {
  constructor(
    public readonly summary: string,
    public readonly failures: PlanQtyFetchFailure[],
    public readonly checked: number,
    public readonly totalFailed: number,
  ) {
    super(summary);
    this.name = 'PlanQtyVerificationUnavailableError';
  }
}

export interface VerifyPlanQtyOptions {
  /** Absolute diff tolerated. Default: env VERIFY_PLAN_QTY_TOLERANCE or 1. */
  tolerance?: number;
  /** Parallel single-record fallback fetches per batch. Default: env VERIFY_PLAN_QTY_CONCURRENCY or 2. */
  concurrency?: number;
  /**
   * Random sample size. Default: env VERIFY_PLAN_QTY_SAMPLE_SIZE or 30.
   * Set to 0 to verify every record. Bulk preload keeps the normal path to one
   * listing request, but a bulk failure would fall back to throttled per-record GETs.
   */
  sampleSize?: number;
  /** Sleep ms between fallback batches. Default: env VERIFY_PLAN_QTY_BATCH_DELAY_MS or 500. */
  batchDelayMs?: number;
  /** Warn-only mode — never throws on divergence. Default: env VERIFY_PLAN_QTY_DRY_RUN. */
  dryRun?: boolean;
  /** Max divergences kept in memory + reported. Default: env VERIFY_PLAN_QTY_MAX_REPORTED or 50. */
  maxReported?: number;
  /** Callback for incremental progress (used to update mrp_run.stepStatus). */
  onProgress?: (checked: number, total: number) => Promise<void> | void;
  /** Allows verify loop to honour user stop signal between batches. */
  runId?: number;
}

export interface VerifyPlanQtyResult {
  checked: number;
  matched: number;
  diverged: PlanQtyDivergence[];
  fetchFailures: PlanQtyFetchFailure[];
  /** True if dry-run mode swallowed an otherwise-fatal divergence. */
  dryRunSuppressed: boolean;
}

export type PlanQtyCandidateResult =
  | { kind: 'matched' }
  | { kind: 'mismatch'; divergence: PlanQtyDivergence }
  | { kind: 'fetch_failed'; failure: PlanQtyFetchFailure };

export async function loadOpenPlanQtyRecords(
  targetPlanNos: readonly string[] | undefined,
  fetchListing: typeof fetchRagicListing = fetchRagicListing,
): Promise<Map<string, RagicFullRecord>> {
  const uniquePlanNos = targetPlanNos ? [...new Set(targetPlanNos)] : undefined;
  if (uniquePlanNos?.length === 0) return new Map();

  const records = await fetchListing({
    path: '/default/d4/10',
    listing: false,
    limit: 1000,
    where: [
      ...OPEN_PRODUCTION_PLAN_WHERE,
      ...(uniquePlanNos ?? []).map((planNo) => ({
        fieldId: '1006542',
        operator: 'eq' as const,
        value: planNo,
      })),
    ],
  });
  return new Map(records.map((record) => [
    record._ragic_id,
    record as unknown as RagicFullRecord,
  ]));
}

export async function verifyPlanQtyCandidate(
  candidate: PlanCandidate,
  tolerance: number,
  fetchRecord: typeof fetchRagicRecord = fetchRagicRecord,
  prefetchedRecord?: RagicFullRecord,
): Promise<PlanQtyCandidateResult> {
  const ragicUrl = `${config.ragicBaseUrl}/default/d11mrp/1/${candidate.ragicRecordId}`;
  try {
    const rec = prefetchedRecord ?? await fetchRecord({
      path: '/default/d4/10',
      recordId: candidate.ragicRecordId,
    });
    const ours = computePlanQty(rec);
    const diff = ours - candidate.ragicPlanQty;
    if (Math.abs(diff) <= tolerance) return { kind: 'matched' };
    return {
      kind: 'mismatch',
      divergence: {
        recordId: candidate.ragicRecordId,
        ragic: candidate.ragicPlanQty,
        ours,
        diff,
        reason: 'mismatch',
        planNo: rec['1006542'] != null ? String(rec['1006542']) : undefined,
        partVersion: rec['1006546'] != null ? String(rec['1006546']) : undefined,
        ragicUrl,
      },
    };
  } catch (err) {
    return {
      kind: 'fetch_failed',
      failure: {
        recordId: candidate.ragicRecordId,
        message: err instanceof Error ? err.message : String(err),
        ragicUrl,
      },
    };
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string): boolean {
  const raw = (process.env[name] ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Fisher-Yates partial shuffle: returns N uniformly random elements without replacement. */
function randomSample<T>(arr: T[], n: number): T[] {
  const out = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (out.length - i));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, n);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Verify staging.production_plans[runId].planQty matches what we compute from
 * source EIDs. Throws PlanQtyDivergenceError on mismatch unless dry-run.
 *
 * Returns a summary so callers can record metrics even on the success path.
 */
export async function verifyPlanQty(
  runId: number,
  opts: VerifyPlanQtyOptions = {},
): Promise<VerifyPlanQtyResult> {
  const tolerance = opts.tolerance ?? envInt('VERIFY_PLAN_QTY_TOLERANCE', 1);
  const concurrency = Math.max(1, opts.concurrency ?? envInt('VERIFY_PLAN_QTY_CONCURRENCY', 2));
  const sampleSize = opts.sampleSize ?? envInt('VERIFY_PLAN_QTY_SAMPLE_SIZE', 30);
  const batchDelayMs = Math.max(0, opts.batchDelayMs ?? envInt('VERIFY_PLAN_QTY_BATCH_DELAY_MS', 500));
  const dryRun = opts.dryRun ?? envBool('VERIFY_PLAN_QTY_DRY_RUN');
  const maxReported = Math.max(1, opts.maxReported ?? envInt('VERIFY_PLAN_QTY_MAX_REPORTED', 50));

  // Query candidates. Ragic-side filter already restricts to non-closed plans
  // (1015482 = '未結案'). staging.status is intentionally left null by the sync
  // engine — the Ragic filter is the only guard we depend on for scope.
  // 排除測試料（part_version 以 'TEST' 開頭）: 測試料 Ragic 端可能有手動填值、
  // 跟我們自算邏輯對不上（如 record 5189: ragic=17 / ours=0）→ 誤觸 halt。
  // 真正公式漂移影響全表所有 record，sample 內排除幾筆 test 料不影響偵測率。
  const rows = await prisma.stagingProductionPlan.findMany({
    where: {
      mrpRunId: runId,
      ragicRecordId: { not: null },
      NOT: { partVersion: { startsWith: 'TEST' } },
    },
    select: { ragicRecordId: true, planNo: true, planQty: true },
  });

  const candidates: PlanCandidate[] = rows.map((r) => ({
    ragicRecordId: r.ragicRecordId!,
    ragicPlanQty: Number(r.planQty),
    planNo: r.planNo,
  }));
  // Random sample. Sheet-level formula drift affects all records uniformly so
  // a sample of 30 catches drift with >99% probability while keeping Ragic load
  // negligible. Setting sampleSize <= 0 means "verify everything" (Ragic risk).
  const isSampled = sampleSize > 0 && sampleSize < candidates.length;
  const targets = isSampled
    ? randomSample(candidates, sampleSize)
    : candidates;
  const total = targets.length;

  runLog.info(
    `[Verify] plan_qty consistency: ${total}/${candidates.length} records (sample), fallback concurrency=${concurrency}, delay=${batchDelayMs}ms, tolerance=±${tolerance}${dryRun ? ' (DRY-RUN)' : ''}`,
  );

  if (opts.runId != null) {
    await checkSignal(opts.runId);
  }

  let prefetchedRecords = new Map<string, RagicFullRecord>();
  try {
    const preloadStartedAt = Date.now();
    const targetPlanNos = isSampled
      ? targets.flatMap((candidate) => candidate.planNo ? [candidate.planNo] : [])
      : undefined;
    prefetchedRecords = await loadOpenPlanQtyRecords(targetPlanNos);
    runLog.info(
      `[Verify] preloaded ${prefetchedRecords.size} open production plans in ${Date.now() - preloadStartedAt}ms`,
    );
  } catch (error) {
    runLog.warn(
      `[Verify] bulk preload unavailable; using throttled per-record fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let remainingFallbackCount = targets.reduce(
    (count, candidate) => count + (prefetchedRecords.has(candidate.ragicRecordId) ? 0 : 1),
    0,
  );

  const diverged: PlanQtyDivergence[] = [];
  const fetchFailures: PlanQtyFetchFailure[] = [];
  let matched = 0;
  let checked = 0;
  /** Total divergent records, unaffected by maxReported cap (so error msg can be honest). */
  let totalDiverged = 0;
  let totalFetchFailed = 0;
  /** Throttle progress callback: notify every ~5% or every 5 batches, whichever fires first. */
  const totalBatches = Math.ceil(total / concurrency) || 1;
  const progressEveryNBatches = Math.max(1, Math.min(5, Math.floor(totalBatches / 20)));

  for (let batchIdx = 0, i = 0; i < total; i += concurrency, batchIdx++) {
    // Honour user "stop" signal between batches — without this, verify can run
    // 30-60s and ignore the UI stop button (matches issue #2 of the review).
    if (opts.runId != null) {
      await checkSignal(opts.runId);
    }

    const batch = targets.slice(i, i + concurrency);
    const batchFallbackCount = batch.reduce(
      (count, candidate) => count + (prefetchedRecords.has(candidate.ragicRecordId) ? 0 : 1),
      0,
    );
    await Promise.all(
      batch.map(async (cand) => {
        const result = await verifyPlanQtyCandidate(
          cand,
          tolerance,
          fetchRagicRecord,
          prefetchedRecords.get(cand.ragicRecordId),
        );
        if (result.kind === 'matched') {
          matched++;
        } else if (result.kind === 'mismatch') {
          totalDiverged++;
          if (diverged.length < maxReported) {
            diverged.push(result.divergence);
          }
        } else {
          totalFetchFailed++;
          if (fetchFailures.length < maxReported) {
            fetchFailures.push(result.failure);
          }
          runLog.warn(
            `[Verify] fetch failed for record ${cand.ragicRecordId}: ${result.failure.message}`,
          );
        }
        checked++;
      }),
    );

    // Throttle DB writes: every Nth batch + the final batch.
    if (opts.onProgress && (batchIdx % progressEveryNBatches === 0 || checked === total)) {
      await opts.onProgress(checked, total);
    }

    remainingFallbackCount -= batchFallbackCount;

    // Only fallback single-record GETs need throttling. Prefetched records are
    // local calculations and must not pay the old fixed delay.
    if (batchDelayMs > 0 && batchFallbackCount > 0 && remainingFallbackCount > 0) {
      await sleep(batchDelayMs);
    }
  }

  let divergenceSummary = '';
  if (totalDiverged > 0) {
    const sample = diverged
      .slice(0, 5)
      .map((d) => `${d.recordId}(ragic=${d.ragic}, ours=${d.ours}, diff=${d.diff})`)
      .join('; ');
    const truncatedNote = totalDiverged > diverged.length
      ? ` (showing first ${diverged.length}, ${totalDiverged - diverged.length} more truncated)`
      : '';
    divergenceSummary = `Plan qty divergence: ${totalDiverged}/${total - totalFetchFailed} fetched records mismatch (tolerance=±${tolerance}). Sample: ${sample}${truncatedNote}`;
  }

  let unavailableSummary = '';
  if (totalFetchFailed > 0) {
    const sample = fetchFailures.slice(0, 5).map((f) => `${f.recordId}(${f.message})`).join('; ');
    const truncatedNote = totalFetchFailed > fetchFailures.length
      ? ` (showing first ${fetchFailures.length}, ${totalFetchFailed - fetchFailures.length} more truncated)`
      : '';
    unavailableSummary = `Plan qty verification unavailable: ${totalFetchFailed}/${total} Ragic records could not be fetched. Sample: ${sample}${truncatedNote}`;
  }

  if (dryRun && (totalDiverged > 0 || totalFetchFailed > 0)) {
    if (divergenceSummary) runLog.warn(`[Verify] DRY-RUN ${divergenceSummary}`);
    if (unavailableSummary) runLog.warn(`[Verify] DRY-RUN ${unavailableSummary}`);
    return { checked, matched, diverged, fetchFailures, dryRunSuppressed: true };
  }

  if (totalDiverged > 0) {
    if (unavailableSummary) runLog.warn(`[Verify] ${unavailableSummary}`);
    runLog.error(`[Verify] ${divergenceSummary}`);
    throw new PlanQtyDivergenceError(divergenceSummary, diverged, checked, totalDiverged);
  }

  if (totalFetchFailed > 0) {
    runLog.error(`[Verify] ${unavailableSummary}`);
    throw new PlanQtyVerificationUnavailableError(
      unavailableSummary,
      fetchFailures,
      checked,
      totalFetchFailed,
    );
  }

  runLog.info(`[Verify] ✓ plan_qty consistent (${matched}/${total} match)`);
  return { checked, matched, diverged, fetchFailures, dryRunSuppressed: false };
}
