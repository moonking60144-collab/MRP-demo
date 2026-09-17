import {
  ISSUED_QTY_ERROR_LABELS,
  type IssuedQtyError,
} from './work-order-bom-usage';
import type { Prisma } from '@prisma/client';

export type WorkOrderMaterialAnomalyLevel = 'blocking' | 'review' | 'source' | 'none';

export interface WorkOrderMaterialAnomalyInput {
  issuedQtyState: string | null;
  issuedQtyError: string | null;
  movementState: string | null;
  movementError: string | null;
  overIssuedQty: number | string | { toString(): string } | null;
}

export interface WorkOrderMaterialAnomaly {
  level: WorkOrderMaterialAnomalyLevel;
  reason: string;
}

export type WorkOrderMaterialUsageWarningLevel = 'blocking' | 'review';

interface WorkOrderMaterialUsageWarningInput {
  issuedQtyState: string | null;
  issuedQtyError: string | null;
  movementState: string | null;
  movementError: string | null;
}

export function workOrderMaterialUsageWarningWhere(
  mrpRunId: number,
): Prisma.StagingWorkOrderBomWhereInput {
  return {
    mrpRunId,
    OR: [
      { issuedQtyState: 'unknown' },
      { movementState: 'unknown' },
      { issuedQtyError: 'issue_state_mismatch' },
    ],
  };
}

export function classifyWorkOrderMaterialUsageWarning(
  row: WorkOrderMaterialUsageWarningInput,
): { level: WorkOrderMaterialUsageWarningLevel; reason: string | null } | null {
  if (row.issuedQtyState === 'unknown' || row.movementState === 'unknown') {
    return {
      level: 'blocking',
      reason: row.issuedQtyError === 'unlinked_work_order'
        ? row.issuedQtyError
        : row.movementError ?? row.issuedQtyError,
    };
  }
  if (row.issuedQtyError === 'issue_state_mismatch') {
    return {
      level: 'review',
      reason: row.issuedQtyError,
    };
  }
  return null;
}

function errorLabel(error: string | null): string | null {
  return error && error in ISSUED_QTY_ERROR_LABELS
    ? ISSUED_QTY_ERROR_LABELS[error as IssuedQtyError]
    : error;
}

export function classifyWorkOrderMaterialAnomaly(
  row: WorkOrderMaterialAnomalyInput,
): WorkOrderMaterialAnomaly {
  const issuedError = errorLabel(row.issuedQtyError);
  const movementError = errorLabel(row.movementError);

  if (row.issuedQtyState === 'unknown' || row.movementState === 'unknown') {
    return {
      level: 'blocking',
      reason: issuedError || movementError || '領用或耗退資料無法確認',
    };
  }

  const overIssuedQty = Number(row.overIssuedQty) || 0;
  if (overIssuedQty > 0) {
    return {
      level: 'review',
      reason: `淨領用超過 BOM ${overIssuedQty.toLocaleString(undefined, { maximumFractionDigits: 3 })}`,
    };
  }

  if (row.issuedQtyError === 'issue_state_mismatch') {
    return {
      level: 'review',
      reason: issuedError || 'BOM 主表與領料子表狀態不一致',
    };
  }

  if (row.issuedQtyState !== 'not_issued' && row.movementState === 'fallback') {
    return {
      level: 'source',
      reason: movementError
        ? `${movementError}；此 Run 沿用 Form 28 領料結果`
        : '此 Run 沿用 Form 28 領料結果，沒有 Form 20 耗退帳本',
    };
  }

  if (issuedError || (movementError && row.issuedQtyState !== 'not_issued')) {
    return {
      level: 'blocking',
      reason: issuedError || movementError || '領用或耗退資料無法確認',
    };
  }

  return { level: 'none', reason: '正常' };
}
