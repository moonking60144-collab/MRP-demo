export interface SalesMeetingItem {
  id: number;
  mrpRunId: number;
  customerCode: string | null;
  customerPartNo: string | null;
  partVersion: string;
  memberPartVersions: string[];
  erpPartNo: string | null;
  unit: string | null;
  goodStockPc: number;
  goodStockKg: number;
  wfgStockPc: number | null;
  ye1StockPc: number | null;
  badStockPc: number;
  badStockKg: number;
  avgDemandPerWeek: number;
  stockWeeks: number;
  shortageStartWeek: number | null;
  purchaseLeadWeeks: number;
  outstanding04: number;
  fgDiff04: number;
  fgStatus04: string | null;
  totalOrderDemand: number;
  totalFgDiff: number;
  sharedErpCount: number;
  inventoryValidationAvailable: boolean;
  inventoryAnomalyCount: number;
  wfgInventoryAnomalyCount: number;
  ye1InventoryAnomalyCount: number;
  inventoryAnomalyDiffPc: number;
  inventoryAnomalyErpPartNos: string[];
  dbSource?: 'local' | 'docker' | 'remote';
}

export interface SalesMeetingPeriodDetail {
  weekIndex: number;
  weekLabel: string | null;
  weekStart: string | null;
  remainingStock: number | null;
  demand: number;
  supply: number;
}

export type SalesMeetingSourceType = 'orders' | 'production_plans' | 'balance';
export type SalesMeetingSourceScope = 'week' | 'recent' | 'all';
export type SalesMeetingSummaryKey = 'outstanding04' | 'fgDiff04' | 'totalOrderDemand' | 'totalFgDiff';

export interface SalesMeetingSourceTarget {
  item: SalesMeetingItem;
  type: SalesMeetingSourceType;
  weekIndex: number;
  weekLabel: string;
  scope?: SalesMeetingSourceScope;
}
