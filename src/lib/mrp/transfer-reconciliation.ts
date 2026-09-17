import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/db';
import { config } from '@/lib/config';
import { fetchRagicListing, fetchRagicRecord } from '@/lib/ragic-client';
import { FORM10_FIELDS } from '@/lib/sync/field-maps';
import { TRANSFER_STATUS } from '@/lib/transfer-state';

export const TRANSFER_RECONCILIATION_ACTION = {
  INSPECT: 'inspect',
  CONFIRM_CREATED: 'confirm_created',
  CONFIRM_NOT_CREATED: 'confirm_not_created',
} as const;

export type TransferReconciliationAction =
  (typeof TRANSFER_RECONCILIATION_ACTION)[keyof typeof TRANSFER_RECONCILIATION_ACTION];

export class TransferReconciliationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TransferReconciliationError';
  }
}

interface UnknownTransferScope {
  runId: number;
  runCreatedAt: Date;
  versionCode: string;
  partVersion: string;
  planSequence: number;
}

interface ReconcileUnknownTransferInput extends UnknownTransferScope {
  action:
    | typeof TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED
    | typeof TRANSFER_RECONCILIATION_ACTION.CONFIRM_NOT_CREATED;
  ragicRecordId?: string;
}

interface ReconcileUnknownTransferDeps {
  client?: PrismaClient;
  fetchListing?: typeof fetchRagicListing;
  fetchRecord?: typeof fetchRagicRecord;
  now?: () => Date;
}

export interface TransferReconciliationCandidate {
  ragicRecordId: string;
  ragicPlanNo: string | null;
  suggestedQty: number;
  completionDate: string;
  createdAt: string | null;
  mrpSourceCode: string | null;
  ragicUrl: string;
}

export interface InspectUnknownTransferResult {
  action: typeof TRANSFER_RECONCILIATION_ACTION.INSPECT;
  matchStatus: 'not_found' | 'single_match' | 'multiple_matches';
  candidates: TransferReconciliationCandidate[];
}

export interface ReconcileUnknownTransferResult {
  action: TransferReconciliationAction;
  transferStatus: typeof TRANSFER_STATUS.SUCCEEDED | typeof TRANSFER_STATUS.FAILED;
  ragicRecordId: string | null;
  ragicPlanNo: string | null;
  ragicUrl: string | null;
}

