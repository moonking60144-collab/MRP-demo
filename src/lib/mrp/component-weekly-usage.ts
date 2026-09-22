import type { Prisma } from '@prisma/client';
import { dateToWeekIndex, type MrpWeek } from './period-utils';
import { resolveWorkOrderBomDemand } from './work-order-bom-usage';

export type ComponentWeeklyMrpType = 'W' | 'B' | 'D';
export type ComponentWeeklyMovementSummaryState = 'known' | 'fallback' | 'mixed' | 'unknown';
export type ComponentWeeklyDemandDateSource = 'work_order' | 'bom' | 'missing';
export type ComponentWeeklyUsageRowStatus =
  | 'not_issued'
  | 'partial'
  | 'fully_issued'
  | 'over_issued'
  | 'unknown';
export type ComponentWeeklySettlementState =
  | 'not_issued'
  | 'reserved'
  | 'pending'
  | 'settled'
  | 'returned'
  | 'unknown';

export function isComponentWeeklyMrpType(value: unknown): value is ComponentWeeklyMrpType {
  return value === 'W' || value === 'B' || value === 'D';
}

export function normalizeComponentWeeklyMaterialPartNo(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized && normalized !== '*' && normalized !== '.' ? normalized : null;
}

export function normalizeComponentWeeklyUnit(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || null;
}

export function componentWeeklyUnitsMatch(expected: unknown, actual: unknown): boolean {
  const expectedUnit = normalizeComponentWeeklyUnit(expected);
  const actualUnit = normalizeComponentWeeklyUnit(actual);
  return expectedUnit !== null && expectedUnit === actualUnit;
}

export function parseComponentWeeklyUsageWeekIndex(
  value: string | null,
): number | null | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized === 'all') return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveComponentWeeklyMovementSummaryState(
  states: Iterable<unknown>,
): ComponentWeeklyMovementSummaryState {
  let hasKnown = false;
  let hasFallback = false;
  for (const state of states) {
    const normalized = String(state ?? '').trim().toLowerCase();
    if (normalized === 'unknown') return 'unknown';
    if (normalized === 'known') hasKnown = true;
    else hasFallback = true;
  }
  if (hasKnown && hasFallback) return 'mixed';
  return hasKnown ? 'known' : 'fallback';
}

export function isComponentWeeklyDateInScope(
  date: Date | null | undefined,
  weeks: MrpWeek[],
  weekIndex: number | null,
): boolean {
  const rowWeekIndex = dateToWeekIndex(date, weeks);
  return rowWeekIndex !== null && (weekIndex === null || rowWeekIndex === weekIndex);
}

export function resolveComponentWeeklyDemandDate(
  bomStartDate: Date | null | undefined,
  workOrderStartDate: Date | null | undefined,
): {
  date: Date | null;
  source: ComponentWeeklyDemandDateSource;
  mismatch: boolean;
} {
  const bomDate = bomStartDate ?? null;
  const scheduleDate = workOrderStartDate ?? null;
  // 排程日期是使用者指定的需求日期；BOM 日期只保留供差異追溯。
  if (scheduleDate) {
    return {
      date: scheduleDate,
      source: 'work_order',
      mismatch: bomDate !== null && bomDate.getTime() !== scheduleDate.getTime(),
    };
  }
  if (bomDate) return { date: bomDate, source: 'bom', mismatch: false };
  return { date: null, source: 'missing', mismatch: false };
}

export function componentWeeklyUsageWhere(
  mrpType: ComponentWeeklyMrpType,
): Prisma.StagingWorkOrderBomWhereInput {
  if (mrpType === 'B') return { sourceType: { in: ['採購', '外購'] } };
  if (mrpType === 'D') return { sourceType: '內製', processCode: '組合' };
  return {};
}

export function matchesComponentWeeklyUsageType(
  row: Pick<ComponentWeeklyUsageBomRow, 'sourceType' | 'processCode'>,
  mrpType: ComponentWeeklyMrpType,
): boolean {
  if (mrpType === 'B') return row.sourceType === '採購' || row.sourceType === '外購';
  if (mrpType === 'D') return row.sourceType === '內製' && row.processCode === '組合';
  return true;
}

