import { NextRequest, NextResponse } from 'next/server';
import { getIncompleteReportRunResponse } from '@/lib/mrp/report-run-response';
import prisma, { currentDbMode, getAvailableClients, getClientForMode } from '@/lib/db';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { fetchMergedData, applySearch, applySort, applyPagination } from '@/lib/mrp/merge-helpers';
import {
  applySerializedColumnFiltersToPrismaWhere,
  applySerializedColumnFiltersToRows,
  collectColumnFacetOptions,
  excludeSerializedColumnFilter,
  parseColumnFacetValueType,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
} from '@/lib/data-table-server-filters';
import { normalizeComponentWeeklyMaterialPartNo } from '@/lib/mrp/component-weekly-usage';
import {
  classifyWorkOrderMaterialUsageWarning,
  workOrderMaterialUsageWarningWhere,
} from '@/lib/mrp/work-order-material-anomaly';
import { groupPeriodRows } from '@/lib/mrp/list-periods-contract';
import { ClientScopedAsyncCache } from '@/lib/mrp/client-scoped-async-cache';

const COMPONENT_WEEKLY_MODEL_FIELDS = new Set<string>(
  Object.values(Prisma.ComponentWeeklyScalarFieldEnum),
);
const COMPONENT_WEEKLY_FILTER_FIELDS = new Set<string>([
  ...COMPONENT_WEEKLY_MODEL_FIELDS,
  'dbSource',
]);

type GroupByDelegate = {
  groupBy: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};

const usageWarningCache = new ClientScopedAsyncCache<Awaited<ReturnType<typeof loadUsageWarningRows>>>();

function usageWarningWhere(runId: number, mrpType: string) {
  const where = workOrderMaterialUsageWarningWhere(runId);
  if (mrpType === 'B') {
    where.sourceType = { in: ['採購', '外購'] };
  }
  if (mrpType === 'D') {
    where.sourceType = '內製';
    where.processCode = '組合';
  }
  return where;
}

async function loadUsageWarningRows(
  client: PrismaClient,
  runId: number,
  mrpType: string,
) {
  const where = usageWarningWhere(runId, mrpType);
  const [inventory, rows] = await Promise.all([
    mrpType === 'W'
      ? client.stagingInventory.findMany({
          where: {
            mrpRunId: runId,
            subtypeCode: { in: ['MTRL-WR', 'MTRL-WD'] },
          },
          select: { erpPartNo: true },
        })
      : Promise.resolve([]),
    client.stagingWorkOrderBom.findMany({
      where,
      orderBy: [{ woNumber: 'asc' }, { componentNo: 'asc' }],
      select: {
        ragicRecordId: true,
        woNumber: true,
        componentNo: true,
        minUsage: true,
        unit: true,
        sourceType: true,
        processCode: true,
        issuedQtyState: true,
        issuedQtyError: true,
        movementState: true,
        movementError: true,
      },
    }),
  ]);
  const wireParts = new Set(
    inventory
      .map((row) => normalizeComponentWeeklyMaterialPartNo(row.erpPartNo))
      .filter((partNo): partNo is string => partNo !== null),
  );
  return rows.flatMap((row) => {
    const componentNo = normalizeComponentWeeklyMaterialPartNo(row.componentNo);
    if (mrpType === 'W' && (!componentNo || !wireParts.has(componentNo))) return [];
    const warning = classifyWorkOrderMaterialUsageWarning(row);
    return warning ? [{ row, warning, componentNo }] : [];
  });
}

async function getUsageWarnings(
  client: PrismaClient,
  runId: number,
  mrpType: string,
  dbSource?: string,
  materialFilter?: ReadonlySet<string>,
) {
  const allWarnings = await usageWarningCache.get(
    client,
    `${runId}:${mrpType}`,
    () => loadUsageWarningRows(client, runId, mrpType),
  );
  const warnings = materialFilter
    ? allWarnings.filter(({ componentNo }) => !!componentNo && materialFilter.has(componentNo))
    : allWarnings;
  return {
    count: warnings.length,
    blockingCount: warnings.filter(({ warning }) => warning.level === 'blocking').length,
    reviewCount: warnings.filter(({ warning }) => warning.level === 'review').length,
    items: warnings.slice(0, 50).map(({ row, warning }) => ({
      ragicRecordId: row.ragicRecordId,
      woNumber: row.woNumber,
      componentNo: row.componentNo,
      plannedUsage: Number(row.minUsage) || 0,
      unit: row.unit,
      sourceType: row.sourceType,
      processCode: row.processCode,
      level: warning.level,
      reason: warning.reason,
      dbSource,
    })),
  };
}