function textValue(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function numberValue(value: unknown): number {
  const text = textValue(value);
  return text ? Number(text.replace(/,/g, '')) : Number.NaN;
}

function dateValue(value: unknown): string {
  return textValue(value).slice(0, 10).replace(/-/g, '/');
}

function expectedDateValue(value: Date | null): string {
  if (!value) return '';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function taipeiDateTimeValue(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function isPlausibleRunCandidate(
  sourceCode: string,
  createdAt: string,
  versionCode: string,
  runCreatedAt: Date,
): boolean {
  if (sourceCode === versionCode) return true;
  if (sourceCode || !createdAt) return false;
  const normalizedCreatedAt = createdAt.replace(/\//g, '-').slice(0, 19);
  return normalizedCreatedAt >= taipeiDateTimeValue(runCreatedAt);
}

async function loadUnknownSuggestion(client: PrismaClient, input: UnknownTransferScope) {
  const suggestion = await client.fgPlanSuggestion.findUnique({
    where: {
      mrpRunId_partVersion_planSequence: {
        mrpRunId: input.runId,
        partVersion: input.partVersion,
        planSequence: input.planSequence,
      },
    },
  });

  if (!suggestion) {
    throw new TransferReconciliationError('找不到規劃建議。', 404);
  }
  if (suggestion.isTransferred || suggestion.transferStatus !== TRANSFER_STATUS.UNKNOWN) {
    throw new TransferReconciliationError('此規劃已不是待確認狀態，請重新整理後再操作。', 409);
  }
  return suggestion;
}

async function findMatchingCandidates(
  input: UnknownTransferScope,
  suggestedQty: number,
  completionDate: Date | null,
  fetchListing: typeof fetchRagicListing,
): Promise<TransferReconciliationCandidate[]> {
  let records;
  try {
    records = await fetchListing({
      path: '/default/d4/10',
      listing: false,
      includeSubtables: false,
      limit: 1000,
      fetchDomainIds: [
        FORM10_FIELDS.planNo,
        FORM10_FIELDS.createdAt,
        FORM10_FIELDS.partVersion,
        FORM10_FIELDS.targetQty,
        FORM10_FIELDS.targetDate,
        FORM10_FIELDS.mrpSourceCode,
      ],
      where: [{
        fieldId: FORM10_FIELDS.partVersion,
        operator: 'eq',
        value: input.partVersion,
      }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TransferReconciliationError(`目前無法連線 Ragic，尚未解除轉單鎖定：${message}`, 502);
  }

  const expectedDate = expectedDateValue(completionDate);
  return records
    .filter((record) => {
      const sourceCode = textValue(record[FORM10_FIELDS.mrpSourceCode]);
      const createdAt = textValue(record[FORM10_FIELDS.createdAt]);
      const qty = numberValue(record[FORM10_FIELDS.targetQty]);
      return textValue(record[FORM10_FIELDS.partVersion]) === input.partVersion
        && Number.isFinite(qty)
        && Math.abs(qty - suggestedQty) <= 0.000001
        && dateValue(record[FORM10_FIELDS.targetDate]) === expectedDate
        && isPlausibleRunCandidate(sourceCode, createdAt, input.versionCode, input.runCreatedAt);
    })
    .map((record) => ({
      ragicRecordId: record._ragic_id,
      ragicPlanNo: textValue(record[FORM10_FIELDS.planNo]) || null,
      suggestedQty: numberValue(record[FORM10_FIELDS.targetQty]),
      completionDate: dateValue(record[FORM10_FIELDS.targetDate]),
      createdAt: textValue(record[FORM10_FIELDS.createdAt]) || null,
      mrpSourceCode: textValue(record[FORM10_FIELDS.mrpSourceCode]) || null,
      ragicUrl: `${config.ragicBaseUrl}/default/d4/10/${record._ragic_id}`,
    }))
    .sort((left, right) => Number(right.ragicRecordId) - Number(left.ragicRecordId));
}

export async function inspectUnknownTransfer(
  input: UnknownTransferScope,
  deps: ReconcileUnknownTransferDeps = {},
): Promise<InspectUnknownTransferResult> {
  const client = deps.client ?? prisma;
  const suggestion = await loadUnknownSuggestion(client, input);
  const candidates = await findMatchingCandidates(
    input,
    Number(suggestion.suggestedQty) || 0,
    suggestion.completionDate,
    deps.fetchListing ?? fetchRagicListing,
  );
  return {
    action: TRANSFER_RECONCILIATION_ACTION.INSPECT,
    matchStatus: candidates.length === 0
      ? 'not_found'
      : candidates.length === 1
        ? 'single_match'
        : 'multiple_matches',
    candidates,
  };
}

export function assertMatchingProductionPlanRecord(
  record: Record<string, unknown>,
  expected: {
    partVersion: string;
    versionCode: string;
    runCreatedAt: Date;
    suggestedQty: number;
    completionDate: Date | null;
  },
) {
  const actualPartVersion = textValue(record[FORM10_FIELDS.partVersion]);
  if (actualPartVersion !== expected.partVersion) {
    throw new TransferReconciliationError(
      `Record ID 對應的客料版本為「${actualPartVersion || '空白'}」，不是「${expected.partVersion}」。`,
      422,
    );
  }

  const actualVersionCode = textValue(record[FORM10_FIELDS.mrpSourceCode]);
  if (actualVersionCode && actualVersionCode !== expected.versionCode) {
    throw new TransferReconciliationError(
      `Record ID 對應的 MRP 版本為「${actualVersionCode || '空白'}」，不是「${expected.versionCode}」。`,
      422,
    );
  }
  const actualCreatedAt = textValue(record[FORM10_FIELDS.createdAt]);
  if (!isPlausibleRunCandidate(
    actualVersionCode,
    actualCreatedAt,
    expected.versionCode,
    expected.runCreatedAt,
  )) {
    throw new TransferReconciliationError(
      `Record ID 的建立時間「${actualCreatedAt || '空白'}」無法證實晚於本次 MRP Run，不能連結為本次轉單。`,
      422,
    );
  }

  const actualQty = numberValue(record[FORM10_FIELDS.targetQty]);
  if (!Number.isFinite(actualQty) || Math.abs(actualQty - expected.suggestedQty) > 0.000001) {
    throw new TransferReconciliationError(
      `Record ID 對應的數量為「${textValue(record[FORM10_FIELDS.targetQty]) || '空白'}」，不是「${expected.suggestedQty}」。`,
      422,
    );
  }

  const actualDate = dateValue(record[FORM10_FIELDS.targetDate]);
  const expectedDate = expectedDateValue(expected.completionDate);
  if (actualDate !== expectedDate) {
    throw new TransferReconciliationError(
      `Record ID 對應的完成日為「${actualDate || '空白'}」，不是「${expectedDate || '空白'}」。`,
      422,
    );
  }
}

export async function reconcileUnknownTransfer(
  input: ReconcileUnknownTransferInput,
  deps: ReconcileUnknownTransferDeps = {},
): Promise<ReconcileUnknownTransferResult> {
  const client = deps.client ?? prisma;
  const now = deps.now?.() ?? new Date();
  const suggestion = await loadUnknownSuggestion(client, input);

  if (input.action === TRANSFER_RECONCILIATION_ACTION.CONFIRM_NOT_CREATED) {
    const candidates = await findMatchingCandidates(
      input,
      Number(suggestion.suggestedQty) || 0,
      suggestion.completionDate,
      deps.fetchListing ?? fetchRagicListing,
    );
    if (candidates.length > 0) {
      throw new TransferReconciliationError(
        `Ragic 已找到 ${candidates.length} 筆相符生產計畫，請連結正確單據，不可標記為未建單。`,
        409,
      );
    }
    return client.$transaction(async (tx) => {
      const updated = await tx.fgPlanSuggestion.updateMany({
        where: {
          mrpRunId: input.runId,
          partVersion: input.partVersion,
          planSequence: input.planSequence,
          isTransferred: false,
          transferStatus: TRANSFER_STATUS.UNKNOWN,
        },
        data: {
          isTransferred: false,
          transferredAt: null,
          transferStatus: TRANSFER_STATUS.FAILED,
          transferError: '已人工確認 Ragic 未建立單據，可重新轉單。',
          transferStartedAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new TransferReconciliationError('狀態已被其他使用者更新，請重新整理後確認。', 409);
      }
      return {
        action: input.action,
        transferStatus: TRANSFER_STATUS.FAILED,
        ragicRecordId: null,
        ragicPlanNo: null,
        ragicUrl: null,
      };
    });
  }

  const ragicRecordId = textValue(input.ragicRecordId);
  if (!/^\d+$/.test(ragicRecordId) || Number(ragicRecordId) <= 0) {
    throw new TransferReconciliationError('請輸入有效的 Ragic Record ID。', 400);
  }

  let record: Record<string, unknown>;
  try {
    record = await (deps.fetchRecord ?? fetchRagicRecord)({
      path: '/default/d4/10',
      recordId: ragicRecordId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TransferReconciliationError(`無法讀取 Ragic Record ${ragicRecordId}：${message}`, 502);
  }

  const suggestedQty = Number(suggestion.suggestedQty) || 0;
  assertMatchingProductionPlanRecord(record, {
    partVersion: input.partVersion,
    versionCode: input.versionCode,
    runCreatedAt: input.runCreatedAt,
    suggestedQty,
    completionDate: suggestion.completionDate,
  });

  const ragicPlanNo = textValue(record[FORM10_FIELDS.planNo]) || null;
  const ragicUrl = `${config.ragicBaseUrl}/default/d4/10/${ragicRecordId}`;
  const fgSummary = await client.fgMonthly.findFirst({
    where: { mrpRunId: input.runId, partVersion: input.partVersion },
    select: { customerCode: true },
  });

  return client.$transaction(async (tx) => {
    const updated = await tx.fgPlanSuggestion.updateMany({
      where: {
        mrpRunId: input.runId,
        partVersion: input.partVersion,
        planSequence: input.planSequence,
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.UNKNOWN,
      },
      data: {
        isTransferred: true,
        transferredAt: now,
        transferStatus: TRANSFER_STATUS.SUCCEEDED,
        transferError: null,
        transferStartedAt: null,
      },
    });
    if (updated.count !== 1) {
      throw new TransferReconciliationError('狀態已被其他使用者更新，請重新整理後確認。', 409);
    }

    const existing = await tx.productionPlanTransfer.findFirst({
      where: {
        mrpRunId: input.runId,
        partVersion: input.partVersion,
        planSequence: input.planSequence,
      },
      orderBy: { id: 'desc' },
    });
    if (existing?.ragicRecordId && existing.ragicRecordId !== ragicRecordId) {
      throw new TransferReconciliationError(
        `本機已有不同的 Ragic Record ID（${existing.ragicRecordId}），未變更任何狀態。`,
        409,
      );
    }

    const transferData = {
      ragicRecordId,
      ragicPlanNo,
      ragicUrl,
      ragicResponse: record as Prisma.InputJsonValue,
    };
    if (existing) {
      await tx.productionPlanTransfer.update({
        where: { id: existing.id },
        data: transferData,
      });
    } else {
      await tx.productionPlanTransfer.create({
        data: {
          mrpRunId: input.runId,
          mrpVersionCode: input.versionCode,
          partVersion: input.partVersion,
          planSequence: input.planSequence,
          customerCode: fgSummary?.customerCode || null,
          suggestedQty: suggestion.suggestedQty,
          completionDate: suggestion.completionDate,
          ragicRecordId,
          ragicPlanNo,
          ragicUrl,
          sentData: {
            reconciliationAction: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
            verifiedAt: now.toISOString(),
          },
          ragicResponse: record as Prisma.InputJsonValue,
          transferredAt: now,
        },
      });
    }

    return {
      action: input.action,
      transferStatus: TRANSFER_STATUS.SUCCEEDED,
      ragicRecordId,
      ragicPlanNo,
      ragicUrl,
    };
  });
}
