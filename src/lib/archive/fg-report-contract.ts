import type { ArchiveRunItem } from './browser-contract';

export const ARCHIVE_FG_SORTS = {
  forgingParent: 'forging_parent', customerPartNo: 'customer_part_no', erpPartNo: 'erp_part_no',
  partVersion: 'part_version', customerCode: 'customer_code', forgingMachine: 'forging_machine',
  shortageStartPeriod: 'shortage_start_period', currentStockPc: 'current_stock_pc',
} as const;

export interface ArchiveFgReport {
  run: ArchiveRunItem;
  rows: Array<Record<string, string | null>>;
  periods: Array<Record<string, string | null>>;
  page: number;
  pageSize: number;
  total: number;
  aggregated: boolean;
  warehouseAvailable: boolean;
  missingFields: string[];
}

export const archiveFgCamel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
