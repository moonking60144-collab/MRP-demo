export type MaterialReminderState = 'risk' | 'clear' | 'unknown' | 'none';
export interface MaterialReminderRow {
  partVersion: string;
  woNumber: string | null;
  materialPartNo: string | null;
  mrpType: string | null;
  unit: string | null;
  reportUnit?: string | null;
  demandDate: string | null;
  remainingUsage: string | null;
  issuedQtyState: string | null;
  movementState: string | null;
  shortageStartWeek: number | null;
  shortageStartDate: string | null;
}
export interface MaterialReminder {
  state: MaterialReminderState;
  riskCount: number;
  incomplete: boolean;
  rows: MaterialReminderRow[];
}
export const MATERIAL_REMINDER_LABELS: Record<MaterialReminderState, string> = {
  risk: '關聯材料缺料', clear: '未見關聯缺料', unknown: '關聯資料不足', none: '無待供料需求',
};

export function summarizeMaterialReminder(rows: MaterialReminderRow[], complete = true): MaterialReminder {
  let incomplete = !complete || rows.length === 0;
  const active = rows.filter(row => {
    const quantity = row.remainingUsage === null ? null : Number(row.remainingUsage);
    const quantityUnknown = !row.issuedQtyState || row.issuedQtyState === 'unknown' || row.movementState === 'unknown'
      || quantity === null || !Number.isFinite(quantity);
    const unknown = quantityUnknown || !row.woNumber || !row.materialPartNo || !row.mrpType || !row.demandDate
      || (row.mrpType === 'W' && (!row.unit || !row.reportUnit || row.unit.trim().toLowerCase() !== row.reportUnit.trim().toLowerCase()));
    if (unknown) incomplete = true;
    return quantityUnknown || quantity! > 0;
  });
  const risks = new Set(active.filter(row => row.mrpType && row.shortageStartWeek !== null)
    .map(row => `${row.mrpType}:${row.materialPartNo}`));
  return { state: risks.size ? 'risk' : incomplete ? 'unknown' : active.length ? 'clear' : 'none',
    riskCount: risks.size, incomplete, rows: active };
}

export interface MaterialReminderScope { runId: number; archiveId?: string; dbSource?: string }
export function materialWeeklyHref(scope: MaterialReminderScope, material: string, mrpType: string) {
  const params = new URLSearchParams({ runId: String(scope.runId), material, mrpType });
  if (scope.archiveId) params.set('archiveId', scope.archiveId);
  if (scope.dbSource) params.set('dbSource', scope.dbSource);
  return `/components/linked?${params}`;
}
