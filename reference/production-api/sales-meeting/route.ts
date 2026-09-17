import { NextRequest, NextResponse } from 'next/server';
import { getIncompleteReportRunResponse } from '@/lib/mrp/report-run-response';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma, { currentDbMode, getClientForMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { fetchMergedData, applySort, applyPagination } from '@/lib/mrp/merge-helpers';
import { buildSharedErpCountMap } from '@/lib/mrp/shared-erp-display';
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
  applySerializedColumnFiltersToRows,
  collectColumnFacetOptions,
  collectCustomerCodeOptions,
  excludeSerializedColumnFilter,
  parseColumnFacetValueType,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
  type SerializedColumnFilter,
} from '@/lib/data-table-server-filters';
import {
  buildSalesMeetingPeriodMap,
  expandSalesMeetingFacetRows,
  groupSalesMeetingRows,
  type SalesMeetingDisplayRow,
  type SalesMeetingGroupableRow,
} from '@/lib/mrp/sales-meeting-display';
import { ClientScopedAsyncCache } from '@/lib/mrp/client-scoped-async-cache';

const SALES_MEETING_MODEL_FIELDS = new Set<string>(
  Object.values(Prisma.SalesMeetingScalarFieldEnum),
);
const SALES_MEETING_FILTER_FIELDS = new Set<string>([
  ...SALES_MEETING_MODEL_FIELDS,
  'dbSource',
  'customerPartNo',
  'inventoryAnomalyCount',
]);
const NUMERIC_FIELDS = [
  'goodStockPc',
  'goodStockKg',
  'wfgStockPc',
  'ye1StockPc',
  'badStockPc',
  'badStockKg',
  'avgDemandPerWeek',
  'stockWeeks',
  'purchaseLeadWeeks',
  'outstanding04',
  'fgDiff04',
  'totalOrderDemand',
  'totalFgDiff',
] as const;

interface SalesMeetingBaseModel {
  grouped: Array<SalesMeetingDisplayRow<SalesMeetingGroupableRow>>;
  sharedErpCounts: Map<string, number>;
}

// Completed Runs are immutable. Keep only a few whole-Run models because each entry
// contains thousands of grouped rows; page/search/filter state stays request-scoped.
const baseModelCache = new ClientScopedAsyncCache<SalesMeetingBaseModel>(4, 5 * 60_000);

function normalizeRow<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [
      field,
      row[field] == null ? null : Number(row[field]),
    ])),
  };
}

function applyDisplayFilters<T extends SalesMeetingGroupableRow & { memberPartVersions: string[] }>(
  rows: T[],
  filters: SerializedColumnFilter[],
  skippedColumns: ReadonlySet<string> = new Set(),
): T[] {
  const partVersionFilters = filters.filter((filter) => filter.columnId === 'partVersion');
  let filtered = applySerializedColumnFiltersToRows(
    rows,
    filters,
    new Set([...skippedColumns, 'inventoryAnomalyCount', 'partVersion']),
  );
  if (partVersionFilters.length > 0) {
    filtered = filtered.filter((row) => row.memberPartVersions.some((partVersion) => (
      applySerializedColumnFiltersToRows([{ partVersion }], partVersionFilters).length > 0
    )));
  }
  return filtered;
}

function applyDisplaySearch<T extends SalesMeetingGroupableRow & { memberPartVersions: string[] }>(
  rows: T[],
  search: string,
): T[] {
  const expected = search.trim().toLocaleLowerCase();
  if (!expected) return rows;
  return rows.filter((row) => [
    row.customerCode,
    row.customerPartNo,
    row.erpPartNo,
    ...row.memberPartVersions,
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(expected)));
}

async function enrichRows<T extends Record<string, unknown> & {
  partVersion: string;
  erpPartNo: string | null;
  wfgStockPc: unknown;
  ye1StockPc: unknown;
}>(
  client: PrismaClient,
  run: { id: number; syncCounts: unknown },
  rows: T[],
  sharedCounts: ReadonlyMap<string, number> = buildSharedErpCountMap(rows),
) {
  const erpPartNos = [...new Set(rows.flatMap((row) => row.erpPartNo ? [row.erpPartNo] : []))];
  const anomalyLots = await loadInventoryAnomalyLots(client, run.id, erpPartNos);
  const anomalySummaries = summarizeLoadedInventoryAnomalies(anomalyLots);
  const inventorySnapshotAvailable = hasInventoryLotSnapshot(run.syncCounts);
  const inventoryValidationAvailable = hasInventoryLotQuantityValidation(run.syncCounts);

  return rows.map((row) => {
    const rowErps = row.erpPartNo ? [row.erpPartNo] : [];
    const anomaly = combineInventoryAnomalySummaries(rowErps, anomalySummaries);
    const warehouseAnomalies = countInventoryAnomaliesByWarehouse(anomalyLots, rowErps);
    return normalizeRow({
      ...row,
      wfgStockPc: inventorySnapshotAvailable ? row.wfgStockPc : null,
      ye1StockPc: inventorySnapshotAvailable ? row.ye1StockPc : null,
      sharedErpCount: row.erpPartNo ? sharedCounts.get(row.erpPartNo.trim()) ?? 1 : 1,
      inventoryValidationAvailable,
      inventoryAnomalyCount: anomaly.count,
      wfgInventoryAnomalyCount: warehouseAnomalies.internal,
      ye1InventoryAnomalyCount: warehouseAnomalies.ye1,
      inventoryAnomalyDiffPc: anomaly.absoluteDiffPc,
      inventoryAnomalyErpPartNos: anomaly.erpPartNos,
    });
  });
}

