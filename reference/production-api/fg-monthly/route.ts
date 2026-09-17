import { NextRequest, NextResponse } from 'next/server';
import { getIncompleteReportRunResponse } from '@/lib/mrp/report-run-response';
import { Prisma, type PrismaClient } from '@prisma/client';
import { currentDbMode, getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { fetchMergedData, applySearch, applySort, applyPagination } from '@/lib/mrp/merge-helpers';
import { getIgnoredCustomerCodes } from '@/lib/app-settings';
import { FG_TRAD_SUMMABLE_KEYS } from '@/components/data-table/column-defs/fg-monthly-columns';
import { attachSharedErpPoolInfo, sumPhysicalInventoryByErp } from '@/lib/mrp/shared-erp-display';
import { normalizeFgMonthlyDecimals } from '@/lib/mrp/fg-monthly-output';
import {
  combineInventoryAnomalySummaries,
  hasInventoryLotQuantityValidation,
  hasInventoryLotSnapshot,
} from '@/lib/sync/inventory-snapshot';
import {
  countInventoryAnomaliesByWarehouse,
  loadInventoryAnomalyLots,
  summarizeLoadedInventoryAnomalies,
} from '@/lib/mrp/inventory-anomaly';
import {
  isTestErpPartNo,
} from '@/lib/mrp/fg-monthly-filters';
import {
  applySerializedColumnFiltersToPrismaWhere,
  applySerializedColumnFiltersToRows,
  collectColumnFacetOptions,
  collectCustomerCodeOptions,
  excludeSerializedColumnFilter,
  parseColumnFacetValueType,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
} from '@/lib/data-table-server-filters';
import { groupPeriodRows } from '@/lib/mrp/list-periods-contract';
import { aggregateFgMonthlyPeriodTotals, type FgMonthlyTotalsPeriodRow } from '@/lib/mrp/fg-monthly-totals';

/** Decimal | null → number | null */
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const FG_MONTHLY_MODEL_FIELDS = new Set<string>(
  Object.values(Prisma.FgMonthlyScalarFieldEnum),
);
const FG_MONTHLY_FILTER_FIELDS = new Set<string>([
  ...FG_MONTHLY_MODEL_FIELDS,
  'dbSource',
  'inventoryAnomalyCount',
]);
const FG_MONTHLY_PERIOD_SUBSET_LIMIT = 500;

type GroupByDelegate = {
  groupBy: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};

async function loadInventoryAnomalyFacetRows(
  client: PrismaClient,
  runId: number,
  aggregated: boolean,
  where: Prisma.FgMonthlyWhereInput,
) {
  const candidateRows = await client.fgMonthly.findMany({
    where,
    select: { partVersion: true, erpPartNo: true, aggregatedMembers: true },
  });
  const memberPartVersions = aggregated
    ? [...new Set(candidateRows.flatMap((row) => row.aggregatedMembers))]
    : [];
  const memberParts = memberPartVersions.length > 0
    ? await client.stagingPartVersion.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
        select: { partVersion: true, erpPartNo: true },
      })
    : [];
  const memberErpMap = new Map(memberParts.map((part) => [part.partVersion, part.erpPartNo]));
  const candidateErps = [...new Set(candidateRows.flatMap((row) => (
    aggregated && row.aggregatedMembers.length > 0
      ? row.aggregatedMembers.flatMap((member) => memberErpMap.get(member) ?? [])
      : row.erpPartNo ? [row.erpPartNo] : []
  )))];
  const anomalyLots = await loadInventoryAnomalyLots(client, runId, candidateErps);
  const anomalySummaries = summarizeLoadedInventoryAnomalies(anomalyLots);
  return candidateRows.map((row) => {
    const rowErps = aggregated && row.aggregatedMembers.length > 0
      ? row.aggregatedMembers.flatMap((member) => memberErpMap.get(member) ?? [])
      : row.erpPartNo ? [row.erpPartNo] : [];
    return {
      partVersion: row.partVersion,
      inventoryAnomalyCount: combineInventoryAnomalySummaries(rowErps, anomalySummaries).count,
    };
  });
}

