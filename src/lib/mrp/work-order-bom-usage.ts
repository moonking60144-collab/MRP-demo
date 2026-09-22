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
  unlinked_work_order: 'BOM 未關聯本 Run 的工令，已排除需求',
  missing_issue_state: '工令領料狀態空白',
  missing_issue_details: '缺少領料明細',
  missing_bom_unit: '工令用料單位空白',
  missing_issued_rows: '領料標記與明細狀態不一致',
  issue_state_mismatch: 'BOM 與領料明細狀態不一致',
  missing_issued_quantity: '已領料列缺少領用量',
  unsupported_issue_selection: '不支援此領料方式',
  unsupported_issue_unit: '領料單位不是 pc 或 kg',
  missing_unit_weight: '跨單位換算缺少單位重',
  movement_source_unavailable: '合成耗用與退料來源無法讀取',
  movement_issue_not_found: '找不到對應領料紀錄',
  movement_issue_balance_missing: '領料前缺少同單位批號餘額',
  movement_lot_handoff_incomplete: '批號前一工令尚未結清',
  movement_quantity_missing: '耗用或退料缺少同單位數量',
  movement_consumption_exceeds_issue: '耗用量大於領用量',
  movement_return_exceeds_consumption: '退料量大於耗用量',
  movement_bom_mapping_ambiguous: '同工令與料號對應多筆 BOM，無法唯一歸屬',
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function unitOf(value: unknown): 'pc' | 'kg' | null {
  const unit = String(value ?? '').trim().toLowerCase();
  return unit === 'pc' || unit === 'kg' ? unit : null;
}

function movementQuantity(
  movement: WorkOrderMaterialMovementInput,
  unit: 'pc' | 'kg',
): number | null {
  const signed = numberOrNull(unit === 'pc' ? movement.movementQtyPc : movement.movementQtyKg);
  if (signed !== null) return Math.abs(signed);
  if (unitOf(movement.inputUnit) !== unit) return null;
  const input = numberOrNull(unit === 'pc' ? movement.inputQtyPc : movement.inputQtyKg);
  return input === null ? null : Math.abs(input);
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
  const planned = Math.max(0, Number(input.plannedUsage) || 0);
  const gross = numberOrNull(input.ledgerIssuedQty) ?? input.formUsage.issuedQty;
  const fallback = (error: IssuedQtyError | null): WorkOrderBomNetUsageResult => ({
    grossIssuedQty: gross,
    consumedQty: null,
    returnedQty: gross === null ? null : 0,
    netIssuedQty: gross,
    reservedQty: null,
    remainingUsage: input.formUsage.remainingUsage,
    overIssuedQty: gross === null ? null : Math.max(gross - planned, 0),
    issuedQtyState: input.formUsage.issuedQtyState,
    movementState: 'fallback',
    movementDetailCount: 0,
    movementError: error,
  });
  if (!input.movementSourceAvailable) {
    return fallback(input.movementSourceError ?? 'movement_source_unavailable');
  }
  const unit = unitOf(input.bomUnit);
  if (!unit) return { ...fallback('missing_bom_unit'), movementState: 'unknown' };

  let consumed = 0;
  let returned = 0;
  for (const movement of input.movements) {
    const type = String(movement.movementType ?? '').trim().toUpperCase();
    const basis = String(movement.basisType ?? '').trim();
    const isConsumption = type.startsWith('OUT') && basis.includes('耗用');
    const isReturn = type.startsWith('IN') && basis.includes('退料');
    if (!isConsumption && !isReturn) continue;
    const quantity = movementQuantity(movement, unit);
    if (quantity === null) return { ...fallback('movement_quantity_missing'), movementState: 'unknown' };
    if (isConsumption) consumed += quantity;
    else returned += quantity;
  }
  if (returned > consumed + 0.000001) {
    return { ...fallback('movement_return_exceeds_consumption'), movementState: 'unknown' };
  }
  const grossIssuedQty = gross ?? Math.max(consumed, 0);
  if (consumed > grossIssuedQty + 0.000001) {
    return { ...fallback('movement_consumption_exceeds_issue'), movementState: 'unknown' };
  }
  const consumedQty = Math.max(consumed - returned, 0);
  const netIssuedQty = Math.max(grossIssuedQty - returned, 0);
  return {
    grossIssuedQty,
    consumedQty,
    returnedQty: returned,
    netIssuedQty,
    reservedQty: Math.max(netIssuedQty - consumedQty, 0),
    remainingUsage: Math.max(planned - netIssuedQty, 0),
    overIssuedQty: Math.max(netIssuedQty - planned, 0),
    issuedQtyState: 'known',
    movementState: 'known',
    movementDetailCount: input.movements.length,
    movementError: null,
  };
}

export function resolveWorkOrderBomDemand(input: {
  minUsage: unknown;
  remainingUsage: unknown;
  issuedQtyState: unknown;
}): number {
  if (String(input.issuedQtyState ?? '').trim().toLowerCase() === 'unknown') return 0;
  const remaining = numberOrNull(input.remainingUsage);
  return Math.max(0, remaining ?? numberOrNull(input.minUsage) ?? 0);
}
