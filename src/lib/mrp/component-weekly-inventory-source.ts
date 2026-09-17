import {
  normalizeComponentWeeklyMaterialPartNo,
  type ComponentWeeklyMrpType,
} from './component-weekly-usage';

interface ComponentWeeklyInventorySourceIdentity {
  id: number;
  erpPartNo: string;
  subtypeCode: string | null;
}

export function resolveComponentWeeklyInventorySources<
  T extends ComponentWeeklyInventorySourceIdentity,
>(
  rows: readonly T[],
  mrpType: ComponentWeeklyMrpType,
): {
  sourceByMaterialPartNo: Map<string, T>;
  sourceCountByMaterialPartNo: Map<string, number>;
} {
  const sourceByMaterialPartNo = new Map<string, T>();
  const sourceCountByMaterialPartNo = new Map<string, number>();

  for (const row of rows) {
    const materialPartNo = normalizeComponentWeeklyMaterialPartNo(row.erpPartNo);
    if (!materialPartNo) continue;
    if (
      mrpType === 'W'
      && row.subtypeCode !== 'MTRL-WR'
      && row.subtypeCode !== 'MTRL-WD'
    ) {
      continue;
    }

    sourceCountByMaterialPartNo.set(
      materialPartNo,
      (sourceCountByMaterialPartNo.get(materialPartNo) ?? 0) + 1,
    );
    const current = sourceByMaterialPartNo.get(materialPartNo);
    if (!current || row.id > current.id) {
      sourceByMaterialPartNo.set(materialPartNo, row);
    }
  }

  return { sourceByMaterialPartNo, sourceCountByMaterialPartNo };
}
