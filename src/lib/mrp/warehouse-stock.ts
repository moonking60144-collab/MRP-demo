export const WAREHOUSE_STOCK_GROUPS = {
  INTERNAL: {
    field: 'mainStockPc',
    label: '廠內 MAIN 庫存',
    name: 'MAIN',
  },
  AUX: {
    field: 'auxStockPc',
    label: 'AUX 在庫 pc',
    name: 'AUX',
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
  if (field === WAREHOUSE_STOCK_GROUPS.AUX.field) return 'AUX';
  return null;
}

export function isAuxWarehouse(warehouseCode: string | null): boolean {
  return warehouseCode?.trim().toUpperCase() === 'AUX';
}