interface MergedFgFilterOptions {
  shortageOnly: boolean;
  excludeTest: boolean;
  search: string;
  partVersionsIn: string[];
  machineFilter: string;
  ignoredCodes: string[];
  columnFilters: ReturnType<typeof parseSerializedColumnFilters>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMergedFgFilters(items: any[], options: MergedFgFilterOptions): any[] {
  let filtered = items;
  if (options.shortageOnly) {
    filtered = filtered.filter((item) => item.shouldPlanProduction);
  }
  if (options.excludeTest) {
    filtered = filtered.filter((item) => !isTestErpPartNo(item.erpPartNo));
  }
  if (options.search) {
    filtered = applySearch(
      filtered,
      options.search,
      ['partVersion', 'customerCode', 'erpPartNo', 'customerPartNo'],
    );
  }
  if (options.partVersionsIn.length > 0) {
    const partVersionSet = new Set(options.partVersionsIn);
    filtered = filtered.filter((item) => partVersionSet.has(item.partVersion));
  }
  if (options.machineFilter === 'internal') {
    filtered = filtered.filter(
      (item) => !item.forgingMachine || !item.forgingMachine.includes('['),
    );
  } else if (options.machineFilter === 'supplier') {
    filtered = filtered.filter((item) => item.forgingMachine?.includes('['));
  } else if (options.machineFilter !== 'all') {
    filtered = filtered.filter((item) => item.forgingMachine === options.machineFilter);
  }
  if (options.ignoredCodes.length > 0) {
    filtered = filtered.filter(
      (item) => item.customerCode == null || !options.ignoredCodes.includes(item.customerCode),
    );
  }
  filtered = applySerializedColumnFiltersToRows(
    filtered,
    options.columnFilters,
    new Set(['inventoryAnomalyCount']),
  );
  filtered = applySerializedColumnFiltersToRows(
    filtered,
    options.columnFilters.filter((filter) => filter.columnId === 'inventoryAnomalyCount'),
  );
  return filtered;
}

/**
 * GET /api/fg-monthly — Get FG monthly projection data
 * Query params:
 *   runId?: specific run (defaults to latest)
 *   search?: filter by part version or customer code
 *   shortageOnly?: "true" to show only shortage items
 *   excludeTest?: "true" to exclude rows whose ERP part number contains TEST
 *   page?: page number (default 1)
 *   limit?: items per page (default 50)
 *   sortFields?: comma-separated "field:direction" pairs
 *   machineFilter?: "internal"|"supplier"|"all"
 *   filter_*: column filters (e.g. "filter_customerCode=contains:SY")
 *   merge?: "true" to query all available DBs and merge results
 */
export async function GET(req: NextRequest) {
  const started = performance.now();
  const timings: string[] = [];
  let checkpoint = started;
  const mark = (name: string) => {
    const now = performance.now();
    timings.push(`${name};dur=${(now - checkpoint).toFixed(1)}`);
    checkpoint = now;
  };
  try {
    const url = req.nextUrl;
    const merge = url.searchParams.get('merge') === 'true';
    const dbSource = url.searchParams.get('dbSource');
    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }
    if (merge && dbSource) {
      return NextResponse.json({ error: 'merge and dbSource cannot be combined' }, { status: 400 });
    }
    const reminderDbSource = dbSource ?? currentDbMode();
    const client = getClientForMode(reminderDbSource);
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }
    const search = url.searchParams.get('search') || '';
    const facet = url.searchParams.get('facet');
    const facetType = parseColumnFacetValueType(url.searchParams.get('facetType'));
    if (facet !== null && (!FG_MONTHLY_FILTER_FIELDS.has(facet) || !facetType)) {
      return NextResponse.json({ error: 'unsupported facet' }, { status: 400 });
    }
    const facetQuery = url.searchParams.get('facetQuery') || '';
    const facetLimit = parseInt(url.searchParams.get('facetLimit') || '100', 10);
    const shortageOnly = url.searchParams.get('shortageOnly') === 'true';
    const excludeTest = url.searchParams.get('excludeTest') === 'true';
    const aggregated = url.searchParams.get('aggregated') === 'true';
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const includePeriods = url.searchParams.get('includePeriods') === '1';
    const sortFieldsParam = url.searchParams.get('sortFields') || '';
    const machineFilter = url.searchParams.get('machineFilter') || 'all';
    const partVersionsInParam = url.searchParams.get('partVersionsIn');
    const partVersionsIn = partVersionsInParam?.split(',').filter(Boolean) ?? [];
    const columnFilters = parseSerializedColumnFilters(
      url.searchParams,
      FG_MONTHLY_FILTER_FIELDS,
    );
    const effectiveColumnFilters = facet
      ? excludeSerializedColumnFilter(columnFilters, facet)
      : columnFilters;
    const inventoryAnomalyFilters = effectiveColumnFilters.filter(
      (filter) => filter.columnId === 'inventoryAnomalyCount',
    );
    // 合計列(totals)只有傳統 view 要、且只在篩選變動時抓 —— 預設不算，
    // 避免詳細 view / 純翻頁白白多跑聚合查詢（見 code review item 1）。
    const wantTotals = url.searchParams.get('totals') === 'true';
    // 忽略清單：排除指定客戶代碼的料件（includeIgnored=true 時暫時顯示）。
    // 聚合模式不套用 —— 聚合列代表多個變體，依代表的 customerCode 過濾會誤砍整組。
    const includeIgnored = url.searchParams.get('includeIgnored') === 'true';
    const ignoredCodes = (includeIgnored || aggregated) ? [] : await getIgnoredCustomerCodes();

