import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import {
  applySerializedColumnFiltersToPrismaWhere,
  collectColumnFacetOptions,
  excludeSerializedColumnFilter,
  parseColumnFacetValueType,
  parseSerializedColumnFilters,
  parseSerializedSortFields,
  type SerializedColumnFilter,
} from '@/lib/data-table-server-filters';
import { classifyWorkOrderMaterialAnomaly } from '@/lib/mrp/work-order-material-anomaly';

const SOURCE_TABLE_FIELDS: Record<string, ReadonlySet<string>> = {
  part_versions: new Set(Object.values(Prisma.StagingPartVersionScalarFieldEnum)),
  inventory: new Set(Object.values(Prisma.StagingInventoryScalarFieldEnum)),
  orders: new Set(Object.values(Prisma.StagingOrderScalarFieldEnum)),
  forecasts: new Set(Object.values(Prisma.StagingForecastScalarFieldEnum)),
  work_orders: new Set(Object.values(Prisma.StagingWorkOrderScalarFieldEnum)),
  work_order_bom: new Set(Object.values(Prisma.StagingWorkOrderBomScalarFieldEnum)),
  inventory_lots: new Set(Object.values(Prisma.StagingInventoryLotScalarFieldEnum)),
  work_order_material_movements: new Set(
    Object.values(Prisma.StagingWorkOrderMaterialMovementScalarFieldEnum),
  ),
  production_plans: new Set(Object.values(Prisma.StagingProductionPlanScalarFieldEnum)),
  purchase_orders: new Set(Object.values(Prisma.StagingPurchaseOrderScalarFieldEnum)),
};

const SOURCE_SEARCH_FIELDS: Record<string, string[]> = {
  part_versions: ['partVersion', 'customerCode', 'erpPartNo', 'customerPartNo'],
  inventory: ['erpPartNo', 'subtypeCode'],
  orders: ['partVersion'],
  forecasts: ['partVersion'],
  work_orders: ['partVersion', 'erpPartNo', 'jobOrderCode'],
  work_order_bom: ['woNumber', 'componentNo', 'processCode', 'issuedQtyError', 'movementError'],
  inventory_lots: ['lotNo', 'erpPartNo', 'warehouseCode', 'sourceWorkOrderNo'],
  work_order_material_movements: [
    'workOrderNo', 'bomItemKey', 'inventoryLotNo', 'componentNo', 'basisType', 'movementType',
  ],
  production_plans: ['partVersion', 'erpPartNo'],
  purchase_orders: ['productNo'],
};

type GroupByDelegate = {
  groupBy: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};

