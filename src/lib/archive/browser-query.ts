import { Prisma, type PrismaClient } from '.prisma/archive-client';
import { withSharedArchiveReader } from '../archive-db';
import { hasCompleteTableEvidence } from './coverage';
import schemas from './schema-generations.json';
import { ARCHIVE_VIEWS, archiveColumns, type ArchiveRunItem, type ArchiveView } from './browser-contract';
import { ARCHIVE_FG_SORTS, archiveFgCamel, type ArchiveFgReport } from './fg-report-contract';
import { hasInventoryLotSnapshot } from '../sync/inventory-snapshot';
import { ARCHIVE_WEEKLY_SORTS, type ArchiveWeeklyKind, type ArchiveWeeklyReport } from './weekly-report-contract';

export class ArchiveQueryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function parseArchiveQuery(params: URLSearchParams) {
  const page = params.get('page') ?? '1';
  const q = (params.get('q') ?? '').trim();
  if (!/^[1-9]\d{0,4}$/.test(page) || q.length > 100) throw new ArchiveQueryError(400, '查詢條件無效');
  return { page: Number(page), q, pageSize: 50 };
}

export function parseArchiveIdentity(id: string, view: string): ArchiveView {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ||
      !Object.hasOwn(ARCHIVE_VIEWS, view)) throw new ArchiveQueryError(400, '歷史版本或資料類別無效');
  return view as ArchiveView;
}

const selection = { source: { include: { source: true } }, tables: true } as const;
type Run = Prisma.ArchiveRunCoverageGetPayload<{ include: typeof selection }>;

function summarize(run: Run): ArchiveRunItem {
  const generation = run.source.source.schemaGeneration;
  if (!['G1', 'G4'].includes(generation) || !run.verifiedAt ||
      !hasCompleteTableEvidence(generation as 'G1' | 'G4', run.tables)) {
    throw new ArchiveQueryError(503, '歷史資料驗證資訊不完整，請聯絡管理者');
  }
  return { id: run.id, sourceRunId: run.sourceRunId, versionCode: run.versionCode,
    runDate: run.runDate.toISOString().slice(0, 10), sourceStatus: run.sourceStatus,
    verifiedAt: run.verifiedAt.toISOString(), generation, seedFileName: run.source.source.seedFileName };
}

async function read<T>(callback: (client: PrismaClient) => Promise<T>) {
  return withSharedArchiveReader(callback);
}

