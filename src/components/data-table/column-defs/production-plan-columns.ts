import type { MrpColumnDef } from '../types';

export const PRODUCTION_PLAN_COLUMNS: MrpColumnDef[] = [
  { id: 'sourcePlanNo', header: '生產計劃編號', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客戶料號版本', filterType: 'text', mono: true },
  { id: 'customerCode', header: '客戶代碼', filterType: 'enum', enumValues: [] },
  { id: 'planSequence', header: '規劃#', filterType: 'numeric', align: 'center' },
  { id: 'suggestedQty', header: '數量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'completionDate', header: '完成日', filterType: 'date' },
  { id: 'mrpVersionCode', header: 'MRP版本', filterType: 'text', mono: true },
  { id: 'transferredAt', header: '轉單時間', filterType: 'date' },
];