    // Parse sort fields
    const allowedSortFields = merge
      ? new Set([...FG_MONTHLY_MODEL_FIELDS, 'dbSource'])
      : FG_MONTHLY_MODEL_FIELDS;
    const requestedSortFields = parseSerializedSortFields(sortFieldsParam, allowedSortFields);
    const parsedSortFields = requestedSortFields.length > 0
      ? requestedSortFields
      : [{ key: 'forgingParent', dir: 'asc' as const }, { key: 'sortGroup', dir: 'asc' as const }, { key: 'erpPartNo', dir: 'asc' as const }];

    // === MERGE MODE ===
    if (merge) {
      if (wantTotals) {
        return NextResponse.json({
          items: [],
          total: 0,
          totals: null,
          sources: [],
          page: 1,
          limit: 0,
        });
      }
      if (facet === 'customerCode' && facetType && inventoryAnomalyFilters.length === 0) {
        const mergedFacetRows = await fetchMergedData(
          async (client) => {
            const run = await client.mrpRun.findFirst({
              where: { isLatest: true, status: 'completed' },
              orderBy: { createdAt: 'desc' },
            });
            if (!run) return { items: [], run: null };
            const items = await client.fgMonthly.findMany({
              where: { mrpRunId: run.id, isAggregated: aggregated },
            });
            return { items, run };
          },
          (item) => item.partVersion as string,
        );
        const filteredFacetRows = applyMergedFgFilters(
          mergedFacetRows.items.map((item) => normalizeFgMonthlyDecimals(item)),
          {
            shortageOnly,
            excludeTest,
            search,
            partVersionsIn,
            machineFilter,
            ignoredCodes,
            columnFilters: effectiveColumnFilters,
          },
        );
        return NextResponse.json({
          facet,
          options: collectColumnFacetOptions(
            filteredFacetRows,
            facet,
            facetType,
            facetQuery,
            facetLimit,
          ),
          merge: true,
          runId: null,
          dbSource: null,
          sources: mergedFacetRows.sources,
        });
      }

      const merged = await fetchMergedData(
        async (client) => {
          const run = await client.mrpRun.findFirst({
            where: { isLatest: true, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          });
          if (!run) return { items: [], run: null };

          const items = await client.fgMonthly.findMany({
            where: { mrpRunId: run.id, isAggregated: aggregated },
          });
          const inventoryLotSnapshotAvailable = hasInventoryLotSnapshot(run.syncCounts);
          const snapshotAwareItems = items.map((item) => ({
            ...item,
            wfgStockPc: inventoryLotSnapshotAvailable ? item.wfgStockPc : null,
            ye1StockPc: inventoryLotSnapshotAvailable ? item.ye1StockPc : null,
          }));
          const visibleErps = [...new Set(items.flatMap((item) => item.erpPartNo ? [item.erpPartNo] : []))];
          const aggregatedMemberPvs = aggregated
            ? [...new Set(items.flatMap((item) => item.aggregatedMembers))]
            : [];
          const [productionPlans, memberParts] = await Promise.all([
            visibleErps.length > 0
              ? client.stagingProductionPlan.findMany({
                  where: {
                    mrpRunId: run.id,
                    OR: [
                      { erpPartNo: { in: visibleErps } },
                      { erpPartNo: null },
                      { erpPartNo: '' },
                    ],
                  },
                  select: { partVersion: true, erpPartNo: true },
                })
              : Promise.resolve([]),
            aggregatedMemberPvs.length > 0
              ? client.stagingPartVersion.findMany({
                  where: { mrpRunId: run.id, partVersion: { in: aggregatedMemberPvs } },
                  select: { partVersion: true, erpPartNo: true },
                })
              : Promise.resolve([]),
          ]);
          const memberErpMap = new Map(memberParts.map((part) => [part.partVersion, part.erpPartNo]));
          const anomalyErps = [...new Set([
            ...visibleErps,
            ...memberParts.flatMap((part) => part.erpPartNo ? [part.erpPartNo] : []),
          ])];
          const anomalyLots = await loadInventoryAnomalyLots(client, run.id, anomalyErps);
          const anomalySummaries = summarizeLoadedInventoryAnomalies(anomalyLots);
          const inventoryValidationAvailable = hasInventoryLotQuantityValidation(run.syncCounts);

          // Enrich with lastPeriodRemainingNoPlan
          const partVersions = items.map((i) => i.partVersion);
          const lastPeriods = partVersions.length > 0
            ? await client.$queryRaw<{ part_version: string; remaining_no_plan: number | null }[]>`
                SELECT DISTINCT ON (part_version) part_version, remaining_no_plan
                FROM mrp_out.fg_monthly_periods
                WHERE mrp_run_id = ${run.id}
                  AND part_version = ANY(${partVersions})
                  AND is_aggregated = ${aggregated}
                ORDER BY part_version, period_index DESC
              `
            : [];
          const lastPeriodMap = new Map(lastPeriods.map((r) => [r.part_version, r.remaining_no_plan]));
          const enriched = attachSharedErpPoolInfo(snapshotAwareItems.map((item) => {
            const rowErps = aggregated && item.aggregatedMembers.length > 0
              ? item.aggregatedMembers.flatMap((member) => memberErpMap.get(member) ?? [])
              : item.erpPartNo ? [item.erpPartNo] : [];
            const anomaly = combineInventoryAnomalySummaries(rowErps, anomalySummaries);
            const warehouseAnomalies = countInventoryAnomaliesByWarehouse(anomalyLots, rowErps);
            return {
              ...item,
              lastPeriodRemainingNoPlan: lastPeriodMap.get(item.partVersion) ?? null,
              inventoryValidationAvailable,
              inventoryAnomalyCount: anomaly.count,
              wfgInventoryAnomalyCount: warehouseAnomalies.internal,
              ye1InventoryAnomalyCount: warehouseAnomalies.ye1,
              inventoryAnomalyDiffPc: anomaly.absoluteDiffPc,
              inventoryAnomalyErpPartNos: anomaly.erpPartNos,
            };
          }), snapshotAwareItems, productionPlans);

          return { items: enriched, run };
        },
        (item) => item.partVersion as string,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mergedRows = merged.items.map((item) => normalizeFgMonthlyDecimals(item)) as any[];
      const filterOptions = { customerCode: collectCustomerCodeOptions(mergedRows) };
      let filtered = applyMergedFgFilters(mergedRows, {
        shortageOnly,
        excludeTest,
        search,
        partVersionsIn,
        machineFilter,
        ignoredCodes,
        columnFilters: effectiveColumnFilters,
      });

      if (facet && facetType) {
        return NextResponse.json({
          facet,
          options: collectColumnFacetOptions(filtered, facet, facetType, facetQuery, facetLimit),
          merge: true,
          runId: null,
          dbSource: null,
          sources: merged.sources,
        });
      }

      const total = filtered.length;
      filtered = applySort(filtered, parsedSortFields);
      const paged = applyPagination(filtered, page, limit);

      // 合併 DB 模式不提供合計列（period 資料未在此端點載入）—— totals: null，前端 footer 不顯示
      // 合併 DB 模式不提供合計列（period 資料未在此端點載入）—— totals: null。
      return NextResponse.json({
        items: paged,
        total,
        totals: null,
        sources: merged.sources,
        filterOptions,
        page,
        limit,
      });
    }

    // === SINGLE DB MODE (existing behavior) ===
    const runIdParam = url.searchParams.get('runId');
    let runId: number;
    let runVersionCode: string | null = null;
    let runDate: string | null = null;
    let inventoryLotSnapshotAvailable = false;
    let inventoryValidationAvailable = false;
    if (runIdParam) {
      runId = Number(runIdParam);
      if (!Number.isInteger(runId) || runId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
      }
      const run = await client.mrpRun.findUnique({ where: { id: runId } });
      if (!run) {
        return NextResponse.json({ error: 'MRP Run not found' }, { status: 404 });
      }
      const incomplete = getIncompleteReportRunResponse(run.status);
      if (incomplete) return incomplete;
      runVersionCode = run.versionCode;
      inventoryLotSnapshotAvailable = hasInventoryLotSnapshot(run.syncCounts);
      inventoryValidationAvailable = hasInventoryLotQuantityValidation(run.syncCounts);
      runDate = run.runDate instanceof Date
        ? run.runDate.toISOString().split('T')[0]
        : String(run.runDate);
    } else {
      const latest = dbSource
        ? await client.mrpRun.findFirst({
            where: { isLatest: true, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          })
        : await getLatestRun();
      if (!latest) {
        return NextResponse.json({
          items: [],
          total: 0,
          runId: null,
          dbSource: dbSource ?? null,
        });
      }
      const incomplete = getIncompleteReportRunResponse(latest.status);
      if (incomplete) return incomplete;
      runId = latest.id;
      runVersionCode = latest.versionCode;
      inventoryLotSnapshotAvailable = hasInventoryLotSnapshot(latest.syncCounts);
      inventoryValidationAvailable = hasInventoryLotQuantityValidation(latest.syncCounts);
      runDate = latest.runDate instanceof Date
        ? latest.runDate.toISOString().split('T')[0]
        : String(latest.runDate);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { mrpRunId: runId, isAggregated: aggregated };
    if (partVersionsIn.length > 0) {
      where.partVersion = { in: partVersionsIn };
    }
    if (shortageOnly) {
      where.shouldPlanProduction = true;
    }
    if (excludeTest) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { erpPartNo: null },
            { NOT: { erpPartNo: { contains: 'test', mode: 'insensitive' } } },
          ],
        },
      ];
    }
    if (search) {
      where.OR = [
        { partVersion: { contains: search, mode: 'insensitive' } },
        { customerCode: { contains: search, mode: 'insensitive' } },
        { erpPartNo: { contains: search, mode: 'insensitive' } },
        { customerPartNo: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (machineFilter === 'internal') {
      where.AND = [
        ...(where.AND || []),
        { OR: [{ forgingMachine: { not: { contains: '[' } } }, { forgingMachine: null }] },
      ];
    } else if (machineFilter === 'supplier') {
      where.forgingMachine = { ...(where.forgingMachine || {}), contains: '[' };
    } else if (machineFilter !== 'all') {
      where.forgingMachine = machineFilter;
    }

    applySerializedColumnFiltersToPrismaWhere(
      where,
      effectiveColumnFilters,
      new Set(['dbSource', 'inventoryAnomalyCount']),
    );

    if (ignoredCodes.length > 0) {
      // null customerCode 仍要顯示 → 用 OR 保留
      where.AND = [
        ...(where.AND || []),
        { OR: [{ customerCode: null }, { customerCode: { notIn: ignoredCodes } }] },
      ];
    }

    if (inventoryAnomalyFilters.length > 0) {
      const anomalyRows = await loadInventoryAnomalyFacetRows(client, runId, aggregated, where);
      where.partVersion = {
        in: applySerializedColumnFiltersToRows(anomalyRows, inventoryAnomalyFilters)
          .map((row) => row.partVersion),
      };
    }

    if (facet && facetType) {
      const facetRows = facet === 'inventoryAnomalyCount'
        ? await loadInventoryAnomalyFacetRows(client, runId, aggregated, where)
        : facet === 'dbSource'
          ? []
          : await (client.fgMonthly as unknown as GroupByDelegate).groupBy({
              by: [facet],
              where,
              _count: { _all: true },
              orderBy: { [facet]: 'asc' },
            });
      return NextResponse.json({
        facet,
        options: collectColumnFacetOptions(facetRows, facet, facetType, facetQuery, facetLimit),
        merge: false,
        runId,
        dbSource: dbSource ?? null,
      });
    }

    const orderBy: Prisma.FgMonthlyOrderByWithRelationInput[] = requestedSortFields.length > 0
      ? requestedSortFields.map(({ key, dir }) => ({ [key]: dir }))
      : [{ forgingParent: 'asc' }, { sortGroup: 'asc' }, { erpPartNo: 'asc' }];

    // 合計加總欄位 —— 由 FG_TRAD_SUMMABLE_KEYS 單一來源衍生（與框選加總共用同一套，
    // 見 review item 3）。單位重/排序/期數那類加總無意義的欄不在內。
    const PREPERIOD_SUM_FIELDS = Object.fromEntries(
      FG_TRAD_SUMMABLE_KEYS.map((k) => [k, true]),
    ) as Prisma.FgMonthlySumAggregateInputType;

    if (wantTotals) {
      mark('totals_setup');
      const [preAgg, filteredPvRows] = await Promise.all([
        client.fgMonthly.aggregate({ where, _sum: PREPERIOD_SUM_FIELDS }),
        client.fgMonthly.findMany({
          where,
          select: {
            partVersion: true,
            erpPartNo: true,
            currentStockPc: true,
            wfgStockPc: true,
            ye1StockPc: true,
            badStockPc: true,
          },
        }),
      ]);
      mark('totals_summary');
      const filteredPartVersions = filteredPvRows.map((row) => row.partVersion);
      // 大集合的 array parameter 會讓 PostgreSQL 嚴重低估 row count；小集合則可大幅
      // 降低 Prisma materialization 與 Node 端 Decimal/物件處理量。超過閾值仍走整 Run
      // 既有查詢路徑，並由下方純函式用 summary Map 套用相同篩選集合。
      // 大集合保留 decimal 的文字精度，避免先建立數十萬個 Decimal 再轉 Number。
      const periodRows = filteredPartVersions.length > FG_MONTHLY_PERIOD_SUBSET_LIMIT
        ? await client.$queryRaw<FgMonthlyTotalsPeriodRow[]>`
            SELECT part_version AS "partVersion", period_index AS "periodIndex",
              remaining_stock::text AS "remainingStock", remaining_no_plan::text AS "remainingNoPlan",
              planned_output::text AS "plannedOutput", demand_integrated::text AS "demandIntegrated",
              forecast_qty::text AS "forecastQty", orders_unshipped::text AS "ordersUnshipped",
              orders_total::text AS "ordersTotal"
            FROM mrp_out.fg_monthly_periods
            WHERE mrp_run_id = ${runId} AND is_aggregated = ${aggregated}
          `
        : filteredPvRows.length > 0
        ? await client.fgMonthlyPeriod.findMany({
            where: {
              mrpRunId: runId,
              isAggregated: aggregated,
              partVersion: { in: filteredPartVersions },
            },
            select: {
              partVersion: true,
              periodIndex: true,
              remainingStock: true,
              remainingNoPlan: true,
              plannedOutput: true,
              demandIntegrated: true,
              forecastQty: true,
              ordersUnshipped: true,
              ordersTotal: true,
            },
          })
        : [];
      mark('totals_period_read');
      const periodTotals = aggregateFgMonthlyPeriodTotals(filteredPvRows, periodRows);
      const physicalInventory = sumPhysicalInventoryByErp(filteredPvRows);
      const preperiod = Object.fromEntries(
        Object.entries(preAgg._sum).map(([k, v]) => [k, numOrNull(v)]),
      );
      preperiod.currentStockPc = physicalInventory.currentStockPc;
      preperiod.wfgStockPc = inventoryLotSnapshotAvailable ? physicalInventory.wfgStockPc : null;
      preperiod.ye1StockPc = inventoryLotSnapshotAvailable ? physicalInventory.ye1StockPc : null;
      preperiod.badStockPc = physicalInventory.badStockPc;
      mark('totals_assemble');

      const response = NextResponse.json({
        items: [],
        total: filteredPvRows.length,
        totals: { preperiod, periods: periodTotals },
        runId,
        runVersionCode,
        runDate,
        dbSource: dbSource ?? null,
        page: 1,
        limit: 0,
      });
      mark('serialize');
      response.headers.set('Server-Timing', [...timings, `total;dur=${(performance.now() - started).toFixed(1)}`].join(', '));
      return response;
    }

    mark('setup');
    const [items, total] = await Promise.all([
      client.fgMonthly.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      client.fgMonthly.count({ where }),
    ]);

    mark('list_count');
    const partVersions = items.map((i) => i.partVersion);
    const visibleErps = [...new Set(items.flatMap((item) => item.erpPartNo ? [item.erpPartNo] : []))];
    const aggregatedMemberPvs = aggregated
      ? [...new Set(items.flatMap((item) => item.aggregatedMembers))]
      : [];
    const [lastPeriods, sharedPopulation, productionPlans, memberParts, visiblePeriods] = await Promise.all([
      partVersions.length > 0
        ? client.$queryRaw<{ part_version: string; remaining_no_plan: number | null }[]>`
            SELECT DISTINCT ON (part_version) part_version, remaining_no_plan
            FROM mrp_out.fg_monthly_periods
            WHERE mrp_run_id = ${runId}
              AND part_version = ANY(${partVersions})
              AND is_aggregated = ${aggregated}
            ORDER BY part_version, period_index DESC
          `
        : Promise.resolve([]),
      visibleErps.length > 0
        ? client.fgMonthly.findMany({
            where: { mrpRunId: runId, isAggregated: aggregated, erpPartNo: { in: visibleErps } },
            select: { partVersion: true, erpPartNo: true },
          })
        : Promise.resolve([]),
      visibleErps.length > 0
        ? client.stagingProductionPlan.findMany({
            where: {
              mrpRunId: runId,
              OR: [
                { erpPartNo: { in: visibleErps } },
                { erpPartNo: null },
                { erpPartNo: '' },
              ],
            },
            select: { partVersion: true, erpPartNo: true },
          })
        : Promise.resolve([]),
      aggregatedMemberPvs.length > 0
        ? client.stagingPartVersion.findMany({
            where: { mrpRunId: runId, partVersion: { in: aggregatedMemberPvs } },
            select: { partVersion: true, erpPartNo: true },
          })
        : Promise.resolve([]),
      includePeriods && partVersions.length > 0
        ? client.fgMonthlyPeriod.findMany({
            where: {
              mrpRunId: runId,
              partVersion: { in: partVersions },
              isAggregated: aggregated,
            },
            orderBy: [{ partVersion: 'asc' }, { periodIndex: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    mark('enrichment_queries');
    const lastPeriodMap = new Map(lastPeriods.map((r) => [r.part_version, r.remaining_no_plan]));
    const memberErpMap = new Map(memberParts.map((part) => [part.partVersion, part.erpPartNo]));
    const anomalyErps = [...new Set([
      ...visibleErps,
      ...memberParts.flatMap((part) => part.erpPartNo ? [part.erpPartNo] : []),
    ])];
    const anomalyLots = await loadInventoryAnomalyLots(client, runId, anomalyErps);
    mark('inventory_anomalies');
    const anomalySummaries = summarizeLoadedInventoryAnomalies(anomalyLots);
    // Decimal 欄統一轉 number（見 review item 2），lastPeriodRemainingNoPlan 同步轉。
    const enrichedItems = attachSharedErpPoolInfo(items, sharedPopulation, productionPlans).map((item) => {
      const rowErps = aggregated && item.aggregatedMembers.length > 0
        ? item.aggregatedMembers.flatMap((member) => memberErpMap.get(member) ?? [])
        : item.erpPartNo ? [item.erpPartNo] : [];
      const anomaly = combineInventoryAnomalySummaries(rowErps, anomalySummaries);
      const warehouseAnomalies = countInventoryAnomaliesByWarehouse(anomalyLots, rowErps);
      return {
        ...normalizeFgMonthlyDecimals(item),
        wfgStockPc: inventoryLotSnapshotAvailable ? numOrNull(item.wfgStockPc) : null,
        ye1StockPc: inventoryLotSnapshotAvailable ? numOrNull(item.ye1StockPc) : null,
        sharedErpCount: item.sharedErpCount,
        usesSharedErpPool: item.usesSharedErpPool,
        lastPeriodRemainingNoPlan: numOrNull(lastPeriodMap.get(item.partVersion)),
        inventoryValidationAvailable,
        inventoryAnomalyCount: anomaly.count,
        wfgInventoryAnomalyCount: warehouseAnomalies.internal,
        ye1InventoryAnomalyCount: warehouseAnomalies.ye1,
        inventoryAnomalyDiffPc: anomaly.absoluteDiffPc,
        inventoryAnomalyErpPartNos: anomaly.erpPartNos,
        dbSource: dbSource ?? undefined,
        materialReminderDbSource: reminderDbSource,
      };
    });

    mark('assemble');
    const response = NextResponse.json({
      items: enrichedItems,
      total,
      totals: null,
      runId,
      runVersionCode,
      runDate,
      dbSource: dbSource ?? null,
      periods: includePeriods ? groupPeriodRows(visiblePeriods, 'partVersion') : undefined,
      page,
      limit,
    });
    mark('serialize');
    response.headers.set('Server-Timing', [...timings, `total;dur=${(performance.now() - started).toFixed(1)}`].join(', '));
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
