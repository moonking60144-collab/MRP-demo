import { isAuxWarehouse } from '@/lib/mrp/warehouse-stock';

export const MRP_AVAILABLE_INVENTORY_QUALITIES = [
  '正常',
  '待驗',
  '待驗暫先放行',
] as const;

const mrpAvailableQualitySet = new Set<string>(MRP_AVAILABLE_INVENTORY_QUALITIES);

export function hasInventoryLotSnapshot(syncCounts: unknown): boolean {
  return typeof syncCounts === 'object'
    && syncCounts !== null
    && !Array.isArray(syncCounts)
    && Object.prototype.hasOwnProperty.call(syncCounts, 'inventory_lots');
}


export function hasInventoryLotQuantityValidation(syncCounts: unknown): boolean {
  return Boolean(syncCounts)
    && typeof syncCounts === 'object'
    && !Array.isArray(syncCounts)
    && Object.prototype.hasOwnProperty.call(syncCounts, 'inventory_lot_validation_v1');
}

export function isMrpAvailableInventoryQuality(value: unknown): boolean {
  const quality = String(value ?? '').trim();
  return mrpAvailableQualitySet.has(quality);
}

export function isMrpAvailableInventoryLot(lot: {
  stockStatus: unknown;
  qualityStatus: unknown;
}): boolean {
  return String(lot.stockStatus ?? '').trim() === '在庫'
    && isMrpAvailableInventoryQuality(lot.qualityStatus);
}

export interface InventoryLotInput {
  sourceRecordId: string;
  lotNo: unknown;
  erpPartNo: unknown;
  warehouseCode: unknown;
  stockStatus: unknown;
  qualityStatus: unknown;
  stockPc: unknown;
  stockKg: unknown;
  unitWeightG: unknown;
  sourceWorkOrderNo: unknown;
  sourceWorkOrderType: unknown;
}