async function loadBaseModel(client: PrismaClient, runId: number): Promise<SalesMeetingBaseModel> {
  const [summaryRows, partRows] = await Promise.all([
    client.salesMeeting.findMany({ where: { mrpRunId: runId } }),
    client.stagingPartVersion.findMany({
      where: { mrpRunId: runId },
      select: { partVersion: true, customerPartNo: true },
    }),
  ]);
  const customerPartByVersion = new Map(
    partRows.map((row) => [row.partVersion, row.customerPartNo]),
  );
  const normalizedRows = summaryRows.map((row) => normalizeRow({
    ...row,
    customerPartNo: customerPartByVersion.get(row.partVersion) ?? null,
  })) as unknown as SalesMeetingGroupableRow[];
  return {
    grouped: groupSalesMeetingRows(normalizedRows),
    sharedErpCounts: buildSharedErpCountMap(normalizedRows),
  };
}

/**
 * GET /api/sales-meeting — Get sales meeting weekly projection data
 * Query params:
 *   runId?: specific run (defaults to latest)
 *   search?: filter by partVersion or erpPartNo
 *   page?: page number (default 1)
 *   limit?: items per page (default 50)
 *   sortFields?: comma-separated "field:direction" pairs
 *   filter_*: column filters (e.g. "filter_unit=equals:KG")
 *   merge?: "true" to query all available DBs and merge results
 */
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const merge = url.searchParams.get('merge') === 'true';
    const search = url.searchParams.get('search') || '';
    const facet = url.searchParams.get('facet');
    const facetType = parseColumnFacetValueType(url.searchParams.get('facetType'));
    if (facet !== null && (!SALES_MEETING_FILTER_FIELDS.has(facet) || !facetType)) {
      return NextResponse.json({ error: 'unsupported facet' }, { status: 400 });
    }
    const facetQuery = url.searchParams.get('facetQuery') || '';
    const facetLimit = parseInt(url.searchParams.get('facetLimit') || '100', 10);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const includePeriods = url.searchParams.get('includePeriods') === '1';
    const sortFieldsParam = url.searchParams.get('sortFields') || '';
    const columnFilters = parseSerializedColumnFilters(
      url.searchParams,
      SALES_MEETING_FILTER_FIELDS,
    );
    const effectiveColumnFilters = facet
      ? excludeSerializedColumnFilter(columnFilters, facet)
      : columnFilters;
    const inventoryAnomalyFilters = effectiveColumnFilters.filter(
      (filter) => filter.columnId === 'inventoryAnomalyCount',
    );
    const allowedSortFields = merge
      ? new Set([...SALES_MEETING_MODEL_FIELDS, 'customerPartNo', 'dbSource'])
      : new Set([...SALES_MEETING_MODEL_FIELDS, 'customerPartNo']);
    const requestedSortFields = parseSerializedSortFields(sortFieldsParam, allowedSortFields);
    const parsedSortFields = requestedSortFields.length > 0
      ? requestedSortFields
      : [
          { key: 'erpPartNo', dir: 'asc' as const },
          { key: 'customerCode', dir: 'asc' as const },
          { key: 'customerPartNo', dir: 'asc' as const },
        ];

    // === MERGE MODE ===
    if (merge) {
      const merged = await fetchMergedData(
        async (client) => {
          const run = await client.mrpRun.findFirst({
            where: { isLatest: true, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          });
          if (!run) return { items: [], run: null };
          const [items, partRows] = await Promise.all([
            client.salesMeeting.findMany({ where: { mrpRunId: run.id } }),
            client.stagingPartVersion.findMany({
              where: { mrpRunId: run.id },
              select: { partVersion: true, customerPartNo: true },
            }),
          ]);
          const customerPartByVersion = new Map(
            partRows.map((row) => [row.partVersion, row.customerPartNo]),
          );
          const normalizedItems = items.map((item) => ({
            ...item,
            customerPartNo: customerPartByVersion.get(item.partVersion) ?? null,
          }));
          return {
            items: await enrichRows(
              client,
              run,
              normalizedItems,
              buildSharedErpCountMap(items),
            ),
            run,
          };
        },
        (item) => item.partVersion as string,
      );

      const grouped = groupSalesMeetingRows(
        merged.items as unknown as SalesMeetingGroupableRow[],
      );
      let filtered = grouped;
      if (search) {
        filtered = applyDisplaySearch(filtered, search);
      }
      filtered = applyDisplayFilters(filtered, effectiveColumnFilters);
      if (inventoryAnomalyFilters.length > 0) {
        filtered = applySerializedColumnFiltersToRows(filtered, inventoryAnomalyFilters);
      }


      if (facet && facetType) {
        return NextResponse.json({
          facet,
          options: collectColumnFacetOptions(
            expandSalesMeetingFacetRows(filtered, facet),
            facet,
            facetType,
            facetQuery,
            facetLimit,
          ),
          merge: true,
          runId: null,
          dbSource: null,
          sources: merged.sources,
        });
      }

      const total = filtered.length;
      filtered = applySort(filtered, parsedSortFields);
      const paged = applyPagination(filtered, page, limit);

      return NextResponse.json({
        items: paged,
        total,
        sources: merged.sources,
        filterOptions: { customerCode: collectCustomerCodeOptions(grouped) },
        page,
        limit,
      });
    }

    // === SINGLE DB MODE (existing behavior) ===
    const reportClient = getClientForMode(currentDbMode()) ?? prisma;
    const runIdParam = url.searchParams.get('runId');
    let runId: number;
    let runVersionCode: string | null = null;
    let runDate: string | null = null;
    let runSyncCounts: unknown = null;
    if (runIdParam) {
      runId = Number(runIdParam);
      if (!Number.isInteger(runId) || runId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
      }
    } else {
      const latest = await getLatestRun(reportClient);
      if (!latest) {
        return NextResponse.json({ items: [], total: 0, runId: null });
      }
      const incomplete = getIncompleteReportRunResponse(latest.status);
      if (incomplete) return incomplete;
      runId = latest.id;
      runVersionCode = latest.versionCode;
      runSyncCounts = latest.syncCounts;
      runDate = latest.runDate instanceof Date
        ? latest.runDate.toISOString().split('T')[0]
        : String(latest.runDate);
    }

    if (runIdParam && !runVersionCode) {
      const run = await reportClient.mrpRun.findUnique({ where: { id: runId } });
      if (!run) return NextResponse.json({ error: 'MRP Run not found' }, { status: 404 });
      const incomplete = getIncompleteReportRunResponse(run.status);
      if (incomplete) return incomplete;
      runVersionCode = run.versionCode;
      runSyncCounts = run.syncCounts;
      runDate = run.runDate instanceof Date
        ? run.runDate.toISOString().split('T')[0]
        : String(run.runDate);
    }

    const { grouped, sharedErpCounts } = await baseModelCache.get(
      reportClient,
      String(runId),
      () => loadBaseModel(reportClient, runId),
    );
    let filtered = applyDisplaySearch(grouped, search);
    filtered = applyDisplayFilters(filtered, effectiveColumnFilters, new Set(['dbSource']));

    let enrichedForFilter: Array<
      SalesMeetingGroupableRow & { memberPartVersions: string[]; inventoryAnomalyCount: number }
    > | null = null;
    if (inventoryAnomalyFilters.length > 0) {
      enrichedForFilter = await enrichRows(
        reportClient,
        { id: runId, syncCounts: runSyncCounts },
        filtered,
        sharedErpCounts,
      );
      filtered = applySerializedColumnFiltersToRows(enrichedForFilter, inventoryAnomalyFilters);
    }

    if (facet && facetType) {
      const facetRows = facet === 'inventoryAnomalyCount' && !enrichedForFilter
        ? await enrichRows(
            reportClient,
            { id: runId, syncCounts: runSyncCounts },
            filtered,
            sharedErpCounts,
          )
        : enrichedForFilter ?? filtered;
      return NextResponse.json({
        facet,
        options: collectColumnFacetOptions(
          expandSalesMeetingFacetRows(facetRows, facet),
          facet,
          facetType,
          facetQuery,
          facetLimit,
        ),
        merge: false,
        runId,
        dbSource: null,
      });
    }

    const total = filtered.length;
    const sorted = applySort(filtered, parsedSortFields);
    const paged = applyPagination(sorted, page, limit);
    const enrichedItems = enrichedForFilter
      ? paged
      : await enrichRows(
          reportClient,
          { id: runId, syncCounts: runSyncCounts },
          paged,
          sharedErpCounts,
        );
    const visiblePartVersions = enrichedItems.flatMap((item) => item.memberPartVersions as string[]);
    const visiblePeriods = includePeriods && visiblePartVersions.length > 0
        ? await reportClient.salesMeetingPeriod.findMany({
            where: {
              mrpRunId: runId,
              partVersion: { in: visiblePartVersions },
            },
            orderBy: [{ partVersion: 'asc' }, { weekIndex: 'asc' }],
          })
        : [];
    const periodMap = includePeriods
      ? buildSalesMeetingPeriodMap(
          visiblePeriods.map((period) => ({
            ...period,
            remainingStock: period.remainingStock == null ? null : Number(period.remainingStock),
            demand: Number(period.demand),
            supply: Number(period.supply),
          })),
          enrichedItems.map((item) => ({
            partVersion: String(item.partVersion),
            memberPartVersions: item.memberPartVersions as string[],
          })),
        )
      : undefined;

    return NextResponse.json({
      items: enrichedItems,
      total,
      runId,
      runVersionCode,
      runDate,
      filterOptions: { customerCode: collectCustomerCodeOptions(grouped) },
      periods: periodMap,
      page,
      limit,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