export interface ComponentWeeklyUsageBomRow {
  sourceRecordId: string | null;
  componentNo: string | null;
  woNumber: string | null;
  sourceType: string | null;
  processCode: string | null;
  unit: string | null;
  minUsage: unknown;
  alreadyPicked: string | null;
  issuedQty: unknown;
  grossIssuedQty?: unknown;
  consumedQty?: unknown;
  returnedQty?: unknown;
  netIssuedQty?: unknown;
  reservedQty?: unknown;
  remainingUsage: unknown;
  overIssuedQty?: unknown;
  issuedQtyState: string;
  issuedDetailCount: number;
  issuedQtyError: string | null;
  movementState?: string;
  movementDetailCount?: number;
  movementError?: string | null;
  startDate: Date | null;
}

export interface ComponentWeeklyUsageWorkOrder {
  sourceRecordId: string | null;
  woNumber: string | null;
  erpPartNo: string | null;
  status: string | null;
  startDate?: Date | null;
}

export interface ComponentWeeklyUsageDetailRow {
  sourceRecordId: string | null;
  workOrderSourceRecordId: string | null;
  woNumber: string | null;
  finishedErpPartNo: string | null;
  workOrderStatus: string | null;
  startDate: string | null;
  scheduleStartDate: string | null;
  bomStartDate: string | null;
  dateSource: ComponentWeeklyDemandDateSource;
  dateMismatch: boolean;
  plannedUsage: number;
  grossIssuedQty: number | null;
  consumedQty: number | null;
  returnedQty: number | null;
  netIssuedQty: number | null;
  reservedQty: number | null;
  remainingUsage: number | null;
  overIssuedQty: number;
  unit: string | null;
  alreadyPicked: string | null;
  issuedQtyState: string;
  issuedDetailCount: number;
  movementState: string;
  movementDetailCount: number;
  settlementState: ComponentWeeklySettlementState;
  sourceAnomaly: string | null;
  reason: string | null;
  status: ComponentWeeklyUsageRowStatus;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function resolveComponentWeeklySettlementState(input: {
  status: ComponentWeeklyUsageRowStatus;
  movementState: string;
  workOrderStatus?: string | null;
  consumedQty: number | null;
  returnedQty: number | null;
  netIssuedQty: number | null;
  reservedQty: number | null;
}): ComponentWeeklySettlementState {
  if (input.status === 'unknown' || input.movementState === 'unknown') return 'unknown';
  const consumedQty = input.consumedQty ?? 0;
  const returnedQty = input.returnedQty ?? 0;
  const netIssuedQty = input.netIssuedQty ?? 0;
  const reservedQty = input.reservedQty ?? 0;
  if (input.movementState === 'known' && returnedQty > 0 && netIssuedQty === 0) return 'returned';
  if (input.status === 'not_issued') return 'not_issued';
  if (input.movementState !== 'known') return 'pending';
  if (input.workOrderStatus?.trim() === '已結案') return 'settled';
  if (consumedQty > 0) return 'pending';
  if (reservedQty > 0 || netIssuedQty > 0) return 'reserved';
  return 'pending';
}

export function summarizeComponentWeeklyUsage(input: {
  materialPartNo: string;
  weekIndex: number | null;
  weeks: MrpWeek[];
  expectedUsage: number;
  expectedUnit?: string | null;
  enforceUnitConsistency?: boolean;
  bomRows: ComponentWeeklyUsageBomRow[];
  workOrders: ComponentWeeklyUsageWorkOrder[];
}) {
  const materialPartNo = input.materialPartNo.trim();
  const workOrderMap = new Map<string, ComponentWeeklyUsageWorkOrder>();
  for (const workOrder of input.workOrders) {
    const woNumber = workOrder.woNumber?.trim();
    if (woNumber && !workOrderMap.has(woNumber)) workOrderMap.set(woNumber, workOrder);
  }

  const rows: ComponentWeeklyUsageDetailRow[] = [];
  for (const row of input.bomRows) {
    if (row.componentNo?.trim() !== materialPartNo) continue;
    const woNumber = row.woNumber?.trim() || null;
    const workOrder = woNumber ? workOrderMap.get(woNumber) : undefined;
    const demandDate = resolveComponentWeeklyDemandDate(row.startDate, workOrder?.startDate);
    const rowWeekIndex = dateToWeekIndex(demandDate.date, input.weeks);
    if (rowWeekIndex === null) continue;
    if (input.weekIndex !== null && rowWeekIndex !== input.weekIndex) continue;

    const issuedQtyState = String(row.issuedQtyState || '').trim().toLowerCase();
    const movementState = row.movementState || 'fallback';
    const movementUnknown = issuedQtyState === 'unknown' || movementState === 'unknown';
    const plannedUsage = Math.max(0, numeric(row.minUsage) ?? 0);
    const legacyIssuedQty = numeric(row.issuedQty);
    const grossIssuedQty = numeric(row.grossIssuedQty)
      ?? (movementUnknown ? null : legacyIssuedQty);
    const consumedQty = numeric(row.consumedQty);
    const returnedQty = numeric(row.returnedQty)
      ?? (movementUnknown || grossIssuedQty === null ? null : 0);
    const netIssuedQty = numeric(row.netIssuedQty)
      ?? (movementUnknown ? null : legacyIssuedQty);
    const reservedQty = numeric(row.reservedQty);
    const remainingUsage = resolveWorkOrderBomDemand({
      minUsage: row.minUsage,
      remainingUsage: row.remainingUsage,
      issuedQtyState,
    });
    const unitMismatch = input.enforceUnitConsistency === true
      && !componentWeeklyUnitsMatch(input.expectedUnit, row.unit);
    const status: ComponentWeeklyUsageRowStatus = unitMismatch || issuedQtyState === 'unknown'
      ? 'unknown'
      : remainingUsage > 0
        ? (netIssuedQty ?? 0) > 0 ? 'partial' : 'not_issued'
        : netIssuedQty !== null && netIssuedQty > plannedUsage
          ? 'over_issued'
          : 'fully_issued';
    const overIssuedQty = status === 'over_issued'
      ? numeric(row.overIssuedQty)
        ?? Number(((netIssuedQty ?? 0) - plannedUsage).toFixed(6))
      : 0;

    const workOrderStatus = workOrder?.status ?? null;
    rows.push({
      sourceRecordId: row.sourceRecordId,
      workOrderSourceRecordId: workOrder?.sourceRecordId ?? null,
      woNumber,
      finishedErpPartNo: workOrder?.erpPartNo ?? null,
      workOrderStatus,
      startDate: isoDate(demandDate.date),
      scheduleStartDate: isoDate(workOrder?.startDate ?? null),
      bomStartDate: isoDate(row.startDate),
      dateSource: demandDate.source,
      dateMismatch: demandDate.mismatch,
      plannedUsage,
      grossIssuedQty,
      consumedQty,
      returnedQty,
      netIssuedQty,
      reservedQty,
      remainingUsage: status === 'unknown' ? null : remainingUsage,
      overIssuedQty,
      unit: row.unit,
      alreadyPicked: row.alreadyPicked,
      issuedQtyState,
      issuedDetailCount: row.issuedDetailCount,
      movementState,
      movementDetailCount: row.movementDetailCount ?? 0,
      settlementState: resolveComponentWeeklySettlementState({
        status,
        movementState,
        workOrderStatus,
        consumedQty,
        returnedQty,
        netIssuedQty,
        reservedQty,
      }),
      sourceAnomaly: row.issuedQtyError === 'issue_state_mismatch'
        ? row.issuedQtyError
        : null,
      reason: status === 'unknown'
        ? row.issuedQtyError === 'unlinked_work_order'
          ? row.issuedQtyError
          : unitMismatch
          ? 'unit_mismatch'
          : row.movementError || row.issuedQtyError
        : status === 'fully_issued' || status === 'over_issued'
          ? status
          : null,
      status,
    });
  }

  rows.sort((left, right) => (left.woNumber || '').localeCompare(right.woNumber || ''));
  const included = rows.filter((row) => row.status === 'not_issued' || row.status === 'partial');
  const excluded = rows.filter((row) => row.status !== 'not_issued' && row.status !== 'partial');
  const includedTotal = included.reduce((sum, row) => sum + (row.remainingUsage ?? 0), 0);
  const difference = Number((includedTotal - input.expectedUsage).toFixed(6));
  const unitMismatchCount = rows.filter((row) => row.reason === 'unit_mismatch').length;

  return {
    included,
    excluded,
    includedTotal,
    expectedUsage: input.expectedUsage,
    difference,
    reconciled: Math.abs(difference) < 0.0001,
    unitMismatchCount,
  };
}