/**
 * GET /api/component-weekly — Get component weekly projection data
 * Query params:
 *   mrpType: required — 'W', 'B', or 'D'
 *   runId?: specific run (defaults to latest)
 *   search?: filter by material part no
 *   page?: page number (default 1)
 *   limit?: items per page (default 50)
 *   sortFields?: comma-separated "field:direction" pairs
 *   filter_*: column filters (e.g. "filter_unit=equals:KG")
 *   merge?: "true" to query all available DBs and merge results
 */
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const mrpType = url.searchParams.get('mrpType');
    if (!mrpType || !['W', 'B', 'D'].includes(mrpType)) {
      return NextResponse.json(
        { error: 'mrpType query param required (W, B, or D)' },
        { status: 400 },
      );
    }

    const merge = url.searchParams.get('merge') === 'true';
    const search = url.searchParams.get('search') || '';
    const facet = url.searchParams.get('facet');
    const facetType = parseColumnFacetValueType(url.searchParams.get('facetType'));
    if (facet !== null && (!COMPONENT_WEEKLY_FILTER_FIELDS.has(facet) || !facetType)) {
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
      COMPONENT_WEEKLY_FILTER_FIELDS,
    );
    const effectiveColumnFilters = facet
      ? excludeSerializedColumnFilter(columnFilters, facet)
      : columnFilters;
    const allowedSortFields = merge
      ? new Set([...COMPONENT_WEEKLY_MODEL_FIELDS, 'dbSource'])
      : COMPONENT_WEEKLY_MODEL_FIELDS;
    const requestedSortFields = parseSerializedSortFields(sortFieldsParam, allowedSortFields);
    const parsedSortFields = requestedSortFields.length > 0
      ? requestedSortFields
      : [{ key: 'materialPartNo', dir: 'asc' as const }];

    // === MERGE MODE ===
    if (merge) {
      const merged = await fetchMergedData(
        async (client) => {
          const run = await client.mrpRun.findFirst({
            where: { isLatest: true, status: 'completed' },
            orderBy: { createdAt: 'desc' },
          });
          if (!run) return { items: [], run: null };
          const items = await client.componentWeekly.findMany({
            where: { mrpRunId: run.id, mrpType },
          });
          return { items, run };
        },
        (item) => `${item.materialPartNo}::${item.mrpType}`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let filtered = (merged.items as any[]).filter(
        (item) => normalizeComponentWeeklyMaterialPartNo(item.materialPartNo) !== null,
      );
      if (search) {
        filtered = applySearch(filtered, search, ['materialPartNo']);
      }
      filtered = applySerializedColumnFiltersToRows(filtered, effectiveColumnFilters);

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

      const winningMaterialsBySource = new Map<string, Set<string>>();
      for (const item of merged.items) {
        const materialPartNo = normalizeComponentWeeklyMaterialPartNo(item.materialPartNo);
        if (!materialPartNo) continue;
        const source = String(item.dbSource);
        if (!winningMaterialsBySource.has(source)) {
          winningMaterialsBySource.set(source, new Set());
        }
        winningMaterialsBySource.get(source)!.add(materialPartNo);
      }

      const clients = await getAvailableClients();
      const warningResults = await Promise.allSettled(clients.map(async ({ mode, client }) => {
        const winningMaterials = winningMaterialsBySource.get(mode);
        if (!winningMaterials || winningMaterials.size === 0) {
          return { count: 0, blockingCount: 0, reviewCount: 0, items: [] };
        }
        const run = await client.mrpRun.findFirst({
          where: { isLatest: true, status: 'completed' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        return run
          ? getUsageWarnings(client, run.id, mrpType, mode, winningMaterials)
          : { count: 0, blockingCount: 0, reviewCount: 0, items: [] };
      }));
      const usageWarnings = warningResults.reduce(
        (acc, result) => {
          if (result.status === 'fulfilled') {
            acc.count += result.value.count;
            acc.blockingCount += result.value.blockingCount;
            acc.reviewCount += result.value.reviewCount;
            acc.items.push(...result.value.items);
          } else {
            acc.incompleteSources += 1;
          }
          return acc;
        },
        {
          count: 0,
          blockingCount: 0,
          reviewCount: 0,
          items: [] as Awaited<ReturnType<typeof getUsageWarnings>>['items'],
          incompleteSources: 0,
        },
      );
      usageWarnings.items = usageWarnings.items.slice(0, 50);

      return NextResponse.json({ items: paged, total, sources: merged.sources, usageWarnings, page, limit });
    }

    // === SINGLE DB MODE (existing behavior) ===
    const runIdParam = url.searchParams.get('runId');
    let runId: number;
    let runVersionCode: string | null = null;
    let runDate: string | null = null;
    if (runIdParam) {
      runId = Number(runIdParam);
      if (!Number.isInteger(runId) || runId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
      }
    } else {
      const latest = await getLatestRun();
      if (!latest) {
        return NextResponse.json({ items: [], total: 0, runId: null });
      }
      const incomplete = getIncompleteReportRunResponse(latest.status);
      if (incomplete) return incomplete;
      runId = latest.id;
      runVersionCode = latest.versionCode;
      runDate = latest.runDate instanceof Date
        ? latest.runDate.toISOString().split('T')[0]
        : String(latest.runDate);
    }

    if (runIdParam && !runVersionCode) {
      const run = await prisma.mrpRun.findUnique({ where: { id: runId } });
      if (!run) return NextResponse.json({ error: 'MRP Run not found' }, { status: 404 });
      const incomplete = getIncompleteReportRunResponse(run.status);
      if (incomplete) return incomplete;
      runVersionCode = run.versionCode;
      runDate = run.runDate instanceof Date
        ? run.runDate.toISOString().split('T')[0]
        : String(run.runDate);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      mrpRunId: runId,
      mrpType,
      materialPartNo: search
        ? { contains: search, mode: 'insensitive', notIn: ['*', '.'] }
        : { notIn: ['*', '.'] },
    };

    applySerializedColumnFiltersToPrismaWhere(
      where,
      effectiveColumnFilters,
      new Set(['dbSource']),
    );

    if (facet && facetType) {
      if (facet === 'dbSource') {
        return NextResponse.json({
          facet,
          options: [],
          merge: false,
          runId,
          dbSource: null,
        });
      }
      const groups = await (prisma.componentWeekly as unknown as GroupByDelegate).groupBy({
        by: [facet],
        where,
        _count: { _all: true },
        orderBy: { [facet]: 'asc' },
      });
      return NextResponse.json({
        facet,
        options: collectColumnFacetOptions(groups, facet, facetType, facetQuery, facetLimit),
        merge: false,
        runId,
        dbSource: null,
      });
    }

    const orderBy: Prisma.ComponentWeeklyOrderByWithRelationInput[] = requestedSortFields.length > 0
      ? requestedSortFields.map(({ key, dir }) => ({ [key]: dir }))
      : [{ materialPartNo: 'asc' }];

    const warningClient = getClientForMode(currentDbMode()) ?? prisma;
    const [items, total, usageWarnings] = await Promise.all([
      prisma.componentWeekly.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.componentWeekly.count({ where }),
      getUsageWarnings(warningClient, runId, mrpType),
    ]);
    const visiblePeriods = includePeriods && items.length > 0
      ? await prisma.componentWeeklyPeriod.findMany({
          where: {
            mrpRunId: runId,
            mrpType,
            materialPartNo: { in: items.map((item) => item.materialPartNo) },
          },
          orderBy: [{ materialPartNo: 'asc' }, { weekIndex: 'asc' }],
        })
      : [];

    return NextResponse.json({
      items,
      total,
      usageWarnings,
      runId,
      runVersionCode,
      runDate,
      periods: includePeriods ? groupPeriodRows(visiblePeriods, 'materialPartNo') : undefined,
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
