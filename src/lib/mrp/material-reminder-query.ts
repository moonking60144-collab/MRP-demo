import { summarizeMaterialReminder, type MaterialReminderRow } from './material-reminder';

type Reader = { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> };
export interface MaterialReminderTarget { partVersion: string; aggregated: boolean }

export async function readMaterialReminders(client: Reader, scope: number | string, targets: MaterialReminderTarget[], archive = false) {
  const table = (name: string) => archive ? `archive_data.${name.replace('.', '_')}` : name;
  const scopeColumn = archive ? 'archive_run_id' : 'mrp_run_id';
  const cast = archive ? 'uuid' : 'integer';
  // Resolve aggregate members from the selected snapshot, never from a fuzzy ERP match or caller-provided members.
  const fg = await client.$queryRawUnsafe<Array<{ partVersion: string; aggregated: boolean; members: unknown }>>(`
    SELECT part_version AS "partVersion", is_aggregated AS aggregated, aggregated_members AS members
    FROM ${table('mrp_out.fg_monthly')} WHERE ${scopeColumn} = $1::${cast} AND part_version = ANY($2::text[])`, scope, targets.map(t => t.partVersion));
  const members = targets.map(target => {
    const row = fg.find(item => item.partVersion === target.partVersion && item.aggregated === target.aggregated);
    return !row ? [] : !target.aggregated ? [target.partVersion]
      : Array.isArray(row.members) ? row.members.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
  });
  const allMembers = [...new Set(members.flat())];
  const rows = allMembers.length ? await client.$queryRawUnsafe<MaterialReminderRow[]>(`
    SELECT w.part_version AS "partVersion", w.wo_number AS "woNumber", b.component_no AS "materialPartNo",
      c.mrp_type AS "mrpType", b.unit, c.unit AS "reportUnit", COALESCE(w.start_date,b.start_date)::text AS "demandDate",
      b.remaining_usage::text AS "remainingUsage", b.issued_qty_state AS "issuedQtyState", b.movement_state AS "movementState",
      c.shortage_start_week AS "shortageStartWeek", c.shortage_start_date::text AS "shortageStartDate"
    FROM ${table('staging.work_orders')} w
    LEFT JOIN ${table('staging.work_order_bom')} b ON b.${scopeColumn} = w.${scopeColumn} AND b.wo_number = w.wo_number
    LEFT JOIN ${table('mrp_out.component_weekly')} c ON c.${scopeColumn} = w.${scopeColumn} AND c.material_part_no = btrim(b.component_no)
      AND (c.mrp_type = 'W' OR (c.mrp_type = 'B' AND b.source_type IN ('採購','外購'))
        OR (c.mrp_type = 'D' AND b.source_type = '內製' AND b.process_code = '組合'))
    WHERE w.${scopeColumn} = $1::${cast} AND w.part_version = ANY($2::text[])
      AND (c.mrp_type IS NOT NULL OR b.id IS NULL OR b.source_type IN ('採購','外購')
        OR (b.source_type = '內製' AND b.process_code = '組合'))
    ORDER BY w.part_version,w.wo_number,b.id,c.mrp_type LIMIT 10001`, scope, allMembers) : [];
  if (rows.length > 10000) throw new Error('關聯材料明細超出查詢範圍，請縮小查詢');
  const byPart = new Map<string, MaterialReminderRow[]>();
  for (const row of rows) { const list = byPart.get(row.partVersion) ?? []; list.push(row); byPart.set(row.partVersion, list); }
  return targets.map((target, index) => ({ ...target, reminder: summarizeMaterialReminder(
    members[index].flatMap(member => byPart.get(member) ?? []),
    members[index].length > 0 && members[index].every(member => byPart.has(member)),
  ) }));
}
