/**
 * Shared helper for transferring plan suggestions to Ragic Form [10].
 * 走 PATCH /api/fg-monthly/:partVersion/suggestions（單筆，以及前端批次逐筆呼叫此端點）。
 */
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import {
  createRagicRecord,
  fetchRagicListing,
  RagicCreateError,
  type RagicCreateResult,
} from '@/lib/ragic-client';
import { FORM10_FIELDS } from '@/lib/sync/field-maps';
import { config } from '@/lib/config';
import {
  TRANSFER_STATUS,
  TransferStateConflictError,
} from '@/lib/transfer-state';
import {
  markPendingTransferUnknown,
  recoverStalePendingTransfers,
} from '@/lib/mrp/transfer-recovery';
import { recoverStaleWorkOrderGenerations } from '@/lib/mrp/work-order-generation';
import { parsePositivePlanQty } from '@/lib/mrp/fg-plan-input';
import {
  loadInventoryAnomalyLots,
  summarizeLoadedInventoryAnomalies,
  type InventoryAnomalyLot,
} from '@/lib/mrp/inventory-anomaly';

export interface TransferResult {
  ragicRecordId: string | null;
  ragicPlanNo: string | null;
  ragicUrl: string | null;
}

export interface TransferInventoryWarning {
  count: number;
  absoluteDiffPc: number;
  erpPartNos: string[];
  lots: InventoryAnomalyLot[];
}

export class InventoryAnomalyConfirmationRequiredError extends Error {
  readonly code = 'INVENTORY_ANOMALY_CONFIRMATION_REQUIRED';

  constructor(readonly warning: TransferInventoryWarning) {
    super(`庫存資料有 ${warning.count} 筆可能尚未同步，確認後才可轉單。`);
    this.name = 'InventoryAnomalyConfirmationRequiredError';
  }
}

export interface TransferPlanToRagicDeps {
  client?: typeof prisma;
  createRecord?: typeof createRagicRecord;
  fetchListing?: typeof fetchRagicListing;
  now?: () => Date;
  inventoryAnomalyAcknowledged?: boolean;
}

/**
 * 撈某 part 的規劃建議，並把已轉單的 ragicPlanNo/ragicUrl 併上去。
 * periods route（GET）與 suggestions route（轉單後回傳）共用，避免兩邊 enrichment 漂移。
 * 收 client 參數以支援 periods route 的 merge-mode 多 DB 查詢。
 */
export async function getEnrichedSuggestions(
  client: typeof prisma,
  runId: number,
  partVersion: string,
) {
  await Promise.all([
    recoverStalePendingTransfers(client, { mrpRunId: runId, partVersion }),
    recoverStaleWorkOrderGenerations(client, { mrpRunId: runId }),
  ]);
  const [suggestions, transfers] = await Promise.all([
    client.fgPlanSuggestion.findMany({
      where: { mrpRunId: runId, partVersion },
      orderBy: { planSequence: 'asc' },
    }),
    client.productionPlanTransfer.findMany({
      where: { mrpRunId: runId, partVersion },
      select: {
        id: true,
        planSequence: true,
        ragicPlanNo: true,
        ragicUrl: true,
        ragicRecordId: true,
        workOrderStatus: true,
        workOrderError: true,
        workOrderCompletedAt: true,
      },
    }),
  ]);
  const transferMap = new Map(transfers.map((t) => [t.planSequence, t]));
  return suggestions.map((s) => {
    const t = transferMap.get(s.planSequence);
    return {
      ...s,
      transferId: t?.id ?? null,
      ragicRecordId: t?.ragicRecordId ?? null,
      ragicPlanNo: t?.ragicPlanNo ?? null,
      ragicUrl: t?.ragicUrl ?? null,
      workOrderStatus: t?.workOrderStatus ?? null,
      workOrderError: t?.workOrderError ?? null,
      workOrderCompletedAt: t?.workOrderCompletedAt ?? null,
    };
  });
}