export async function listArchiveRuns(params: URLSearchParams) {
  const { page, q, pageSize } = parseArchiveQuery(params);
  return read(async client => {
    const where: Prisma.ArchiveRunCoverageWhereInput = { status: 'verified', verifiedAt: { not: null },
      ...(q ? { OR: [{ versionCode: { contains: q, mode: 'insensitive' } },
        ...(/^\d{1,9}$/.test(q) ? [{ sourceRunId: Number(q) }] : [])] } : {}) };
    const [total, runs] = await client.$transaction([
      client.archiveRunCoverage.count({ where }),
      client.archiveRunCoverage.findMany({ where, include: selection,
        orderBy: [{ runDate: 'desc' }, { sourceRunId: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { total, page, pageSize, runs: runs.map(summarize) };
  });
}

export async function readArchiveRun(id: string) {
  parseArchiveIdentity(id, 'fg-monthly');
  return read(async client => {
    const run = await client.archiveRunCoverage.findFirst({ where: { id, status: 'verified' }, include: selection });
    if (!run) throw new ArchiveQueryError(404, '找不到已驗證的歷史版本');
    return summarize(run);
  });
}

export async function readArchiveFgReport(id: string, params: URLSearchParams): Promise<ArchiveFgReport> {
  parseArchiveIdentity(id, 'fg-monthly');
  const { page, q, pageSize } = parseArchiveQuery(params);
  const sort = params.get('sort') ?? 'forgingParent';
  const direction = params.get('direction') ?? 'asc';
  const aggregatedValue = params.get('aggregated') ?? 'false';
  const shortageValue = params.get('shortage') ?? 'false';
  if (!Object.hasOwn(ARCHIVE_FG_SORTS, sort) || !['asc', 'desc'].includes(direction)
    || !['true', 'false'].includes(aggregatedValue) || !['true', 'false'].includes(shortageValue)) {
    throw new ArchiveQueryError(400, '查詢條件無效');
  }
  const aggregated = aggregatedValue === 'true';
  return read(client => client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    const coverage = await tx.archiveRunCoverage.findFirst({ where: { id, status: 'verified' }, include: selection });
    if (!coverage) throw new ArchiveQueryError(404, '找不到已驗證的歷史版本');
    const run = summarize(coverage);
    const evidence = coverage.tables.filter(table => ['mrp_out.fg_monthly', 'mrp_out.fg_monthly_periods'].includes(table.tableName));
    if (evidence.some(table => !table.sourcePresent)) throw new ArchiveQueryError(503, '此版本未封存完整成品月推資料');
    const projection = (table: 'mrp_out.fg_monthly' | 'mrp_out.fg_monthly_periods') => {
      const missing = new Set(evidence.find(item => item.tableName === table)!.missingColumns as string[]);
      return Prisma.join(schemas.G4[table].filter(column => !['editing_by', 'editing_since', 'aggregated_members'].includes(column.name)).map(column =>
        Prisma.raw(missing.has(column.name) ? `NULL::text AS "${column.name}"` : `t."${column.name}"::text AS "${column.name}"`)));
    };
    const literal = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const search = q ? Prisma.sql`AND (part_version ILIKE ${literal} OR customer_part_no ILIKE ${literal} OR erp_part_no ILIKE ${literal})` : Prisma.empty;
    const shortage = shortageValue === 'true' ? Prisma.sql`AND should_plan_production = true` : Prisma.empty;
    const filter = Prisma.sql`archive_run_id = ${id}::uuid AND is_aggregated = ${aggregated} ${search} ${shortage}`;
    const [count] = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::integer AS total FROM archive_data.mrp_out_fg_monthly WHERE ${filter}`);
    const rows = await tx.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
      SELECT ${projection('mrp_out.fg_monthly')},
        (SELECT count(DISTINCT s.part_version)::text FROM archive_data.mrp_out_fg_monthly s
         WHERE s.archive_run_id = ${id}::uuid AND s.is_aggregated = false AND s.erp_part_no = t.erp_part_no) AS shared_erp_count
      FROM archive_data.mrp_out_fg_monthly t WHERE ${filter}
      ORDER BY ${Prisma.raw(`t."${ARCHIVE_FG_SORTS[sort as keyof typeof ARCHIVE_FG_SORTS]}" ${direction} NULLS LAST`)}, t.customer_part_no, t.erp_part_no, t.id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    const partVersions = rows.map(row => row.part_version!);
    const periods = partVersions.length ? await tx.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
      SELECT ${projection('mrp_out.fg_monthly_periods')} FROM archive_data.mrp_out_fg_monthly_periods t
      WHERE archive_run_id = ${id}::uuid AND is_aggregated = ${aggregated} AND part_version IN (${Prisma.join(partVersions)})
      ORDER BY t.part_version, t.period_index, t.id LIMIT 5001`) : [];
    if (periods.length > 5000) throw new ArchiveQueryError(503, '此版本月份資料超出檢視範圍');
    const sourceRun = await tx.snapshotMrpRun.findFirst({ where: { archiveRunId: id }, select: { syncCounts: true } });
    return { run, rows, periods, page, pageSize, total: count.total, aggregated,
      warehouseAvailable: hasInventoryLotSnapshot(sourceRun?.syncCounts),
      missingFields: [...new Set(evidence.flatMap(table => (table.missingColumns as string[]).map(archiveFgCamel)))] };
  }, { isolationLevel: 'RepeatableRead', timeout: 15_000 }));
}

export async function readArchiveWeeklyReport(id: string, params: URLSearchParams): Promise<ArchiveWeeklyReport> {
  parseArchiveIdentity(id, 'component-weekly');
  const { page, q, pageSize } = parseArchiveQuery(params);
  const requestedKind = params.get('kind') ?? 'component';
  if (!Object.hasOwn(ARCHIVE_WEEKLY_SORTS, requestedKind)) throw new ArchiveQueryError(400, '資料類別無效');
  const kind = requestedKind as ArchiveWeeklyKind;
  const material = params.get('material');
  if (material !== null && (kind !== 'component' || !material || material.length > 200)) throw new ArchiveQueryError(400, '材料料號無效');
  const sorts: Record<string, string> = ARCHIVE_WEEKLY_SORTS[kind];
  const sort = params.get('sort') ?? (kind === 'component' ? 'materialPartNo' : 'partVersion');
  const direction = params.get('direction') ?? 'asc';
  const mrpType = params.get('mrpType') ?? 'W';
  const shortage = params.get('shortage') ?? 'false';
  if (!Object.hasOwn(sorts, sort) || !['asc', 'desc'].includes(direction) || !['W', 'B', 'D'].includes(mrpType) || !['true', 'false'].includes(shortage)) throw new ArchiveQueryError(400, '查詢條件無效');
  const summaryTable = kind === 'component' ? 'mrp_out.component_weekly' : 'mrp_out.sales_meeting';
  const periodTable = kind === 'component' ? 'mrp_out.component_weekly_periods' : 'mrp_out.sales_meeting_periods';
  const identity = kind === 'component' ? 'material_part_no' : 'part_version';
  return read(client => client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    const coverage = await tx.archiveRunCoverage.findFirst({ where: { id, status: 'verified' }, include: selection });
    if (!coverage) throw new ArchiveQueryError(404, '找不到已驗證的歷史版本');
    const run = summarize(coverage);
    const evidence = coverage.tables.filter(table => [summaryTable, periodTable].includes(table.tableName));
    if (evidence.some(table => !table.sourcePresent)) throw new ArchiveQueryError(503, '此版本未封存完整週推資料');
    const tableSql = (table: string) => Prisma.raw(`archive_data."${table.replace('.', '_')}"`);
    const projection = (table: typeof summaryTable | typeof periodTable) => {
      const missing = new Set(evidence.find(item => item.tableName === table)!.missingColumns as string[]);
      return Prisma.join(schemas.G4[table].map(column => Prisma.raw(missing.has(column.name) ? `NULL::text AS "${column.name}"` : `t."${column.name}"::text AS "${column.name}"`)));
    };
    const typeFilter = kind === 'component' ? Prisma.sql`AND mrp_type = ${mrpType}` : Prisma.empty;
    const literal = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const search = q ? (kind === 'component' ? Prisma.sql`AND material_part_no ILIKE ${literal}` : Prisma.sql`AND (part_version ILIKE ${literal} OR erp_part_no ILIKE ${literal})`) : Prisma.empty;
    const shortageFilter = shortage === 'true' ? Prisma.sql`AND shortage_start_week IS NOT NULL` : Prisma.empty;
    const exactMaterial = material !== null ? Prisma.sql`AND material_part_no = ${material}` : Prisma.empty;
    const filter = Prisma.sql`archive_run_id = ${id}::uuid ${typeFilter} ${search} ${shortageFilter} ${exactMaterial}`;
    const [count] = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::integer AS total FROM ${tableSql(summaryTable)} WHERE ${filter}`);
    const customerPart = kind === 'sales' ? Prisma.sql`, (SELECT p.customer_part_no FROM archive_data.staging_part_versions p WHERE p.archive_run_id = ${id}::uuid AND p.part_version = t.part_version ORDER BY p.id LIMIT 1) AS customer_part_no` : Prisma.empty;
    const rows = await tx.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
      SELECT ${projection(summaryTable)} ${customerPart} FROM ${tableSql(summaryTable)} t WHERE ${filter}
      ORDER BY ${Prisma.raw(`t."${sorts[sort]}" ${direction} NULLS LAST`)}, t.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    const identities = rows.map(row => row[identity]!);
    const periods = identities.length ? await tx.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
      SELECT ${projection(periodTable)} FROM ${tableSql(periodTable)} t
      WHERE archive_run_id = ${id}::uuid ${typeFilter} AND ${Prisma.raw(identity)} IN (${Prisma.join(identities)})
      ORDER BY ${Prisma.raw(`t."${identity}"`)}, t.week_index, t.id LIMIT 5001`) : [];
    if (periods.length > 5000) throw new ArchiveQueryError(503, '此版本週期資料超出檢視範圍');
    const sourceRun = await tx.snapshotMrpRun.findFirst({ where: { archiveRunId: id }, select: { syncCounts: true } });
    return { run, kind, mrpType, page, pageSize, total: count.total, rows, periods,
      warehouseAvailable: hasInventoryLotSnapshot(sourceRun?.syncCounts),
      missingFields: [...new Set(evidence.flatMap(table => (table.missingColumns as string[]).map(archiveFgCamel)))] };
  }, { isolationLevel: 'RepeatableRead', timeout: 15_000 }));
}

