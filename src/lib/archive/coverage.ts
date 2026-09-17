import type { ArchiveSchemaGeneration } from './seed-manifest';

export const ARCHIVE_RUN_TABLES = [
  'public.mrp_run',
  'staging.part_versions', 'staging.inventory', 'staging.inventory_lots',
  'staging.orders', 'staging.forecasts', 'staging.work_orders',
  'staging.work_order_bom', 'staging.work_order_material_movements',
  'staging.production_plans', 'staging.purchase_orders',
  'mrp_out.fg_monthly', 'mrp_out.fg_monthly_periods', 'mrp_out.fg_plan_suggestions',
  'mrp_out.component_weekly', 'mrp_out.component_weekly_periods',
  'mrp_out.sales_meeting', 'mrp_out.sales_meeting_periods',
] as const;

export interface ArchiveTableEvidence {
  tableName: string;
  status: string;
  sourcePresent: boolean;
  sourceRows: bigint | null;
  archiveRows: bigint | null;
  sourceDigest: string | null;
  archiveDigest: string | null;
  verifiedAt: Date | null;
}

// This validates recorded table evidence, not physical Archive contents or deletion permission.
export function hasCompleteTableEvidence(
  generation: ArchiveSchemaGeneration,
  tables: ArchiveTableEvidence[],
): boolean {
  if (tables.length !== ARCHIVE_RUN_TABLES.length) return false;
  const byName = new Map(tables.map(table => [table.tableName, table]));
  if (byName.size !== tables.length) return false;
  return ARCHIVE_RUN_TABLES.every(name => {
    const table = byName.get(name);
    if (!table || !table.verifiedAt || !Number.isFinite(table.verifiedAt.getTime())) return false;
    if (!table.sourcePresent) {
      return generation === 'G1' && name === 'staging.work_order_material_movements' &&
        table.status === 'not-in-source' && table.sourceRows === null && table.archiveRows === BigInt(0) &&
        table.sourceDigest === null && table.archiveDigest === null;
    }
    return table.status === 'verified' && table.sourceRows !== null && table.sourceRows >= BigInt(0) &&
      table.archiveRows === table.sourceRows && typeof table.sourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(table.sourceDigest) && table.archiveDigest === table.sourceDigest;
  });
}
