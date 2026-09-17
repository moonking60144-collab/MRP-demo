import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/db';
import { config } from '@/lib/config';
import {
  executeRagicActionButton,
  fetchRagicActionButtons,
  fetchRagicRecord,
  RagicActionButtonError,
} from '@/lib/ragic-client';
import { FORM10_FIELDS } from '@/lib/sync/field-maps';
import {
  assertMatchingProductionPlanRecord,
  TransferReconciliationError,
} from '@/lib/mrp/transfer-reconciliation';
import {
  WORK_ORDER_STATUS,
  WorkOrderStateConflictError,
  type WorkOrderStatus,
} from '@/lib/work-order-state';
import { emitWorkOrderStatus } from '@/lib/mrp/work-order-events';

export const WORK_ORDER_BUTTON_ID = '92';
export const WORK_ORDER_PENDING_STALE_MS = 10 * 60_000;

const FORM10_PATH = '/default/d4/10';
const INTERRUPTED_MESSAGE =
  '工令產生流程中斷，Ragic 結果待確認；系統已鎖定重試以避免重跑製程。';
const PARTIAL_MESSAGE =
  'Ragic 生產計畫只有部分製程列出現工令單號；系統已鎖定重跑，避免刪除或重建既有工令。';

type WorkOrderClient = Pick<PrismaClient, 'productionPlanTransfer'>;
type WorkOrderScope = Pick<
  Prisma.ProductionPlanTransferWhereInput,
  'id' | 'mrpRunId'
>;

export interface WorkOrderGenerationResult {
  transferId: number;
  workOrderStatus: WorkOrderStatus;
  workOrderCompletedAt: Date | null;
  alreadyGenerated: boolean;
  ragicUrl: string | null;
}

export interface WorkOrderEnqueueResult {
  transferId: number;
  workOrderStatus: WorkOrderStatus;
  accepted: boolean;
  alreadyGenerated: boolean;
  ragicUrl: string | null;
}

export interface ProductionPlanRecordLinkResult {
  transferId: number;
  ragicRecordId: string;
  ragicPlanNo: string | null;
  ragicUrl: string;
  workOrderStatus: WorkOrderStatus;
  workOrderError: string | null;
}

export interface WorkOrderGenerationDeps {
  client?: typeof prisma;
  fetchRecord?: typeof fetchRagicRecord;
  fetchButtons?: typeof fetchRagicActionButtons;
  executeButton?: typeof executeRagicActionButton;
  now?: () => Date;
}

export type WorkOrderProgress = 'none' | 'partial' | 'complete';

export interface WorkOrderProgressResult {
  state: WorkOrderProgress;
  totalRows: number;
  generatedRows: number;
}

export function inspectWorkOrderProgress(
  record: Record<string, unknown>,
): WorkOrderProgressResult {
  const rawRows = record[`_subtable_${FORM10_FIELDS.processSubtable}`];
  const values = Array.isArray(rawRows)
    ? rawRows
    : rawRows && typeof rawRows === 'object'
      ? Object.values(rawRows)
      : [];
  const rows = values.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
  const generatedRows = rows.filter(
    (row) => String(row[FORM10_FIELDS.workOrderNo] ?? '').trim() !== '',
  ).length;
  const totalRows = rows.length;
  const summaryClaimsWorkOrder = String(record[FORM10_FIELDS.hasWorkOrderNo] ?? '').trim() === 'Yes';

  if (totalRows > 0 && generatedRows === totalRows) {
    return { state: 'complete', totalRows, generatedRows };
  }
  if (generatedRows > 0 || summaryClaimsWorkOrder) {
    return { state: 'partial', totalRows, generatedRows };
  }
  return { state: 'none', totalRows, generatedRows };
}

