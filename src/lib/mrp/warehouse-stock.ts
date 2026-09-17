export const WAREHOUSE_STOCK_GROUPS = {
  INTERNAL: {
    // 保留既有 DB/API key，避免這次業務規則調整變成破壞性 schema rename。
    field: 'wfgStockPc',
    label: '廠內HD庫存',
    name: '公司內部（非 YE1）',
  },
  YE1: {
    field: 'ye1StockPc',
    label: 'YE1在庫pc',
    name: 'YE1：SY交貨倉',
  },
} as const;

export type WarehouseStockGroup = keyof typeof WAREHOUSE_STOCK_GROUPS;
export type WarehouseStockField = (typeof WAREHOUSE_STOCK_GROUPS)[WarehouseStockGroup]['field'];
export type WarehouseStockFilter = 'ANOMALY' | 'MRP' | 'ALL' | 'EXCLUDED' | `QUALITY:${string}`;

export interface WarehouseStockFilterableLot {
  includedInMrp: boolean;
  quantityAnomaly: boolean;
  qualityStatus: string | null;
}

export function matchesWarehouseStockFilter(
  lot: WarehouseStockFilterableLot,
  filter: WarehouseStockFilter,
): boolean {
  if (filter === 'ANOMALY') return lot.quantityAnomaly;
  if (filter === 'ALL') return true;
  if (filter === 'MRP') return lot.includedInMrp;
  if (filter === 'EXCLUDED') return !lot.includedInMrp;
  return (lot.qualityStatus?.trim() || '未設定') === filter.slice('QUALITY:'.length);
}

export function warehouseStockGroupForField(field: string): WarehouseStockGroup | null {
  if (field === WAREHOUSE_STOCK_GROUPS.INTERNAL.field) return 'INTERNAL';
  if (field === WAREHOUSE_STOCK_GROUPS.YE1.field) return 'YE1';
  return null;
}

export function isYe1Warehouse(warehouseCode: string | null): boolean {
  return warehouseCode?.trim().toUpperCase() === 'YE1';
}

export function buildSourceWorkOrderRagicUrl(
  baseUrl: string,
  workOrderNo: string,
  recordId?: string | null,
): string {
  if (recordId) return `${baseUrl}/default/forms8/92/${recordId}`;
  const url = new URL(`${baseUrl}/default/forms8/92`);
  url.searchParams.set('status', JSON.stringify({
    filter: [`1005984|1|${workOrderNo}`],
  }));
  return url.toString();
}