/** Format a Date as YYYY/MM/DD for Ragic */
function formatRagicDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

/**
 * Transfer a single plan suggestion to Ragic Form [10] and log the transfer.
 * Also marks the suggestion as transferred in the DB.
 *
 * @throws Error if the suggestion doesn't exist or Ragic API fails
 */
export async function transferPlanToRagic(
  runId: number,
  versionCode: string,
  partVersion: string,
  planSequence: number,
  deps: TransferPlanToRagicDeps = {},
): Promise<TransferResult> {
  const client = deps.client ?? prisma;
  const createRecord = deps.createRecord ?? createRagicRecord;
  const fetchListing = deps.fetchListing ?? fetchRagicListing;
  const now = deps.now ?? (() => new Date());
  const suggestionKey = {
    mrpRunId_partVersion_planSequence: { mrpRunId: runId, partVersion, planSequence },
  };
  const transferScope = { mrpRunId: runId, partVersion, planSequence };

  const fgSummary = await client.fgMonthly.findFirst({
    where: { mrpRunId: runId, partVersion, isAggregated: false },
    select: { customerCode: true, erpPartNo: true, aggregatedMembers: true },
  });
  let inventoryErpPartNos = fgSummary?.erpPartNo ? [fgSummary.erpPartNo] : [];
  if (fgSummary?.aggregatedMembers?.length) {
    const memberParts = await client.stagingPartVersion.findMany({
      where: { mrpRunId: runId, partVersion: { in: fgSummary.aggregatedMembers } },
      select: { erpPartNo: true },
      distinct: ['erpPartNo'],
    });
    inventoryErpPartNos = memberParts.flatMap((member) => member.erpPartNo ? [member.erpPartNo] : []);
  }
  const inventoryAnomalyLots = await loadInventoryAnomalyLots(client, runId, inventoryErpPartNos);
  const inventoryAnomalySummary = summarizeLoadedInventoryAnomalies(inventoryAnomalyLots);
  const inventoryWarning: TransferInventoryWarning | null = inventoryAnomalyLots.length > 0
    ? {
        count: inventoryAnomalyLots.length,
        absoluteDiffPc: [...inventoryAnomalySummary.values()].reduce(
          (sum, summary) => sum + summary.absoluteDiffPc,
          0,
        ),
        erpPartNos: [...new Set(inventoryAnomalyLots.map((lot) => lot.erpPartNo))],
        lots: inventoryAnomalyLots,
      }
    : null;
  if (inventoryWarning && !deps.inventoryAnomalyAcknowledged) {
    throw new InventoryAnomalyConfirmationRequiredError(inventoryWarning);
  }

  await recoverStalePendingTransfers(client, transferScope);

  // Atomic claim：只有 idle/failed 才搶得到。pending/unknown 一律鎖住，
  // 避免 Ragic 已收單但 response 遺失時，使用者重試又送出第二筆。
  // 同 (runId, partVersion, planSequence) 並發 PATCH 只有一個會 count===1，
  // 其他都 count===0 直接拒絕，避免雙擊 / 504 retry 送兩筆 Ragic Form[10]。
  // 明確失敗才允許重試；逾時或斷線保留 unknown 並鎖住，等待人工對帳。
  const claim = await client.fgPlanSuggestion.updateMany({
    where: {
      mrpRunId: runId,
      partVersion,
      planSequence,
      isTransferred: false,
      transferStatus: { in: [TRANSFER_STATUS.IDLE, TRANSFER_STATUS.FAILED] },
    },
    data: {
      transferStatus: TRANSFER_STATUS.PENDING,
      transferError: null,
      transferStartedAt: now(),
    },
  });

  if (claim.count === 0) {
    const existing = await client.fgPlanSuggestion.findUnique({ where: suggestionKey });
    if (!existing) throw new Error('找不到規劃建議，請先儲存後再轉單。');
    if (existing.isTransferred) throw new Error('此規劃已轉單，請勿重複轉。');
    if (existing.transferStatus === TRANSFER_STATUS.UNKNOWN) {
      throw new TransferStateConflictError(
        existing.transferError || '前次轉單結果待確認，為避免重複建單已暫停重試。',
        TRANSFER_STATUS.UNKNOWN,
      );
    }
    if (existing.transferStatus === TRANSFER_STATUS.PENDING) {
      throw new TransferStateConflictError('此規劃正在轉單，請勿重複送出。', TRANSFER_STATUS.PENDING);
    }
    throw new Error('搶轉單失敗（原因不明）');
  }

  const suggestion = await client.fgPlanSuggestion.findUnique({ where: suggestionKey }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await markPendingTransferUnknown(client, transferScope, msg);
    } catch (recoveryErr) {
      console.error('[轉單] 無法標記中斷中的 pending claim:', recoveryErr);
    }
    throw err;
  });

  if (!suggestion) {
    await markPendingTransferUnknown(client, transferScope, 'Claim 成功後找不到規劃建議。');
    throw new Error('找不到規劃建議。');
  }

  const targetQty = parsePositivePlanQty(suggestion.suggestedQty);
  if (targetQty === null) {
    const msg = '生產計畫量必須為大於 0 的數字。';
    await client.fgPlanSuggestion.update({
      where: suggestionKey,
      data: {
        transferStatus: TRANSFER_STATUS.FAILED,
        transferError: msg,
        transferStartedAt: null,
        isTransferred: false,
        transferredAt: null,
      },
    });
    throw new Error(msg);
  }

  // Format completion date as YYYY/MM/DD for Ragic
  const compDate = suggestion.completionDate
    ? formatRagicDate(suggestion.completionDate)
    : '';

  const ragicData: Record<string, string | number> = {
    [FORM10_FIELDS.customerCode]: fgSummary?.customerCode || '',
    [FORM10_FIELDS.partVersion]: partVersion,
    [FORM10_FIELDS.targetQty]: targetQty,
    [FORM10_FIELDS.targetDate]: compDate,
    [FORM10_FIELDS.mrpSourceCode]: versionCode,
    [FORM10_FIELDS.autoCreateWorkOrder]: 'No',
  };

  console.log(`[轉單] Creating Form[10] entry for ${partVersion} #${planSequence}:`, ragicData);

  let ragicResult: RagicCreateResult;
  try {
    ragicResult = await createRecord('/default/d4/10', ragicData, {
      doFormula: true,
      doDefaultValue: true,
      doLinkLoad: 'first',
      doWorkflow: true,
    });
  } catch (ragicErr) {
    const msg = ragicErr instanceof Error ? ragicErr.message : String(ragicErr);
    const outcome = ragicErr instanceof RagicCreateError ? ragicErr.outcome : 'unknown';
    const transferStatus = outcome === 'definite_failure'
      ? TRANSFER_STATUS.FAILED
      : TRANSFER_STATUS.UNKNOWN;
    await client.fgPlanSuggestion.update({
      where: suggestionKey,
      data: {
        transferStatus,
        transferError: msg,
        transferStartedAt: null,
        isTransferred: false,
        transferredAt: null,
      },
    });
    console.error(`[轉單] ✗ Ragic API failed:`, msg);
    if (transferStatus === TRANSFER_STATUS.UNKNOWN) {
      throw new TransferStateConflictError(
        'Ragic 回應逾時或中斷，可能已建單；請先到 Ragic 確認，系統已鎖定重試以避免重複。',
        TRANSFER_STATUS.UNKNOWN,
      );
    }
    throw new Error(`Ragic API 錯誤: ${msg}`);
  }

  const ragicRecordId = ragicResult.id;
  const ragicUrl = ragicRecordId
    ? `${config.ragicBaseUrl}/default/d4/10/${ragicRecordId}`
    : null;

  // Extract 生產計劃編號 from Ragic response (field 1006542)
  const raw = ragicResult.rawResponse;
  let ragicPlanNo: string | null = null;

  // 1) Check inside raw.data
  if (raw.data && typeof raw.data === 'object') {
    const dataObj = raw.data as Record<string, unknown>;
    if (typeof dataObj[FORM10_FIELDS.planNo] === 'string' && dataObj[FORM10_FIELDS.planNo]) {
      ragicPlanNo = dataObj[FORM10_FIELDS.planNo] as string;
    }
  }

  // 2) Check nested by record ID: { "5188": { "1006542": "PP..." } }
  if (!ragicPlanNo && ragicRecordId && raw[ragicRecordId] && typeof raw[ragicRecordId] === 'object') {
    ragicPlanNo = (raw[ragicRecordId] as Record<string, string>)[FORM10_FIELDS.planNo] || null;
  }

  // 3) Check top-level field
  if (!ragicPlanNo && typeof raw[FORM10_FIELDS.planNo] === 'string') {
    ragicPlanNo = raw[FORM10_FIELDS.planNo] as string;
  }

  // POST 已明確成功就先落本機成功狀態。自動單號的唯讀補查可能重試數分鐘，
  // 不應讓 suggestion 在這段期間仍停留 pending，否則 recovery 可能誤轉 unknown。
  try {
    await client.$transaction([
      client.productionPlanTransfer.create({
        data: {
          mrpRunId: runId,
          mrpVersionCode: versionCode,
          partVersion,
          planSequence,
          customerCode: fgSummary?.customerCode || null,
          suggestedQty: targetQty,
          completionDate: suggestion.completionDate,
          ragicRecordId,
          ragicPlanNo,
          ragicUrl,
          sentData: ragicData as object,
          ragicResponse: ragicResult.rawResponse as object,
          inventoryWarning: inventoryWarning
            ? inventoryWarning as unknown as Prisma.InputJsonValue
            : undefined,
        },
      }),
      client.fgPlanSuggestion.update({
        where: suggestionKey,
        data: {
          isTransferred: true,
          transferredAt: now(),
          transferStatus: TRANSFER_STATUS.SUCCEEDED,
          transferError: null,
          transferStartedAt: null,
        },
      }),
    ]);
  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    try {
      await markPendingTransferUnknown(client, transferScope, msg);
    } catch (recoveryErr) {
      console.error('[轉單] 本地記錄失敗，且無法將 pending 標為 unknown:', recoveryErr);
    }
    throw new TransferStateConflictError(
      'Ragic 已回傳建單成功，但本地記錄失敗；請先確認 Ragic，系統已鎖定重試。',
      TRANSFER_STATUS.UNKNOWN,
    );
  }

  // 4) Fallback: GET the newly created record to read the auto-generated plan number.
  // This enrichment is best-effort; the durable transfer succeeded above.
  if (!ragicPlanNo && ragicRecordId) {
    console.log(`[轉單] Plan No not in POST response, fetching record ${ragicRecordId}...`);
    try {
      const records = await fetchListing({
        path: `/default/d4/10/${ragicRecordId}`,
        listing: false,
      });
      if (records.length > 0 && records[0][FORM10_FIELDS.planNo]) {
        ragicPlanNo = records[0][FORM10_FIELDS.planNo];
        await client.productionPlanTransfer.updateMany({
          where: { mrpRunId: runId, partVersion, planSequence, ragicRecordId },
          data: { ragicPlanNo },
        });
      }
    } catch (getErr) {
      console.warn(`[轉單] Could not enrich record ${ragicRecordId} with plan number:`, getErr);
    }
  }

  console.log(`[轉單] ✓ Record ID: ${ragicRecordId}, Plan No: ${ragicPlanNo}, URL: ${ragicUrl}`);

  return { ragicRecordId, ragicPlanNo, ragicUrl };
}
