import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { config } from '@/lib/config';
import {
  buildSourceWorkOrderRagicUrl,
  isYe1Warehouse,
  WAREHOUSE_STOCK_GROUPS,
  type WarehouseStockGroup,
} from '@/lib/mrp/warehouse-stock';
import {
  MRP_AVAILABLE_INVENTORY_QUALITIES,
  hasInventoryLotQuantityValidation,
  isMrpAvailableInventoryQuality,
} from '@/lib/sync/inventory-snapshot';

export async function GET(req: NextRequest) {
  const runId = Number(req.nextUrl.searchParams.get('runId'));
  const partVersion = req.nextUrl.searchParams.get('partVersion')?.trim();
  const warehouseGroup = req.nextUrl.searchParams.get('warehouse') as WarehouseStockGroup | null;
  const aggregated = req.nextUrl.searchParams.get('aggregated') === 'true';
  const dbSource = req.nextUrl.searchParams.get('dbSource');

  if (!Number.isInteger(runId) || runId <= 0 || !partVersion || !warehouseGroup || !WAREHOUSE_STOCK_GROUPS[warehouseGroup]) {
    return NextResponse.json({ error: '缺少或無效的 runId、partVersion、warehouse' }, { status: 400 });
  }
  if (dbSource !== null && !isDbMode(dbSource)) {
    return NextResponse.json({ error: '無效的 dbSource' }, { status: 400 });
  }
  const client = dbSource ? getClientForMode(dbSource) : prisma;
  if (!client) {
    return NextResponse.json({ error: `資料庫來源目前無法使用：${dbSource}` }, { status: 503 });
  }

  const [summary, run] = await Promise.all([
    client.fgMonthly.findFirst({
      where: { mrpRunId: runId, partVersion, isAggregated: aggregated },
      select: { erpPartNo: true, aggregatedMembers: true },
    }),
    client.mrpRun.findUnique({ where: { id: runId }, select: { syncCounts: true } }),
  ]);
  const fallbackPart = !summary && !aggregated
    ? await client.stagingPartVersion.findFirst({
        where: { mrpRunId: runId, partVersion },
        select: { erpPartNo: true },
      })
    : null;
  if (!summary && !fallbackPart) {
    return NextResponse.json({ error: '找不到此 MRP Run 的成品資料' }, { status: 404 });
  }

  let erpPartNos = (summary?.erpPartNo ?? fallbackPart?.erpPartNo)
    ? [summary?.erpPartNo ?? fallbackPart!.erpPartNo!]
    : [];
  if (aggregated && summary && summary.aggregatedMembers.length > 0) {
    const members = await client.stagingPartVersion.findMany({
      where: { mrpRunId: runId, partVersion: { in: summary.aggregatedMembers } },
      select: { erpPartNo: true },
      distinct: ['erpPartNo'],
    });
    erpPartNos = members.flatMap((member) => member.erpPartNo ? [member.erpPartNo] : []);
  }

  const allLots = erpPartNos.length > 0
    ? await client.stagingInventoryLot.findMany({
        where: {
          mrpRunId: runId,
          erpPartNo: { in: erpPartNos },
        },
        orderBy: [{ erpPartNo: 'asc' }, { stockPc: 'desc' }, { lotNo: 'asc' }],
      })
    : [];
  const lots = allLots.filter((lot) => (
    isYe1Warehouse(lot.warehouseCode) === (warehouseGroup === 'YE1')
  ));

  const sourceWorkOrderNos = [...new Set(
    lots.flatMap((lot) => lot.sourceWorkOrderNo ? [lot.sourceWorkOrderNo] : []),
  )];
  const sourceWorkOrders = sourceWorkOrderNos.length > 0
    ? await client.stagingWorkOrder.findMany({
        where: { mrpRunId: runId, woNumber: { in: sourceWorkOrderNos } },
        select: { woNumber: true, ragicRecordId: true },
      })
    : [];
  const sourceWorkOrderRecordIds = new Map(
    sourceWorkOrders.flatMap((workOrder) =>
      workOrder.woNumber && workOrder.ragicRecordId
        ? [[workOrder.woNumber, workOrder.ragicRecordId] as const]
        : [],
    ),
  );

  const mappedLots = lots.map((lot) => {
    const includedInMrp = isMrpAvailableInventoryQuality(lot.qualityStatus);
    const sourceWorkOrderRecordId = lot.sourceWorkOrderNo
      ? sourceWorkOrderRecordIds.get(lot.sourceWorkOrderNo)
      : null;
    return {
      ragicRecordId: lot.ragicRecordId,
      lotNo: lot.lotNo,
      erpPartNo: lot.erpPartNo,
      warehouseCode: lot.warehouseCode,
      stockStatus: lot.stockStatus,
      qualityStatus: lot.qualityStatus,
      stockPc: Number(lot.stockPc),
      stockKg: Number(lot.stockKg),
      unitWeightG: lot.unitWeightG == null ? null : Number(lot.unitWeightG),
      expectedStockPc: lot.expectedStockPc == null ? null : Number(lot.expectedStockPc),
      stockPcDiff: lot.stockPcDiff == null ? null : Number(lot.stockPcDiff),
      stockPcDiffPct: lot.stockPcDiffPct == null ? null : Number(lot.stockPcDiffPct),
      quantityAnomaly: lot.quantityAnomaly && includedInMrp,
      includedInMrp,
      sourceWorkOrderNo: lot.sourceWorkOrderNo,
      sourceWorkOrderType: lot.sourceWorkOrderType,
      sourceWorkOrderRagicUrl: lot.sourceWorkOrderNo
        ? buildSourceWorkOrderRagicUrl(config.ragicBaseUrl, lot.sourceWorkOrderNo, sourceWorkOrderRecordId)
        : null,
      ragicUrl: `${config.ragicBaseUrl}/default/forms4/16/${lot.ragicRecordId}`,
    };
  });

  const qualitySummaryMap = new Map<string, {
    qualityStatus: string;
    lotCount: number;
    stockPc: number;
    stockKg: number;
    includedInMrp: boolean;
  }>();
  for (const lot of mappedLots) {
    const qualityStatus = lot.qualityStatus?.trim() || '未設定';
    const current = qualitySummaryMap.get(qualityStatus) ?? {
      qualityStatus,
      lotCount: 0,
      stockPc: 0,
      stockKg: 0,
      includedInMrp: lot.includedInMrp,
    };
    current.lotCount += 1;
    current.stockPc += lot.stockPc;
    current.stockKg += lot.stockKg;
    qualitySummaryMap.set(qualityStatus, current);
  }

  const availableLots = mappedLots.filter((lot) => lot.includedInMrp);
  const excludedLots = mappedLots.filter((lot) => !lot.includedInMrp);
  const qualityOrder = new Map<string, number>(
    MRP_AVAILABLE_INVENTORY_QUALITIES.map((quality, index) => [quality, index]),
  );
  const qualitySummaries = [...qualitySummaryMap.values()].sort((a, b) => {
    const aOrder = qualityOrder.get(a.qualityStatus) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = qualityOrder.get(b.qualityStatus) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || a.qualityStatus.localeCompare(b.qualityStatus, 'zh-Hant');
  });

  return NextResponse.json({
    warehouse: { code: warehouseGroup, name: WAREHOUSE_STOCK_GROUPS[warehouseGroup].name },
    erpPartNos,
    totalPc: mappedLots.reduce((sum, lot) => sum + lot.stockPc, 0),
    totalKg: mappedLots.reduce((sum, lot) => sum + lot.stockKg, 0),
    availablePc: availableLots.reduce((sum, lot) => sum + lot.stockPc, 0),
    availableKg: availableLots.reduce((sum, lot) => sum + lot.stockKg, 0),
    excludedPc: excludedLots.reduce((sum, lot) => sum + lot.stockPc, 0),
    excludedKg: excludedLots.reduce((sum, lot) => sum + lot.stockKg, 0),
    qualitySummaries,
    inventoryValidationAvailable: hasInventoryLotQuantityValidation(run?.syncCounts),
    inventoryAnomalyCount: mappedLots.filter((lot) => lot.quantityAnomaly).length,
    lots: mappedLots,
    dbSource,
  });
}