export async function attachProductionPlanRecordId(
  transferId: number,
  latestRunId: number,
  rawRecordId: string,
  deps: Pick<WorkOrderGenerationDeps, 'client' | 'fetchRecord'> = {},
): Promise<ProductionPlanRecordLinkResult> {
  const client = deps.client ?? prisma;
  const fetchRecord = deps.fetchRecord ?? fetchRagicRecord;
  const ragicRecordId = rawRecordId.trim();
  if (!/^\d+$/.test(ragicRecordId) || Number(ragicRecordId) <= 0) {
    throw new TransferReconciliationError('請輸入有效的 Ragic Record ID。', 400);
  }

  const transfer = await client.productionPlanTransfer.findUnique({
    where: { id: transferId },
    include: { mrpRun: { select: { createdAt: true } } },
  });
  if (!transfer) {
    throw new WorkOrderStateConflictError('找不到生產計畫轉單紀錄。', WORK_ORDER_STATUS.IDLE, 404);
  }
  if (transfer.mrpRunId !== latestRunId) {
    throw new WorkOrderStateConflictError(
      '歷史 MRP 版本僅供查閱，不能連結生產計畫。請切換到最新 MRP。',
      transfer.workOrderStatus as WorkOrderStatus,
      409,
    );
  }
  if (!transfer.mrpRun) {
    throw new WorkOrderStateConflictError(
      '找不到生產計畫對應的 MRP Run，不能安全連結 Ragic Record。',
      transfer.workOrderStatus as WorkOrderStatus,
      409,
    );
  }
  if (transfer.ragicRecordId) {
    if (transfer.ragicRecordId !== ragicRecordId) {
      throw new TransferReconciliationError(
        `本機已有不同的 Ragic Record ID（${transfer.ragicRecordId}），未變更任何狀態。`,
        409,
      );
    }
    return {
      transferId,
      ragicRecordId,
      ragicPlanNo: transfer.ragicPlanNo,
      ragicUrl: transfer.ragicUrl ?? `${config.ragicBaseUrl}${FORM10_PATH}/${ragicRecordId}`,
      workOrderStatus: transfer.workOrderStatus as WorkOrderStatus,
      workOrderError: transfer.workOrderError,
    };
  }

  let record: Record<string, unknown>;
  try {
    record = await fetchRecord({ path: FORM10_PATH, recordId: ragicRecordId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TransferReconciliationError(`無法讀取 Ragic Record ${ragicRecordId}：${message}`, 502);
  }

  assertMatchingProductionPlanRecord(record, {
    partVersion: transfer.partVersion,
    versionCode: transfer.mrpVersionCode,
    runCreatedAt: transfer.mrpRun.createdAt,
    suggestedQty: Number(transfer.suggestedQty) || 0,
    completionDate: transfer.completionDate,
  });

  const ragicPlanNo = String(record[FORM10_FIELDS.planNo] ?? '').trim() || null;
  const ragicUrl = `${config.ragicBaseUrl}${FORM10_PATH}/${ragicRecordId}`;
  const updated = await client.productionPlanTransfer.updateMany({
    where: {
      id: transferId,
      mrpRunId: latestRunId,
      ragicRecordId: null,
    },
    data: {
      ragicRecordId,
      ragicPlanNo,
      ragicUrl,
    },
  });
  if (updated.count !== 1) {
    throw new TransferReconciliationError('狀態已被其他使用者更新，請重新整理後確認。', 409);
  }

  return {
    transferId,
    ragicRecordId,
    ragicPlanNo,
    ragicUrl,
    workOrderStatus: transfer.workOrderStatus as WorkOrderStatus,
    workOrderError: transfer.workOrderError,
  };
}

export async function recoverStaleWorkOrderGenerations(
  client: WorkOrderClient,
  scope: WorkOrderScope,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WORK_ORDER_PENDING_STALE_MS);
  const result = await client.productionPlanTransfer.updateMany({
    where: {
      ...scope,
      workOrderStatus: WORK_ORDER_STATUS.PENDING,
      OR: [
        { workOrderStartedAt: null },
        { workOrderStartedAt: { lt: cutoff } },
      ],
    },
    data: {
      workOrderStatus: WORK_ORDER_STATUS.UNKNOWN,
      workOrderError: INTERRUPTED_MESSAGE,
      workOrderStartedAt: null,
    },
  });
  return result.count;
}

export async function enqueueWorkOrderGeneration(
  transferId: number,
  latestRunId: number,
  deps: Pick<WorkOrderGenerationDeps, 'client' | 'now'> = {},
): Promise<WorkOrderEnqueueResult> {
  const client = deps.client ?? prisma;
  const now = deps.now ?? (() => new Date());

  await recoverStaleWorkOrderGenerations(client, { id: transferId }, now());
  const transfer = await client.productionPlanTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) {
    throw new WorkOrderStateConflictError('找不到生產計畫轉單紀錄。', WORK_ORDER_STATUS.IDLE, 404);
  }
  const currentStatus = transfer.workOrderStatus as WorkOrderStatus;
  if (transfer.mrpRunId !== latestRunId) {
    throw new WorkOrderStateConflictError(
      '歷史 MRP 版本僅供查閱，不能產生工令單。請切換到最新 MRP。',
      currentStatus,
    );
  }
  if (!transfer.ragicRecordId) {
    throw new WorkOrderStateConflictError(
      '這筆生產計畫沒有 Ragic Record ID，無法執行工令產生。',
      currentStatus,
    );
  }
  if (currentStatus === WORK_ORDER_STATUS.SUCCEEDED) {
    return {
      transferId,
      workOrderStatus: currentStatus,
      accepted: false,
      alreadyGenerated: true,
      ragicUrl: transfer.ragicUrl,
    };
  }
  if (currentStatus === WORK_ORDER_STATUS.QUEUED || currentStatus === WORK_ORDER_STATUS.PENDING) {
    return {
      transferId,
      workOrderStatus: currentStatus,
      accepted: false,
      alreadyGenerated: false,
      ragicUrl: transfer.ragicUrl,
    };
  }
  if (currentStatus === WORK_ORDER_STATUS.UNKNOWN) {
    throw new WorkOrderStateConflictError(
      transfer.workOrderError || '前次工令產生結果待確認；請先檢查 Ragic 狀態。',
      currentStatus,
    );
  }

  const queuedAt = now();
  const claim = await client.productionPlanTransfer.updateMany({
    where: {
      id: transferId,
      mrpRunId: latestRunId,
      workOrderStatus: { in: [WORK_ORDER_STATUS.IDLE, WORK_ORDER_STATUS.FAILED] },
    },
    data: {
      workOrderStatus: WORK_ORDER_STATUS.QUEUED,
      workOrderError: null,
      workOrderStartedAt: queuedAt,
      workOrderCompletedAt: null,
    },
  });
  if (claim.count !== 1) {
    const current = await client.productionPlanTransfer.findUnique({ where: { id: transferId } });
    const status = (current?.workOrderStatus ?? WORK_ORDER_STATUS.UNKNOWN) as WorkOrderStatus;
    if (status === WORK_ORDER_STATUS.QUEUED || status === WORK_ORDER_STATUS.PENDING || status === WORK_ORDER_STATUS.SUCCEEDED) {
      return {
        transferId,
        workOrderStatus: status,
        accepted: false,
        alreadyGenerated: status === WORK_ORDER_STATUS.SUCCEEDED,
        ragicUrl: current?.ragicUrl ?? transfer.ragicUrl,
      };
    }
    throw new WorkOrderStateConflictError('狀態已被其他使用者更新，請重新整理後確認。', status);
  }

  emitWorkOrderStatus({
    transferId,
    workOrderStatus: WORK_ORDER_STATUS.QUEUED,
    workOrderError: null,
    workOrderStartedAt: queuedAt.toISOString(),
    workOrderCompletedAt: null,
  });
  return {
    transferId,
    workOrderStatus: WORK_ORDER_STATUS.QUEUED,
    accepted: true,
    alreadyGenerated: false,
    ragicUrl: transfer.ragicUrl,
  };
}

