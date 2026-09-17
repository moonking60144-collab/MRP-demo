import {
  applySerializedColumnFiltersToRows,
  collectColumnFacetOptions,
  excludeSerializedColumnFilter,
  parseColumnFacetValueType,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
} from '@/lib/data-table-server-filters';
import { FG_TRAD_SUMMABLE_KEYS } from '@/components/data-table/column-defs/fg-monthly-columns';
import { aggregateFgMonthlyPeriodTotals } from '@/lib/mrp/fg-monthly-totals';
import { isTestErpPartNo } from '@/lib/mrp/fg-monthly-filters';
import { sumPhysicalInventoryByErp } from '@/lib/mrp/shared-erp-display';
import type { DemoDataset, DemoRow } from './data';
import { Prisma } from '@prisma/client';
import { classifyWorkOrderMaterialUsageWarning } from '../mrp/work-order-material-anomaly';
import { matchesComponentWeeklyUsageType } from '../mrp/component-weekly-usage';

export function usageWarnings(data: DemoDataset, type: string) {
  const wires = new Set(data.source.inventory.filter((row) => ['MTRL-WR', 'MTRL-WD'].includes(String(row.subtypeCode))).map((row) => row.erpPartNo));
  const items = data.source.work_order_bom.flatMap((row) => {
    if (!matchesComponentWeeklyUsageType({ sourceType: row.sourceType as string | null, processCode: row.processCode as string | null }, type as 'W' | 'B' | 'D') || type === 'W' && !wires.has(row.componentNo)) return [];
    const warning = classifyWorkOrderMaterialUsageWarning(row as unknown as Parameters<typeof classifyWorkOrderMaterialUsageWarning>[0]);
    return warning ? [{ ...row, ...warning, plannedUsage: Number(row.minUsage) }] : [];
  });
  return { count: items.length, blockingCount: items.filter((row) => row.level === 'blocking').length, reviewCount: items.filter((row) => row.level === 'review').length, items: items.slice(0, 50) };
}

const REPORT_FIELDS = {
  'fg-monthly': new Set([...Object.values(Prisma.FgMonthlyScalarFieldEnum), 'dbSource', 'inventoryAnomalyCount']),
  'component-weekly': new Set([...Object.values(Prisma.ComponentWeeklyScalarFieldEnum), 'dbSource']),
  'sales-meeting': new Set([...Object.values(Prisma.SalesMeetingScalarFieldEnum), 'dbSource', 'customerPartNo', 'inventoryAnomalyCount']),
};
const SOURCE_FIELDS = {
  part_versions: Prisma.StagingPartVersionScalarFieldEnum,
  inventory: Prisma.StagingInventoryScalarFieldEnum,
  orders: Prisma.StagingOrderScalarFieldEnum,
  forecasts: Prisma.StagingForecastScalarFieldEnum,
  work_orders: Prisma.StagingWorkOrderScalarFieldEnum,
  work_order_bom: Prisma.StagingWorkOrderBomScalarFieldEnum,
  inventory_lots: Prisma.StagingInventoryLotScalarFieldEnum,
  work_order_material_movements: Prisma.StagingWorkOrderMaterialMovementScalarFieldEnum,
  production_plans: Prisma.StagingProductionPlanScalarFieldEnum,
  purchase_orders: Prisma.StagingPurchaseOrderScalarFieldEnum,
};

export function reportFilterFields(report: string, table: string) {
  if (report in REPORT_FIELDS) return REPORT_FIELDS[report as keyof typeof REPORT_FIELDS];
  const fields = SOURCE_FIELDS[table as keyof typeof SOURCE_FIELDS];
  if (!fields) throw new Error('未知來源資料表');
  return new Set<string>(Object.values(fields));
}

