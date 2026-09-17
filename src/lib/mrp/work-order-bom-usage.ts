export type IssuedQtyState = 'not_issued' | 'known' | 'unknown';
export type MovementSnapshotState = 'known' | 'fallback' | 'unknown';

export type IssuedQtyError =
  | 'unlinked_work_order'
  | 'missing_issue_state'
  | 'missing_issue_details'
  | 'missing_bom_unit'
  | 'missing_issued_rows'
  | 'issue_state_mismatch'
  | 'missing_issued_quantity'
  | 'unsupported_issue_selection'
  | 'unsupported_issue_unit'
  | 'missing_unit_weight'
  | 'movement_source_unavailable'
  | 'movement_issue_not_found'
  | 'movement_issue_balance_missing'
  | 'movement_lot_handoff_incomplete'
  | 'movement_quantity_missing'
  | 'movement_consumption_exceeds_issue'
  | 'movement_return_exceeds_consumption'
  | 'movement_bom_mapping_ambiguous';

export interface WorkOrderBomUsageResult {
  issuedQty: number | null;
  remainingUsage: number | null;
  issuedQtyState: IssuedQtyState;
  issuedDetailCount: number;
  issuedQtyError: IssuedQtyError | null;
}

export interface WorkOrderMaterialMovementInput {
  basisType: unknown;
  movementType: unknown;
  inputUnit: unknown;
  inputQtyPc: unknown;
  inputQtyKg: unknown;
  movementQtyPc: unknown;
  movementQtyKg: unknown;
}

export interface WorkOrderBomNetUsageResult {
  grossIssuedQty: number | null;
  consumedQty: number | null;
  returnedQty: number | null;
  netIssuedQty: number | null;
  reservedQty: number | null;
  remainingUsage: number | null;
  overIssuedQty: number | null;
  issuedQtyState: IssuedQtyState;
  movementState: MovementSnapshotState;
  movementDetailCount: number;
  movementError: IssuedQtyError | null;
}

export const ISSUED_QTY_ERROR_LABELS: Record<IssuedQtyError, string> = {
  unlinked_work_order: 'BOM 未關聯本 Run 的未結工令，已排除需求',
  missing_issue_state: '工令領料狀態空白',
  missing_issue_details: '缺少領料明細',
  missing_bom_unit: '工令用料單位空白',
  missing_issued_rows: '領過料標記與明細狀態不一致',
  issue_state_mismatch: 'BOM 主表與領料子表狀態不一致',
  missing_issued_quantity: '已領料列缺少領用量',
  unsupported_issue_selection: '領料方式不是整批或部分領料',
  unsupported_issue_unit: '領料單位不是 pc 或 kg',
  missing_unit_weight: '跨單位換算缺少本批單位重',
  movement_source_unavailable: 'Ragic 耗用與退料來源無法讀取',
  movement_issue_not_found: '找不到對應的工令領料調撥紀錄',
  movement_issue_balance_missing: '領料調撥前缺少同單位批號餘額',
  movement_lot_handoff_incomplete: '批號前一工令尚未結清，禁止跨工令交接',
  movement_quantity_missing: '耗用或退料紀錄缺少同單位數量',
  movement_consumption_exceeds_issue: '耗用出庫量大於本次工令領用量',
  movement_return_exceeds_consumption: '正式退料量大於耗用出庫量',
  movement_bom_mapping_ambiguous: '同工令與料號對應多筆 BOM，無法唯一歸屬',
};

interface WorkOrderBomUsageInput {
  plannedUsage: number;
  bomUnit: unknown;
  alreadyPicked: unknown;
  issueRows: Array<Record<string, unknown>>;
}

function normalizeUnit(value: unknown): 'pc' | 'kg' | null {
  const unit = String(value ?? '').trim().toLowerCase();
  return unit === 'pc' || unit === 'kg' ? unit : null;
}

function normalizeIssueSelection(value: unknown): 'all' | 'partial' | null {
  const selection = String(value ?? '').trim().toLowerCase();
  if (selection === '整批all') return 'all';
  if (selection === '部分partial') return 'partial';
  return null;
}

function parseRequiredNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function unknownResult(
  issuedDetailCount: number,
  issuedQtyError: IssuedQtyError,
): WorkOrderBomUsageResult {
  return {
    issuedQty: null,
    remainingUsage: null,
    issuedQtyState: 'unknown',
    issuedDetailCount,
    issuedQtyError,
  };
}