/**
 * GET /api/source-data — Browse staging (source) data snapshots
 * Query params:
 *   table: which staging table to query
 *   runId: MRP run ID (required)
 *   search?: text search across key fields
 *   page?: page number (default 1)
 *   limit?: items per page (default 100)
 *   sortFields?: comma-separated "field:direction" pairs (e.g. "partVersion:asc,orderQty:desc")
 *   filter_*: column filters (e.g. "filter_customerCode=contains:SY")
 */
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const table = url.searchParams.get('table') || 'part_versions';
    const runIdParam = url.searchParams.get('runId');
    const search = url.searchParams.get('search') || '';
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const sortFieldsParam = url.searchParams.get('sortFields') || '';
    const anomalyOnly = url.searchParams.get('anomalyOnly') === 'true';

    if (!runIdParam) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }
    const allowedFields = SOURCE_TABLE_FIELDS[table];
    if (!allowedFields) {
      return NextResponse.json({ error: `Unknown table: ${table}` }, { status: 400 });
    }
    const runId = parseInt(runIdParam, 10);
    const offset = (page - 1) * limit;

    const facet = url.searchParams.get('facet');
    const facetType = parseColumnFacetValueType(url.searchParams.get('facetType'));
    if (facet !== null && (!allowedFields.has(facet) || !facetType)) {
      return NextResponse.json({ error: 'unsupported facet' }, { status: 400 });
    }
    const facetQuery = url.searchParams.get('facetQuery') || '';
    const facetLimit = parseInt(url.searchParams.get('facetLimit') || '100', 10);

    const orderBy = parseSortFields(sortFieldsParam, table, allowedFields);
    const columnFilters = parseSerializedColumnFilters(url.searchParams, allowedFields);
    const effectiveColumnFilters = facet
      ? excludeSerializedColumnFilter(columnFilters, facet)
      : columnFilters;

    if (facet && facetType) {
      const baseWhere = buildWhere(
        runId,
        search,
        effectiveColumnFilters,
        SOURCE_SEARCH_FIELDS[table] || [],
      );
      const where = table === 'work_order_bom' && anomalyOnly
        ? withWorkOrderBomAnomalyFilter(baseWhere)
        : baseWhere;
      const groups = await getSourceGroupByDelegate(table).groupBy({
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
        table,
      });
    }

    let items: unknown[] = [];
    let total = 0;

    switch (table) {
      case 'part_versions': {
        const where = buildWhere(runId, search, columnFilters, ['partVersion', 'customerCode', 'erpPartNo', 'customerPartNo']);
        [items, total] = await Promise.all([
          prisma.stagingPartVersion.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingPartVersion.count({ where }),
        ]);
        break;
      }
      case 'inventory': {
        const where = buildWhere(runId, search, columnFilters, ['erpPartNo', 'subtypeCode']);
        [items, total] = await Promise.all([
          prisma.stagingInventory.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingInventory.count({ where }),
        ]);
        break;
      }
      case 'orders': {
        const where = buildWhere(runId, search, columnFilters, ['partVersion']);
        [items, total] = await Promise.all([
          prisma.stagingOrder.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingOrder.count({ where }),
        ]);
        break;
      }
      case 'forecasts': {
        const where = buildWhere(runId, search, columnFilters, ['partVersion']);
        [items, total] = await Promise.all([
          prisma.stagingForecast.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingForecast.count({ where }),
        ]);
        break;
      }
      case 'work_orders': {
        const where = buildWhere(runId, search, columnFilters, ['partVersion', 'erpPartNo', 'jobOrderCode']);
        [items, total] = await Promise.all([
          prisma.stagingWorkOrder.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingWorkOrder.count({ where }),
        ]);
        break;
      }
      case 'work_order_bom': {
        const baseWhere = buildWhere(
          runId,
          search,
          columnFilters,
          ['woNumber', 'componentNo', 'processCode', 'issuedQtyError', 'movementError'],
        );
        const where = anomalyOnly ? withWorkOrderBomAnomalyFilter(baseWhere) : baseWhere;
        const [rows, count] = await Promise.all([
          prisma.stagingWorkOrderBom.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingWorkOrderBom.count({ where }),
        ]);
        const workOrderIds = await findWorkOrderRecordIds(
          runId,
          rows.map((row) => row.woNumber),
        );
        items = rows.map((row) => {
          const anomaly = classifyWorkOrderMaterialAnomaly(row);
          return {
            ...row,
            workOrderRagicRecordId: row.woNumber
              ? workOrderIds.get(row.woNumber.trim()) ?? null
              : null,
            anomalyLevel: anomaly.level,
            anomalyReason: anomaly.reason,
          };
        });
        total = count;
        break;
      }
      case 'inventory_lots': {
        const where = buildWhere(
          runId,
          search,
          columnFilters,
          ['lotNo', 'erpPartNo', 'warehouseCode', 'sourceWorkOrderNo'],
        );
        const [rows, count] = await Promise.all([
          prisma.stagingInventoryLot.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingInventoryLot.count({ where }),
        ]);
        const workOrderIds = await findWorkOrderRecordIds(
          runId,
          rows.map((row) => row.sourceWorkOrderNo),
        );
        items = rows.map((row) => ({
          ...row,
          sourceWorkOrderRagicRecordId: row.sourceWorkOrderNo
            ? workOrderIds.get(row.sourceWorkOrderNo.trim()) ?? null
            : null,
        }));
        total = count;
        break;
      }
      case 'work_order_material_movements': {
        const where = buildWhere(
          runId,
          search,
          columnFilters,
          ['workOrderNo', 'bomItemKey', 'inventoryLotNo', 'componentNo', 'basisType', 'movementType'],
        );
        const [rows, count] = await Promise.all([
          prisma.stagingWorkOrderMaterialMovement.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy,
          }),
          prisma.stagingWorkOrderMaterialMovement.count({ where }),
        ]);
        const workOrderIds = await findWorkOrderRecordIds(
          runId,
          rows.map((row) => row.workOrderNo),
        );
        items = rows.map((row) => ({
          ...row,
          workOrderRagicRecordId: workOrderIds.get(row.workOrderNo.trim()) ?? null,
        }));
        total = count;
        break;
      }
      case 'production_plans': {
        const where = buildWhere(runId, search, columnFilters, ['partVersion', 'erpPartNo']);
        [items, total] = await Promise.all([
          prisma.stagingProductionPlan.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingProductionPlan.count({ where }),
        ]);
        break;
      }
      case 'purchase_orders': {
        const where = buildWhere(runId, search, columnFilters, ['productNo']);
        [items, total] = await Promise.all([
          prisma.stagingPurchaseOrder.findMany({ where, skip: offset, take: limit, orderBy }),
          prisma.stagingPurchaseOrder.count({ where }),
        ]);
        break;
      }
      default:
        return NextResponse.json({ error: `Unknown table: ${table}` }, { status: 400 });
    }

    return NextResponse.json({ items, total, page, limit, table, runId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

const DEFAULT_SORT: Record<string, Record<string, string>[]> = {
  part_versions: [{ partVersion: 'asc' }],
  inventory: [{ erpPartNo: 'asc' }],
  orders: [{ deliveryDate: 'asc' }],
  forecasts: [{ forecastStart: 'asc' }],
  work_orders: [{ jobOrderCode: 'asc' }],
  work_order_bom: [{ componentNo: 'asc' }],
  inventory_lots: [{ erpPartNo: 'asc' }, { lotNo: 'asc' }],
  work_order_material_movements: [{ movementDate: 'desc' }, { ragicRecordId: 'desc' }],
  production_plans: [{ completionDate: 'asc' }],
  purchase_orders: [{ deliveryDate: 'asc' }],
};

function parseSortFields(
  param: string,
  table: string,
  allowedFields: ReadonlySet<string>,
): Record<string, string>[] {
  const fields = parseSerializedSortFields(param, allowedFields);
  return fields.length > 0
    ? fields.map(({ key, dir }) => ({ [key]: dir }))
    : DEFAULT_SORT[table] || [{ id: 'asc' }];
}

async function findWorkOrderRecordIds(
  runId: number,
  workOrderNumbers: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const normalizedNumbers = [...new Set(
    workOrderNumbers
      .map((value) => value?.trim())
      .filter((value): value is string => !!value),
  )];
  if (normalizedNumbers.length === 0) return new Map();

  const rows = await prisma.stagingWorkOrder.findMany({
    where: { mrpRunId: runId, woNumber: { in: normalizedNumbers } },
    select: { woNumber: true, ragicRecordId: true },
  });
  return new Map(rows.flatMap((row) => {
    const workOrderNo = row.woNumber?.trim();
    return workOrderNo && row.ragicRecordId
      ? [[workOrderNo, row.ragicRecordId] as const]
      : [];
  }));
}


function buildWhere(
  runId: number,
  search: string,
  filters: SerializedColumnFilter[],
  searchFields: string[],
): Record<string, unknown> {
  const where: Record<string, unknown> = { mrpRunId: runId };
  if (search) {
    where.OR = searchFields.map((field) => ({
      [field]: { contains: search, mode: 'insensitive' },
    }));
  }
  return applySerializedColumnFiltersToPrismaWhere(where, filters);
}

function withWorkOrderBomAnomalyFilter(baseWhere: Record<string, unknown>) {
  return {
    AND: [
      baseWhere,
      {
        OR: [
          { issuedQtyState: 'unknown' },
          { movementState: 'unknown' },
          { issuedQtyError: { not: null } },
          {
            AND: [
              { issuedQtyState: { not: 'not_issued' } },
              { movementError: { not: null } },
            ],
          },
          { overIssuedQty: { gt: 0 } },
          {
            AND: [
              { issuedQtyState: { not: 'not_issued' } },
              { movementState: 'fallback' },
            ],
          },
        ],
      },
    ],
  };
}

function getSourceGroupByDelegate(table: string): GroupByDelegate {
  switch (table) {
    case 'part_versions': return prisma.stagingPartVersion as unknown as GroupByDelegate;
    case 'inventory': return prisma.stagingInventory as unknown as GroupByDelegate;
    case 'orders': return prisma.stagingOrder as unknown as GroupByDelegate;
    case 'forecasts': return prisma.stagingForecast as unknown as GroupByDelegate;
    case 'work_orders': return prisma.stagingWorkOrder as unknown as GroupByDelegate;
    case 'work_order_bom': return prisma.stagingWorkOrderBom as unknown as GroupByDelegate;
    case 'inventory_lots': return prisma.stagingInventoryLot as unknown as GroupByDelegate;
    case 'work_order_material_movements':
      return prisma.stagingWorkOrderMaterialMovement as unknown as GroupByDelegate;
    case 'production_plans': return prisma.stagingProductionPlan as unknown as GroupByDelegate;
    case 'purchase_orders': return prisma.stagingPurchaseOrder as unknown as GroupByDelegate;
    default: throw new Error(`Unknown table: ${table}`);
  }
}