export async function readArchiveRows(id: string, requestedView: string, params: URLSearchParams) {
  const view = parseArchiveIdentity(id, requestedView);
  const { page, q, pageSize } = parseArchiveQuery(params);
  return read(client => client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    const coverage = await tx.archiveRunCoverage.findFirst({ where: { id, status: 'verified' }, include: selection });
    if (!coverage) throw new ArchiveQueryError(404, '找不到已驗證的歷史版本');
    const run = summarize(coverage);
    const definition = ARCHIVE_VIEWS[view];
    const evidence = coverage.tables.find(table => table.tableName === definition.table)!;
    const missing = new Set(evidence.missingColumns as string[]);
    const types = schemas.G4[definition.table as keyof typeof schemas.G4]!;
    const columns = archiveColumns(view).map(column => ({ ...column,
      type: types.find(field => field.name === column.key)!.type,
      missing: !evidence.sourcePresent || missing.has(column.key) }));
    if (!evidence.sourcePresent) return { run, view, columns, sourcePresent: false, total: 0, page, pageSize, rows: [] };
    // Identifiers come exclusively from the fixed view contract; values stay bound parameters.
    const table = Prisma.raw(`"archive_data"."${definition.table.replace('.', '_')}"`);
    const projection = Prisma.join([Prisma.raw('id::text AS id'), ...columns.map(column =>
      Prisma.raw(column.missing ? `NULL::text AS "${column.key}"` : `"${column.key}"::text AS "${column.key}"`))]);
    const literal = q.replace(/[\\%_]/g, '\\$&');
    const search = q ? Prisma.sql`AND (${Prisma.join(definition.search.map(key =>
      Prisma.sql`${Prisma.raw(`"${key}"`)} ILIKE ${`%${literal}%`}`), ' OR ')})` : Prisma.empty;
    const filter = Prisma.sql`archive_run_id = ${id}::uuid ${search}`;
    const [count] = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::integer AS total FROM ${table} WHERE ${filter}`);
    const rows = await tx.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
      SELECT ${projection} FROM ${table} t WHERE ${filter} ORDER BY t.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return { run, view, columns, sourcePresent: true, total: count.total, page, pageSize, rows };
  }, { isolationLevel: 'RepeatableRead', timeout: 15_000 }));
}