export function calculateWorkOrderBomUsage(
  input: WorkOrderBomUsageInput,
): WorkOrderBomUsageResult {
  const plannedUsage = Math.max(0, Number(input.plannedUsage) || 0);
  const pickedState = String(input.alreadyPicked ?? '').trim().toLowerCase();
  const issuedRows = input.issueRows.filter(
    (row) => String(row['1006339'] ?? '').trim().toLowerCase() === 'yes',
  );
  // 子表逐列的已執行狀態是計算依據；主表狀態只用來揭露 Yes/No 不一致。
  const issueStateMismatch = (pickedState === 'yes' && issuedRows.length === 0)
    || (pickedState === 'no' && issuedRows.length > 0);

  if (issuedRows.length === 0) {
    return {
      issuedQty: 0,
      remainingUsage: plannedUsage,
      issuedQtyState: 'not_issued',
      issuedDetailCount: 0,
      issuedQtyError: issueStateMismatch ? 'issue_state_mismatch' : null,
    };
  }

  const bomUnit = normalizeUnit(input.bomUnit);
  if (!bomUnit) {
    return unknownResult(0, 'missing_bom_unit');
  }

  let issuedQty = 0;
  for (const row of issuedRows) {
    const selection = normalizeIssueSelection(row['1006285']);
    if (!selection) {
      return unknownResult(issuedRows.length, 'unsupported_issue_selection');
    }

    if (selection === 'all') {
      const batchQty = parseRequiredNumber(
        bomUnit === 'pc' ? row['1010898'] : row['1010899'],
      );
      if (batchQty === null) {
        return unknownResult(issuedRows.length, 'missing_issued_quantity');
      }
      issuedQty += batchQty;
      continue;
    }

    const rowQty = parseRequiredNumber(row['1006286']);
    if (rowQty === null) {
      return unknownResult(issuedRows.length, 'missing_issued_quantity');
    }

    const issueUnit = normalizeUnit(row['1006288']);
    if (!issueUnit) {
      return unknownResult(issuedRows.length, 'unsupported_issue_unit');
    }

    if (issueUnit === bomUnit) {
      issuedQty += rowQty;
      continue;
    }

    const unitWeightG = parseRequiredNumber(row['1006302']);
    if (unitWeightG === null || unitWeightG <= 0) {
      return unknownResult(issuedRows.length, 'missing_unit_weight');
    }

    issuedQty += bomUnit === 'pc'
      ? (rowQty * 1000) / unitWeightG
      : (rowQty * unitWeightG) / 1000;
  }

  return {
    issuedQty,
    remainingUsage: Math.max(plannedUsage - issuedQty, 0),
    issuedQtyState: 'known',
    issuedDetailCount: issuedRows.length,
    issuedQtyError: issueStateMismatch ? 'issue_state_mismatch' : null,
  };
}

const CONSUMPTION_BASES = new Set([
  '出-自動耗用',
  '出-耗工單耗用量',
  '出-製令單',
  '出-工單耗用',
  '出-製令單耗用量',
  '出-託工單耗用量',
]);

const RETURN_BASES = new Set([
  '入-製令單退料',
  '入-託工單退料',
]);

function movementQuantity(
  movement: WorkOrderMaterialMovementInput,
  bomUnit: 'pc' | 'kg',
): number | null {
  const signed = parseRequiredNumber(
    bomUnit === 'pc' ? movement.movementQtyPc : movement.movementQtyKg,
  );
  if (signed !== null) return Math.abs(signed);

  const inputUnit = normalizeUnit(movement.inputUnit);
  if (inputUnit !== bomUnit) return null;
  const input = parseRequiredNumber(
    bomUnit === 'pc' ? movement.inputQtyPc : movement.inputQtyKg,
  );
  return input === null ? null : Math.abs(input);
}

function fallbackMovementResult(
  plannedUsage: number,
  formUsage: WorkOrderBomUsageResult,
  movementError: IssuedQtyError | null,
): WorkOrderBomNetUsageResult {
  const grossIssuedQty = formUsage.issuedQty;
  return {
    grossIssuedQty,
    consumedQty: null,
    returnedQty: grossIssuedQty === null ? null : 0,
    netIssuedQty: grossIssuedQty,
    reservedQty: null,
    remainingUsage: formUsage.remainingUsage,
    overIssuedQty: grossIssuedQty === null
      ? null
      : Math.max(grossIssuedQty - plannedUsage, 0),
    issuedQtyState: formUsage.issuedQtyState,
    movementState: 'fallback',
    movementDetailCount: 0,
    movementError,
  };
}

