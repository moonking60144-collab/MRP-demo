import type { MrpColumnDef } from '../types';

export const PLAN_MANAGEMENT_COLUMNS: MrpColumnDef[] = [
  // Reference columns (from fg_monthly)
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'customerPartNo', header: '客戶料號', filterType: 'text' },
  { id: 'customerCode', header: '客戶', filterType: 'enum', enumValues: [] },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'forgingMachine', header: '機台', filterType: 'text', width: 60 },
  { id: 'forgingParent', header: '鍛造母件', filterType: 'text' },

  // Plan columns (from fg_plan_suggestions)
  { id: 'planSequence', header: '規劃#', filterType: 'numeric', align: 'center', width: 55 },
  { id: 'targetStartPeriod', header: '目標開始期', filterType: 'numeric', align: 'center', width: 80 },
  { id: 'fulfillToPeriod', header: '滿足至?期數', filterType: 'numeric', align: 'center', width: 85 },
  { id: 'suggestedQty', header: '生產計畫量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'completionDate', header: '完成日期', filterType: 'date' },
  { id: 'materialWeightKg', header: '預計用料重kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'bufferPct', header: '加量%', filterType: 'numeric', align: 'right', width: 65 },

  // Status
  { id: 'status', header: '狀態', filterType: 'enum', enumValues: ['未儲存', '已儲存', '已轉單'], align: 'center', width: 75 },

  // Transfer info
  { id: 'sourcePlanNo', header: '生產計劃編號', filterType: 'text', mono: true, defaultVisible: false },
];