export function filterReportRows(items: DemoRow[], params: URLSearchParams, allowed: ReadonlySet<string>) {
  const facet = params.get('facet');
  const filters = parseSerializedColumnFilters(params, allowed);
  let rows = applySerializedColumnFiltersToRows(items, facet ? excludeSerializedColumnFilter(filters, facet) : filters);
  const search = (params.get('search') ?? params.get('q') ?? '').toLocaleLowerCase();
  if (search) rows = rows.filter((item) => Object.values(item).some((value) => String(value ?? '').toLocaleLowerCase().includes(search)));
  if (params.get('shortage') === 'true' || params.get('shortageOnly') === 'true') rows = rows.filter((item) => ('shouldPlanProduction' in item ? item.shouldPlanProduction : item.shortageStartWeek != null));
  if (params.get('excludeTest') === 'true') rows = rows.filter((item) => !isTestErpPartNo(item.erpPartNo));
  if (params.get('anomalyOnly') === 'true') rows = rows.filter((item) => Number(item.inventoryAnomalyCount ?? item.anomalyCount ?? 0) > 0);
  if (params.get('customerCode')) rows = rows.filter((item) => item.customerCode === params.get('customerCode'));
  const machine = params.get('machineFilter') ?? params.get('machine') ?? 'all';
  if (machine === 'internal') rows = rows.filter((item) => !String(item.forgingMachine ?? '').includes('['));
  else if (machine === 'supplier') rows = rows.filter((item) => String(item.forgingMachine ?? '').includes('['));
  else if (machine !== 'all') rows = rows.filter((item) => item.forgingMachine === machine);
  const partVersions = params.get('partVersionsIn')?.split(',').filter(Boolean) ?? [];
  if (partVersions.length) rows = rows.filter((item) => partVersions.includes(String(item.partVersion)));
  const sort = parseSerializedSortFields(params.get('sortFields') ?? '', allowed);
  rows.sort((a, b) => {
    for (const { key, dir } of sort) {
      const result = typeof a[key] === 'number' && typeof b[key] === 'number'
        ? Number(a[key]) - Number(b[key])
        : String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'zh-TW');
      if (result) return result * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
  if (!facet) return { rows, facet: null };
  const valueType = parseColumnFacetValueType(params.get('facetType'));
  if (!allowed.has(facet) || !valueType) throw new Error('unsupported facet');
  return { rows, facet: { facet, options: collectColumnFacetOptions(rows, facet, valueType, params.get('facetQuery') ?? '', Number(params.get('facetLimit') ?? 100)) } };
}

export function paginateReportRows(rows: DemoRow[], params: URLSearchParams) {
  const page = Number(params.get('page') ?? 1), limit = Number(params.get('limit') ?? 50);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('分頁參數無效');
  return { items: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
}

export function fgMonthlyTotals(data: DemoDataset, rows: DemoRow[]) {
  const summaries = rows.map((row) => ({
    partVersion: String(row.partVersion),
    erpPartNo: row.erpPartNo == null ? null : String(row.erpPartNo),
    currentStockPc: row.currentStockPc, mainStockPc: row.mainStockPc,
    auxStockPc: row.auxStockPc, badStockPc: row.badStockPc,
  }));
  const preperiod = Object.fromEntries(FG_TRAD_SUMMABLE_KEYS.map((key) => {
    const values = rows.map((row) => row[key]).filter((value) => value != null && Number.isFinite(Number(value)));
    return [key, values.length ? values.reduce<number>((sum, value) => sum + Number(value), 0) : null];
  }));
  Object.assign(preperiod, sumPhysicalInventoryByErp(summaries));
  const periods = summaries.flatMap((row) => (data.fgPeriods[row.partVersion] ?? []).map((period) => ({
    partVersion: row.partVersion, periodIndex: Number(period.periodIndex),
    remainingStock: period.remainingStock, remainingNoPlan: period.remainingNoPlan,
    plannedOutput: period.plannedOutput, demandIntegrated: period.demandIntegrated,
    forecastQty: period.forecastQty, ordersUnshipped: period.ordersUnshipped, ordersTotal: period.ordersTotal,
  })));
  return { preperiod, periods: aggregateFgMonthlyPeriodTotals(summaries, periods) };
}