export function reconcileWorkOrderBomUsage(input: {
  plannedUsage: number;
  bomUnit: unknown;
  ledgerIssuedQty?: number | null;
  formUsage: WorkOrderBomUsageResult;
  movements: WorkOrderMaterialMovementInput[];
  movementSourceAvailable: boolean;
  movementSourceError?: IssuedQtyError | null;
}): WorkOrderBomNetUsageResult {
  const plannedUsage = Math.max(0, Number(input.plannedUsage) || 0);
  if (!input.movementSourceAvailable) {
    return fallbackMovementResult(
      plannedUsage,
      input.formUsage,
      input.movementSourceError ?? 'movement_source_unavailable',
    );
  }

  if (input.ledgerIssuedQty === null && input.movementSourceError) {
    return {
      grossIssuedQty: null,
      consumedQty: null,
      returnedQty: null,
      netIssuedQty: null,
      reservedQty: null,
      remainingUsage: null,
      overIssuedQty: null,
      issuedQtyState: 'unknown',
      movementState: 'unknown',
      movementDetailCount: input.movements.length,
      movementError: input.movementSourceError,
    };
  }

  const bomUnit = normalizeUnit(input.bomUnit);
  if (!bomUnit) {
    return {
      grossIssuedQty: input.formUsage.issuedQty,
      consumedQty: null,
      returnedQty: null,
      netIssuedQty: null,
      reservedQty: null,
      remainingUsage: null,
      overIssuedQty: null,
      issuedQtyState: 'unknown',
      movementState: 'unknown',
      movementDetailCount: input.movements.length,
      movementError: 'missing_bom_unit',
    };
  }

  const relevant = input.movements.filter((movement) => {
    const basis = String(movement.basisType ?? '').trim();
    const type = String(movement.movementType ?? '').trim().toUpperCase();
    return (type === 'OUT出庫'.toUpperCase() && CONSUMPTION_BASES.has(basis))
      || (type === 'IN入庫'.toUpperCase() && RETURN_BASES.has(basis));
  });
  const ledgerIssuedQty = parseRequiredNumber(input.ledgerIssuedQty);
  if (relevant.length === 0 && ledgerIssuedQty === null) {
    return fallbackMovementResult(plannedUsage, input.formUsage, null);
  }

  let consumptionOut = 0;
  let formalReturns = 0;
  for (const movement of relevant) {
    const quantity = movementQuantity(movement, bomUnit);
    if (quantity === null) {
      return {
        grossIssuedQty: ledgerIssuedQty ?? input.formUsage.issuedQty,
        consumedQty: null,
        returnedQty: null,
        netIssuedQty: null,
        reservedQty: null,
        remainingUsage: null,
        overIssuedQty: null,
        issuedQtyState: 'unknown',
        movementState: 'unknown',
        movementDetailCount: relevant.length,
        movementError: 'movement_quantity_missing',
      };
    }

    const type = String(movement.movementType ?? '').trim().toUpperCase();
    if (type === 'OUT出庫'.toUpperCase()) consumptionOut += quantity;
    else formalReturns += quantity;
  }

  if (formalReturns - consumptionOut > 0.000001) {
    return {
      grossIssuedQty: ledgerIssuedQty ?? input.formUsage.issuedQty,
      consumedQty: null,
      returnedQty: null,
      netIssuedQty: null,
      reservedQty: null,
      remainingUsage: null,
      overIssuedQty: null,
      issuedQtyState: 'unknown',
      movementState: 'unknown',
      movementDetailCount: relevant.length,
      movementError: 'movement_return_exceeds_consumption',
    };
  }

  const grossIssuedQty = ledgerIssuedQty
    ?? Math.max(input.formUsage.issuedQty ?? 0, consumptionOut);
  if (consumptionOut - grossIssuedQty > 0.000001) {
    return {
      grossIssuedQty,
      consumedQty: null,
      returnedQty: null,
      netIssuedQty: null,
      reservedQty: null,
      remainingUsage: null,
      overIssuedQty: null,
      issuedQtyState: 'unknown',
      movementState: 'unknown',
      movementDetailCount: relevant.length,
      movementError: 'movement_consumption_exceeds_issue',
    };
  }

  const consumedQty = Math.max(consumptionOut - formalReturns, 0);
  const netIssuedQty = Math.max(grossIssuedQty - formalReturns, 0);
  return {
    grossIssuedQty,
    consumedQty,
    returnedQty: formalReturns,
    netIssuedQty,
    reservedQty: Math.max(netIssuedQty - consumedQty, 0),
    remainingUsage: Math.max(plannedUsage - netIssuedQty, 0),
    overIssuedQty: Math.max(netIssuedQty - plannedUsage, 0),
    issuedQtyState: 'known',
    movementState: 'known',
    movementDetailCount: relevant.length,
    movementError: null,
  };
}

export function resolveWorkOrderBomDemand(input: {
  minUsage: unknown;
  remainingUsage: unknown;
  issuedQtyState: unknown;
}): number {
  if (String(input.issuedQtyState ?? '').trim().toLowerCase() === 'unknown') return 0;

  const remaining = parseRequiredNumber(input.remainingUsage);
  if (remaining !== null) return Math.max(0, remaining);

  return Math.max(0, parseRequiredNumber(input.minUsage) ?? 0);
}
