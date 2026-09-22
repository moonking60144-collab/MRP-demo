import { Prisma } from '@prisma/client';
import { ARCHIVE_VIEWS, archiveColumns, type ArchiveRunItem, type ArchiveView } from '../archive/browser-contract';
import type { ArchiveFgReport } from '../archive/fg-report-contract';
import type { ArchiveWeeklyReport } from '../archive/weekly-report-contract';
import { dataset, type DemoDataset, type DemoRow } from './data';
import { DemoError } from './run-control';

export const archiveRuns: ArchiveRunItem[] = Array.from({ length: 64 }, (_, index) => ({ id: `d3e00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, sourceRunId: 1000 + index + 1, versionCode: `DEMO-HISTORY-${String(64 - index).padStart(3, '0')}`, runDate: `2026-09-0${3 - index % 3}`, sourceStatus: 'completed', verifiedAt: '2026-09-04T00:00:00.000Z', generation: index === 63 ? 'G1' : index === 62 ? 'G4' : 'G5', seedFileName: 'generated-synthetic-seed.json' }));
export function archiveRun(id: string): ArchiveRunItem { const run = archiveRuns.find((item) => item.id === id); if (!run) throw new DemoError('找不到合成歷史版本。', 404); return run; }
export function archiveDataset(id: string): DemoDataset {
  const run = archiveRun(id);
  const data = structuredClone(dataset(3 - (run.sourceRunId - 1001) % 3));
  data.run = { ...data.run, id: run.sourceRunId, versionCode: run.versionCode, runDate: `${run.runDate}T00:00:00.000Z`, isLatest: false };
  for (const rows of [data.fg, data.cw, data.sales, ...Object.values(data.fgPeriods), ...Object.values(data.cwPeriods), ...Object.values(data.salesPeriods), ...Object.values(data.source)]) for (const row of rows) row.mrpRunId = run.sourceRunId;
  return data;
}
export function archiveScalars(modelName: string, rows: DemoRow[], missing: string[] = []): Array<Record<string, string | null>> {
  const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === modelName)!;
  return rows.map((row) => Object.fromEntries(model.fields.filter((field) => field.kind !== 'object' && !field.isList).map((field) => [field.name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), missing.includes(field.name) || row[field.name] == null ? null : typeof row[field.name] === 'object' ? JSON.stringify(row[field.name]) : String(row[field.name])])));
}
function query(params: URLSearchParams) {
  const page = params.get('page') ?? '1', q = (params.get('q') ?? '').trim();
  if (!/^[1-9]\d{0,4}$/.test(page) || q.length > 100) throw new DemoError('歷史查詢條件無效。');
  return { page: Number(page), q: q.toLowerCase(), pageSize: 50 };
}
function filtered(rows: DemoRow[], params: URLSearchParams, sorts: string[]): DemoRow[] {
  const { q } = query(params);
  const sort = params.get('sort') ?? sorts[0], direction = params.get('direction') ?? 'asc';
  const shortage = params.get('shortage') ?? 'false';
  if (!sorts.includes(sort) || !['asc', 'desc'].includes(direction) || !['true', 'false'].includes(shortage)) throw new DemoError('歷史排序或篩選無效。');
  return rows.filter((row) => (!q || Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(q))) && (shortage !== 'true' || Boolean(row.shouldPlanProduction) || row.shortageStartWeek != null)).sort((a, b) => (typeof a[sort] === 'number' ? Number(a[sort]) - Number(b[sort]) : String(a[sort] ?? '').localeCompare(String(b[sort] ?? ''))) * (direction === 'desc' ? -1 : 1));
}
export function archiveFgReport(id: string, params: URLSearchParams): ArchiveFgReport {
  const run = archiveRun(id), data = archiveDataset(id), { page, pageSize } = query(params);
  const flag = params.get('aggregated') ?? 'false'; if (!['true', 'false'].includes(flag)) throw new DemoError('歷史聚合條件無效。');
  const aggregated = flag === 'true';
  const rows = filtered(data.fg.filter((row) => row.isAggregated === aggregated), params, ['forgingParent', 'customerPartNo', 'erpPartNo', 'partVersion', 'customerCode', 'forgingMachine', 'shortageStartPeriod', 'currentStockPc']);
  const selected = rows.slice((page - 1) * pageSize, page * pageSize);
  const firstProcessFields = ['firstProcessErpPartNo', 'firstProcessSourceType'];
  const missingFields = run.generation === 'G1' ? ['mainStockPc', 'auxStockPc', ...firstProcessFields]
    : run.generation === 'G4' ? firstProcessFields : [];
  return { run, page, pageSize, total: rows.length, aggregated, warehouseAvailable: run.generation !== 'G1', missingFields, rows: archiveScalars('FgMonthly', selected, missingFields), periods: archiveScalars('FgMonthlyPeriod', selected.flatMap((row) => data.fgPeriods[String(row.partVersion) + (aggregated ? ':aggregate' : '')] ?? [])) };
}
export function archiveWeeklyReport(id: string, params: URLSearchParams): ArchiveWeeklyReport {
  const run = archiveRun(id), data = archiveDataset(id), { page, pageSize } = query(params);
  const kind = params.get('kind') ?? 'component', mrpType = params.get('mrpType') ?? 'W';
  if (!['component', 'sales'].includes(kind) || !['W', 'B', 'D'].includes(mrpType)) throw new DemoError('歷史週推條件無效。');
  const component = kind === 'component';
  let source = component ? data.cw.filter((row) => row.mrpType === mrpType) : data.sales;
  if (params.has('material')) source = source.filter((row) => row.materialPartNo === params.get('material'));
  const rows = filtered(source, params, component ? ['materialPartNo', 'goodStockPc', 'stockWeeks', 'shortageStartWeek'] : ['partVersion', 'customerCode', 'erpPartNo', 'shortageStartWeek', 'totalFgDiff']);
  const selected = rows.slice((page - 1) * pageSize, page * pageSize);
  const map = component ? data.cwPeriods : data.salesPeriods;
  return { run, kind: kind as 'component' | 'sales', mrpType, page, pageSize, total: rows.length, missingFields: [], warehouseAvailable: run.generation !== 'G1', rows: archiveScalars(component ? 'ComponentWeekly' : 'SalesMeeting', selected), periods: archiveScalars(component ? 'ComponentWeeklyPeriod' : 'SalesMeetingPeriod', selected.flatMap((row) => map[String(row[component ? 'materialPartNo' : 'partVersion'])] ?? [])) };
}
const tables: Record<ArchiveView, [string, string]> = { 'fg-monthly': ['FgMonthly', 'fg'], 'fg-periods': ['FgMonthlyPeriod', 'fgPeriods'], 'component-weekly': ['ComponentWeekly', 'cw'], 'component-periods': ['ComponentWeeklyPeriod', 'cwPeriods'], 'sales-meeting': ['SalesMeeting', 'sales'], 'sales-periods': ['SalesMeetingPeriod', 'salesPeriods'], inventory: ['StagingInventory', 'inventory'], orders: ['StagingOrder', 'orders'], forecasts: ['StagingForecast', 'forecasts'], 'production-plans': ['StagingProductionPlan', 'production_plans'], 'work-orders': ['StagingWorkOrder', 'work_orders'], bom: ['StagingWorkOrderBom', 'work_order_bom'], purchases: ['StagingPurchaseOrder', 'purchase_orders'], movements: ['StagingWorkOrderMaterialMovement', 'work_order_material_movements'] };
export function archiveGet(path: string[], params: URLSearchParams): unknown {
  if (path.length === 2) { const { page, q, pageSize } = query(params); const filtered = archiveRuns.filter((run) => !q || run.versionCode.toLowerCase().includes(q) || String(run.sourceRunId) === q); return { runs: filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: filtered.length }; }
  const id = path[2];
  if (path.length === 3) return archiveRun(id);
  if (path[3] === 'fg-report') return archiveFgReport(id, params);
  if (path[3] === 'weekly-report') return archiveWeeklyReport(id, params);
  const view = path[3] as ArchiveView;
  if (!Object.hasOwn(ARCHIVE_VIEWS, view)) throw new DemoError('未知合成歷史資料表。', 404);
  const run = archiveRun(id), data = archiveDataset(id), { page, q, pageSize } = query(params), [model, table] = tables[view];
  const value = data[table as keyof DemoDataset] ?? data.source[table];
  const source = Array.isArray(value) ? value as DemoRow[] : Object.values(value as Record<string, DemoRow[]>).flat();
  const rows = archiveScalars(model, source).filter((row) => !q || Object.values(row).some((value) => value?.toLowerCase().includes(q)));
  return { run, view, sourcePresent: true, total: rows.length, page, pageSize, columns: archiveColumns(view).map((column) => ({ ...column, missing: false, type: 'text' })), rows: rows.slice((page - 1) * pageSize, page * pageSize) };
}