export interface InventoryLotSnapshot {
  sourceRecordId: string;
  lotNo: string | null;
  erpPartNo: string;
  warehouseCode: string | null;
  stockStatus: string;
  qualityStatus: string | null;
  stockPc: number;
  stockKg: number;
  unitWeightG: number | null;
  expectedStockPc: number | null;
  stockPcDiff: number | null;
  stockPcDiffPct: number | null;
  quantityAnomaly: boolean;
  sourceWorkOrderNo: string | null;
  sourceWorkOrderType: string | null;
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function quantity(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}


export interface InventoryLotQuantityValidation {
  unitWeightG: number | null;
  expectedStockPc: number | null;
  stockPcDiff: number | null;
  stockPcDiffPct: number | null;
  quantityAnomaly: boolean;
}

export function evaluateInventoryLotQuantity(input: {
  stockPc: unknown;
  stockKg: unknown;
  unitWeightG: unknown;
}): InventoryLotQuantityValidation {
  const stockPc = quantity(input.stockPc);
  const stockKg = quantity(input.stockKg);
  const parsedUnitWeight = quantity(input.unitWeightG);
  if (parsedUnitWeight <= 0) {
    return {
      unitWeightG: null,
      expectedStockPc: null,
      stockPcDiff: null,
      stockPcDiffPct: null,
      quantityAnomaly: false,
    };
  }

  const expectedStockPc = Math.round((stockKg * 1000) / parsedUnitWeight);
  const stockPcDiff = stockPc - expectedStockPc;
  const stockPcDiffPct = Math.abs(stockPcDiff) / Math.max(Math.abs(stockPc), 1);
  const tolerancePc = Math.max(2, Math.abs(stockPc) * 0.01);

  return {
    unitWeightG: parsedUnitWeight,
    expectedStockPc,
    stockPcDiff,
    stockPcDiffPct,
    quantityAnomaly: Math.abs(stockPcDiff) > tolerancePc,
  };
}

export function normalizeInventoryLot(input: InventoryLotInput): InventoryLotSnapshot | null {
  const erpPartNo = textOrNull(input.erpPartNo);
  const stockStatus = textOrNull(input.stockStatus);
  const qualityStatus = textOrNull(input.qualityStatus);
  if (!erpPartNo || stockStatus !== '在庫') {
    return null;
  }

  const quantityValidation = evaluateInventoryLotQuantity(input);
  return {
    sourceRecordId: input.sourceRecordId,
    lotNo: textOrNull(input.lotNo),
    erpPartNo,
    warehouseCode: textOrNull(input.warehouseCode)?.toUpperCase() ?? null,
    stockStatus,
    qualityStatus,
    stockPc: quantity(input.stockPc),
    stockKg: quantity(input.stockKg),
    ...quantityValidation,
    sourceWorkOrderNo: textOrNull(input.sourceWorkOrderNo),
    sourceWorkOrderType: textOrNull(input.sourceWorkOrderType),
  };
}

export interface InventoryStockSummary {
  inStockPc: number;
  inStockKg: number;
  mainStockPc: number;
  mainStockKg: number;
  auxStockPc: number;
  auxStockKg: number;
}

export function resolveInventoryAvailability(input: {
  goodStockPc: unknown;
  goodStockKg: unknown;
  inStockPc?: unknown;
  inStockKg?: unknown;
  mainStockPc?: unknown;
  mainStockKg?: unknown;
  auxStockPc?: unknown;
  auxStockKg?: unknown;
}): InventoryStockSummary {
  return {
    inStockPc: input.inStockPc == null ? quantity(input.goodStockPc) : quantity(input.inStockPc),
    inStockKg: input.inStockKg == null ? quantity(input.goodStockKg) : quantity(input.inStockKg),
    mainStockPc: quantity(input.mainStockPc),
    mainStockKg: quantity(input.mainStockKg),
    auxStockPc: quantity(input.auxStockPc),
    auxStockKg: quantity(input.auxStockKg),
  };
}

export function summarizeInventoryLots(
  lots: readonly Pick<
    InventoryLotSnapshot,
    'erpPartNo' | 'warehouseCode' | 'stockStatus' | 'qualityStatus' | 'stockPc' | 'stockKg'
  >[],
): Map<string, InventoryStockSummary> {
  const summaries = new Map<string, InventoryStockSummary>();
  for (const lot of lots) {
    if (!isMrpAvailableInventoryLot(lot)) continue;
    const summary = summaries.get(lot.erpPartNo) ?? {
      inStockPc: 0,
      inStockKg: 0,
      mainStockPc: 0,
      mainStockKg: 0,
      auxStockPc: 0,
      auxStockKg: 0,
    };
    summary.inStockPc += lot.stockPc;
    summary.inStockKg += lot.stockKg;
    if (isAuxWarehouse(lot.warehouseCode)) {
      summary.auxStockPc += lot.stockPc;
      summary.auxStockKg += lot.stockKg;
    } else {
      summary.mainStockPc += lot.stockPc;
      summary.mainStockKg += lot.stockKg;
    }
    summaries.set(lot.erpPartNo, summary);
  }
  return summaries;
}


export interface InventoryAnomalySummary {
  count: number;
  absoluteDiffPc: number;
  erpPartNos: string[];
}

export function summarizeInventoryAnomalies(
  lots: readonly Pick<
    InventoryLotSnapshot,
    'erpPartNo' | 'stockStatus' | 'qualityStatus' | 'quantityAnomaly' | 'stockPcDiff'
  >[],
): Map<string, InventoryAnomalySummary> {
  const summaries = new Map<string, InventoryAnomalySummary>();
  for (const lot of lots) {
    if (!lot.quantityAnomaly || !isMrpAvailableInventoryLot(lot)) continue;
    const summary = summaries.get(lot.erpPartNo) ?? {
      count: 0,
      absoluteDiffPc: 0,
      erpPartNos: [lot.erpPartNo],
    };
    summary.count += 1;
    summary.absoluteDiffPc += Math.abs(Number(lot.stockPcDiff) || 0);
    summaries.set(lot.erpPartNo, summary);
  }
  return summaries;
}

export function combineInventoryAnomalySummaries(
  erpPartNos: readonly string[],
  summariesByErp: ReadonlyMap<string, InventoryAnomalySummary>,
): InventoryAnomalySummary {
  const uniqueErps = [...new Set(erpPartNos.map((erp) => erp.trim()).filter(Boolean))];
  return uniqueErps.reduce<InventoryAnomalySummary>((total, erpPartNo) => {
    const summary = summariesByErp.get(erpPartNo);
    if (!summary) return total;
    total.count += summary.count;
    total.absoluteDiffPc += summary.absoluteDiffPc;
    total.erpPartNos.push(erpPartNo);
    return total;
  }, { count: 0, absoluteDiffPc: 0, erpPartNos: [] });
}