export async function generateWorkOrders(
  transferId: number,
  latestRunId: number,
  deps: WorkOrderGenerationDeps = {},
): Promise<WorkOrderGenerationResult> {
  const client = deps.client ?? prisma;
  const fetchRecord = deps.fetchRecord ?? fetchRagicRecord;
  const fetchButtons = deps.fetchButtons ?? fetchRagicActionButtons;
  const executeButton = deps.executeButton ?? executeRagicActionButton;
  const now = deps.now ?? (() => new Date());

  await recoverStaleWorkOrderGenerations(client, { id: transferId }, now());
  let transfer = await client.productionPlanTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) {
    throw new WorkOrderStateConflictError('找不到生產計畫轉單紀錄。', WORK_ORDER_STATUS.IDLE, 404);
  }
  if (transfer.mrpRunId !== latestRunId) {
    throw new WorkOrderStateConflictError(
      '歷史 MRP 版本僅供查閱，不能產生工令單。請切換到最新 MRP。',
      transfer.workOrderStatus as WorkOrderStatus,
      409,
    );
  }
  if (!transfer.ragicRecordId) {
    throw new WorkOrderStateConflictError(
      '這筆生產計畫沒有 Ragic Record ID，無法執行工令產生。',
      transfer.workOrderStatus as WorkOrderStatus,
      409,
    );
  }
  if (transfer.workOrderStatus === WORK_ORDER_STATUS.SUCCEEDED) {
    return {
      transferId,
      workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
      workOrderCompletedAt: transfer.workOrderCompletedAt,
      alreadyGenerated: true,
      ragicUrl: transfer.ragicUrl,
    };
  }
  if (transfer.workOrderStatus === WORK_ORDER_STATUS.PENDING) {
    throw new WorkOrderStateConflictError(
      '這筆生產計畫正在產生工令單，請勿重複送出。',
      WORK_ORDER_STATUS.PENDING,
    );
  }

  let record: Record<string, unknown>;
  try {
    record = await fetchRecord({ path: FORM10_PATH, recordId: transfer.ragicRecordId });
  } catch (err) {
    const message = `無法讀取 Ragic 生產計畫：${err instanceof Error ? err.message : String(err)}`;
    if (transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED) {
      await client.productionPlanTransfer.updateMany({
        where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.QUEUED },
        data: {
          workOrderStatus: WORK_ORDER_STATUS.FAILED,
          workOrderError: message,
          workOrderStartedAt: null,
        },
      });
    }
    throw new WorkOrderStateConflictError(
      message,
      transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED
        ? WORK_ORDER_STATUS.FAILED
        : transfer.workOrderStatus as WorkOrderStatus,
      502,
    );
  }

  const existingProgress = inspectWorkOrderProgress(record);
  if (existingProgress.state === 'complete') {
    const completedAt = transfer.workOrderCompletedAt ?? now();
    transfer = await client.productionPlanTransfer.update({
      where: { id: transferId },
      data: {
        workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
        workOrderError: null,
        workOrderStartedAt: null,
        workOrderCompletedAt: completedAt,
      },
    });
    return {
      transferId,
      workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
      workOrderCompletedAt: transfer.workOrderCompletedAt,
      alreadyGenerated: true,
      ragicUrl: transfer.ragicUrl,
    };
  }

  if (existingProgress.state === 'partial') {
    await client.productionPlanTransfer.updateMany({
      where: {
        id: transferId,
        workOrderStatus: {
          in: [WORK_ORDER_STATUS.IDLE, WORK_ORDER_STATUS.FAILED, WORK_ORDER_STATUS.UNKNOWN, WORK_ORDER_STATUS.QUEUED],
        },
      },
      data: {
        workOrderStatus: WORK_ORDER_STATUS.UNKNOWN,
        workOrderError: PARTIAL_MESSAGE,
        workOrderStartedAt: null,
      },
    });
    throw new WorkOrderStateConflictError(
      `${PARTIAL_MESSAGE}（${existingProgress.generatedRows}/${existingProgress.totalRows || '?'} 列）`,
      WORK_ORDER_STATUS.UNKNOWN,
    );
  }

  if (transfer.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN) {
    throw new WorkOrderStateConflictError(
      transfer.workOrderError || '前次工令產生結果待確認；請先開啟 Ragic 檢查，不可直接重跑。',
      WORK_ORDER_STATUS.UNKNOWN,
    );
  }

  let buttons: Awaited<ReturnType<typeof fetchRagicActionButtons>>;
  try {
    buttons = await fetchButtons(FORM10_PATH);
  } catch (error) {
    const message = `無法讀取 Ragic Button 清單：${error instanceof Error ? error.message : String(error)}`;
    if (transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED) {
      await client.productionPlanTransfer.updateMany({
        where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.QUEUED },
        data: {
          workOrderStatus: WORK_ORDER_STATUS.FAILED,
          workOrderError: message,
          workOrderStartedAt: null,
        },
      });
    }
    throw new WorkOrderStateConflictError(
      message,
      transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED
        ? WORK_ORDER_STATUS.FAILED
        : transfer.workOrderStatus as WorkOrderStatus,
      502,
    );
  }
  if (!buttons.some((button) => button.id === WORK_ORDER_BUTTON_ID)) {
    if (transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED) {
      await client.productionPlanTransfer.updateMany({
        where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.QUEUED },
        data: {
          workOrderStatus: WORK_ORDER_STATUS.FAILED,
          workOrderError: 'Ragic Button 92 尚未開放給 API 帳號執行。',
          workOrderStartedAt: null,
        },
      });
    }
    throw new WorkOrderStateConflictError(
      'Ragic Button 92「載入製程並推估時間」尚未開放給 API 帳號執行。請先在 Form [10] 將此按鈕開放為 API／大量操作可用。',
      transfer.workOrderStatus === WORK_ORDER_STATUS.QUEUED
        ? WORK_ORDER_STATUS.FAILED
        : transfer.workOrderStatus as WorkOrderStatus,
      503,
    );
  }

  const startedAt = now();
  const claim = await client.productionPlanTransfer.updateMany({
    where: {
      id: transferId,
      workOrderStatus: { in: [WORK_ORDER_STATUS.IDLE, WORK_ORDER_STATUS.FAILED, WORK_ORDER_STATUS.QUEUED] },
    },
    data: {
      workOrderStatus: WORK_ORDER_STATUS.PENDING,
      workOrderError: null,
      workOrderStartedAt: startedAt,
    },
  });
  if (claim.count === 0) {
    const current = await client.productionPlanTransfer.findUnique({ where: { id: transferId } });
    throw new WorkOrderStateConflictError(
      current?.workOrderStatus === WORK_ORDER_STATUS.SUCCEEDED
        ? '這筆生產計畫已產生工令單。'
        : '這筆生產計畫已由其他使用者開始處理，請勿重複送出。',
      (current?.workOrderStatus ?? WORK_ORDER_STATUS.UNKNOWN) as WorkOrderStatus,
    );
  }

  emitWorkOrderStatus({
    transferId,
    workOrderStatus: WORK_ORDER_STATUS.PENDING,
    workOrderError: null,
    workOrderStartedAt: startedAt.toISOString(),
    workOrderCompletedAt: null,
  });

  let actionResponse: Record<string, unknown>;
  try {
    actionResponse = await executeButton(FORM10_PATH, transfer.ragicRecordId, WORK_ORDER_BUTTON_ID);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isDefiniteFailure = err instanceof RagicActionButtonError
      && err.outcome === 'definite_failure';
    const nextStatus = isDefiniteFailure
      ? WORK_ORDER_STATUS.FAILED
      : WORK_ORDER_STATUS.UNKNOWN;
    await client.productionPlanTransfer.updateMany({
      where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.PENDING },
      data: {
        workOrderStatus: nextStatus,
        workOrderError: message,
        workOrderStartedAt: null,
      },
    });
    if (isDefiniteFailure) {
      throw new WorkOrderStateConflictError(
        `Ragic 明確拒絕執行 Button 92，未產生工令單；修正權限或資料後可重試。${message}`,
        WORK_ORDER_STATUS.FAILED,
        409,
      );
    }
    throw new WorkOrderStateConflictError(
      'Ragic Button 92 回應中斷或失敗，可能已產生部分資料；系統已鎖定重跑，請開啟 Ragic 確認。',
      WORK_ORDER_STATUS.UNKNOWN,
      502,
    );
  }

  try {
    record = await fetchRecord({ path: FORM10_PATH, recordId: transfer.ragicRecordId });
  } catch (err) {
    const message = `Button 92 已回傳成功，但無法驗證工令單：${err instanceof Error ? err.message : String(err)}`;
    await client.productionPlanTransfer.updateMany({
      where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.PENDING },
      data: {
        workOrderStatus: WORK_ORDER_STATUS.UNKNOWN,
        workOrderError: message,
        workOrderStartedAt: null,
        workOrderResponse: actionResponse as Prisma.InputJsonObject,
      },
    });
    throw new WorkOrderStateConflictError(message, WORK_ORDER_STATUS.UNKNOWN, 502);
  }

  const completedProgress = inspectWorkOrderProgress(record);
  if (completedProgress.state !== 'complete') {
    const message = completedProgress.state === 'partial'
      ? `${PARTIAL_MESSAGE}（${completedProgress.generatedRows}/${completedProgress.totalRows || '?'} 列）`
      : 'Button 92 已回傳成功，但 Ragic 製程列尚未出現工令單號；系統已鎖定重跑，請人工確認。';
    await client.productionPlanTransfer.updateMany({
      where: { id: transferId, workOrderStatus: WORK_ORDER_STATUS.PENDING },
      data: {
        workOrderStatus: WORK_ORDER_STATUS.UNKNOWN,
        workOrderError: message,
        workOrderStartedAt: null,
        workOrderResponse: actionResponse as Prisma.InputJsonObject,
      },
    });
    throw new WorkOrderStateConflictError(message, WORK_ORDER_STATUS.UNKNOWN, 409);
  }

  const completedAt = now();
  transfer = await client.productionPlanTransfer.update({
    where: { id: transferId },
    data: {
      workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
      workOrderError: null,
      workOrderStartedAt: null,
      workOrderCompletedAt: completedAt,
      workOrderResponse: actionResponse as Prisma.InputJsonObject,
    },
  });

  return {
    transferId,
    workOrderStatus: WORK_ORDER_STATUS.SUCCEEDED,
    workOrderCompletedAt: transfer.workOrderCompletedAt,
    alreadyGenerated: false,
    ragicUrl: transfer.ragicUrl,
  };
}
