import prisma from '../db';
import {
  MRP_AVAILABLE_INVENTORY_QUALITIES,
  type InventoryAnomalySummary,
  summarizeInventoryAnomalies,
} from '../sync/inventory-snapshot';
import { isYe1Warehouse } from './warehouse-stock';

export interface InventoryAnomalyLot {
  ragicRecordId: string;
  lotNo: string | null;
  erpPartNo: string;
  warehouseCode: string | null;
  qualityStatus: string | null;
  stockStatus: string | null;
  stockPc: number;
  stockKg: number;
  unitWeightG: number | null;
  expectedStockPc: number | null;
  stockPcDiff: number | null;
  stockPcDiffPct: number | null;
  sourceWorkOrderNo: string | null;
}

export async function loadInventoryAnomalyLots(
  client: typeof prisma,
  mrpRunId: number,
  erpPartNos: readonly string[],
): Promise<InventoryAnomalyLot[]> {
  const normalizedErps = [...new Set(erpPartNos.map((erp) => erp.trim()).filter(Boolean))];
  if (normalizedErps.length === 0) return [];

  const rows = await client.stagingInventoryLot.findMany({
    where: {
      mrpRunId,
      erpPartNo: { in: normalizedErps },
      quantityAnomaly: true,
      qualityStatus: { in: [...MRP_AVAILABLE_INVENTORY_QUALITIES] },
    },
    orderBy: [{ erpPartNo: 'asc' }, { lotNo: 'asc' }],
  });

  return rows.map((row) => ({
    ragicRecordId: row.ragicRecordId,
    lotNo: row.lotNo,
    erpPartNo: row.erpPartNo,
    warehouseCode: row.warehouseCode,
    qualityStatus: row.qualityStatus,
    stockStatus: row.stockStatus,
    stockPc: Number(row.stockPc) || 0,
    stockKg: Number(row.stockKg) || 0,
    unitWeightG: row.unitWeightG == null ? null : Number(row.unitWeightG),
    expectedStockPc: row.expectedStockPc == null ? null : Number(row.expectedStockPc),
    stockPcDiff: row.stockPcDiff == null ? null : Number(row.stockPcDiff),
    stockPcDiffPct: row.stockPcDiffPct == null ? null : Number(row.stockPcDiffPct),
    sourceWorkOrderNo: row.sourceWorkOrderNo,
  }));
}

export function summarizeLoadedInventoryAnomalies(
  lots: readonly InventoryAnomalyLot[],
): Map<string, InventoryAnomalySummary> {
  return summarizeInventoryAnomalies(
    lots.map((lot) => ({
      erpPartNo: lot.erpPartNo,
      stockStatus: lot.stockStatus ?? '',
      qualityStatus: lot.qualityStatus,
      quantityAnomaly: true,
      stockPcDiff: lot.stockPcDiff,
    })),
  );
}

export function countInventoryAnomaliesByWarehouse(
  lots: readonly InventoryAnomalyLot[],
  erpPartNos: readonly string[],
): { internal: number; ye1: number } {
  const erps = new Set(erpPartNos.filter(Boolean));
  let internal = 0;
  let ye1 = 0;
  for (const lot of lots) {
    if (!erps.has(lot.erpPartNo)) continue;
    if (isYe1Warehouse(lot.warehouseCode)) ye1 += 1;
    else internal += 1;
  }
  return { internal, ye1 };
}
