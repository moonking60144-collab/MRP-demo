import type { ArchiveView } from './browser-contract';

export type ArchiveSourceTarget = { query: string; partVersion?: string; erpPartNo?: string | null; materialPartNo?: string; aggregated?: boolean; openMaterialReminder?: boolean };

export function archiveSourceQueries(target: ArchiveSourceTarget): Partial<Record<ArchiveView, string>> | undefined {
  if (!target.partVersion && !target.materialPartNo) return undefined;
  const erp = target.materialPartNo ?? target.erpPartNo ?? '';
  return {
    orders: target.partVersion ?? '', forecasts: target.partVersion ?? '',
    'production-plans': target.partVersion ?? erp, 'work-orders': target.partVersion ?? erp,
    inventory: erp, purchases: erp,
    bom: target.materialPartNo ?? '', movements: target.materialPartNo ?? '',
  };
}
