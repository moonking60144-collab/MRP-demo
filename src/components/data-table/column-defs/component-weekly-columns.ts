import type { MrpColumnDef } from '../types';

export const DB_SOURCE_COLUMN: MrpColumnDef = {
  id: 'dbSource', header: '來源', filterType: 'text', width: 55, align: 'center', defaultVisible: false,
};

export const COMPONENT_WEEKLY_COLUMNS: MrpColumnDef[] = [
  { id: 'materialPartNo', header: '料號', filterType: 'text', mono: true },
  { id: 'unit', header: '單位', filterType: 'text', width: 50, align: 'center' },
  { id: 'goodStockPc', header: '良品庫存pc', filterType: 'numeric', align: 'right', mono: true },
  { id: 'goodStockKg', header: '良品庫存kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockPc', header: '不良品pc', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockKg', header: '不良品kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'avgWeeklyUsage', header: '平均用量/週', filterType: 'numeric', align: 'right', mono: true },
  { id: 'stockWeeks', header: '庫存週數', filterType: 'numeric', align: 'right', mono: true },
  { id: 'purchaseLeadWeeks', header: '採購前置期', filterType: 'numeric', width: 96, align: 'center', mono: true },
  { id: 'shortageStartWeek', header: '開始缺貨', filterType: 'numeric', width: 120, align: 'center' },
  { id: 'weeksUntilOrder', header: '最晚下單／處置', filterType: 'numeric', width: 128, align: 'center' },
];
