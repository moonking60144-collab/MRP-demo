import type { ArchiveRunItem } from './browser-contract';

export const ARCHIVE_WEEKLY_SORTS = {
  component: { materialPartNo: 'material_part_no', goodStockPc: 'good_stock_pc', stockWeeks: 'stock_weeks', shortageStartWeek: 'shortage_start_week' },
  sales: { partVersion: 'part_version', customerCode: 'customer_code', erpPartNo: 'erp_part_no', shortageStartWeek: 'shortage_start_week', totalFgDiff: 'total_fg_diff' },
} as const;
export type ArchiveWeeklyKind = keyof typeof ARCHIVE_WEEKLY_SORTS;
export interface ArchiveWeeklyReport {
  run: ArchiveRunItem;
  kind: ArchiveWeeklyKind;
  mrpType: string;
  rows: Array<Record<string, string | null>>;
  periods: Array<Record<string, string | null>>;
  missingFields: string[];
  warehouseAvailable: boolean;
  page: number;
  pageSize: number;
  total: number;
}
