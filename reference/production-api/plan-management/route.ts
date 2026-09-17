import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { isTransferBlocked } from '@/lib/transfer-state';
import { recoverStalePendingTransfers } from '@/lib/mrp/transfer-recovery';
import { recoverStaleWorkOrderGenerations } from '@/lib/mrp/work-order-generation';
import { buildSharedErpCountMap, buildSharedErpPoolUsageSet } from '@/lib/mrp/shared-erp-display';
import {
  loadInventoryAnomalyLots,
  summarizeLoadedInventoryAnomalies,
} from '@/lib/mrp/inventory-anomaly';
import {
  combineInventoryAnomalySummaries,
  hasInventoryLotQuantityValidation,
} from '@/lib/sync/inventory-snapshot';

/**
 * GET /api/plan-management — Fetch all plan suggestions with FG monthly reference data
 * Query params:
 *   runId?: specific run (defaults to latest)
 */
export async function GET(req: NextRequest) {
  try {
    const runIdParam = req.nextUrl.searchParams.get('runId');
    let latest;
    if (runIdParam) {
      latest = await prisma.mrpRun.findUnique({ where: { id: parseInt(runIdParam, 10) } });
    } else {
      latest = await getLatestRun();
    }
    if (!latest) {
      return NextResponse.json({ items: [], total: 0, runId: null, runVersionCode: null });
    }

    await Promise.all([
      recoverStalePendingTransfers(prisma, { mrpRunId: latest.id }),
      recoverStaleWorkOrderGenerations(prisma, { mrpRunId: latest.id }),
    ]);

    // Fetch all three datasets in parallel
    const [suggestions, fgData, transfers, productionPlans] = await Promise.all([
      prisma.fgPlanSuggestion.findMany({
        where: { mrpRunId: latest.id },
        orderBy: [{ partVersion: 'asc' }, { planSequence: 'asc' }],
      }),
      prisma.fgMonthly.findMany({
        where: { mrpRunId: latest.id, isAggregated: false },
        select: {
          partVersion: true,
          customerPartNo: true,
          customerCode: true,
          erpPartNo: true,
          forgingMachine: true,
          forgingParent: true,
          firstProcess: true,
          currentStockPc: true,
          mainMaterialKg: true,
          unitWeightG: true,
          sortGroup: true,
          productStatus: true,
        },
      }),
      prisma.productionPlanTransfer.findMany({
        where: { mrpRunId: latest.id },
        select: {
          id: true,
          partVersion: true,
          planSequence: true,
          ragicPlanNo: true,
          ragicUrl: true,
          ragicRecordId: true,
          workOrderStatus: true,
          workOrderError: true,
          workOrderCompletedAt: true,
        },
      }),
      prisma.stagingProductionPlan.findMany({
        where: { mrpRunId: latest.id },
        select: { partVersion: true, erpPartNo: true },
      }),
    ]);

    const anomalyLots = await loadInventoryAnomalyLots(
      prisma,
      latest.id,
      fgData.flatMap((item) => item.erpPartNo ? [item.erpPartNo] : []),
    );
    const anomalySummaries = summarizeLoadedInventoryAnomalies(anomalyLots);
    const inventoryValidationAvailable = hasInventoryLotQuantityValidation(latest.syncCounts);

    // Build lookup maps
    const fgMap = new Map(fgData.map((f) => [f.partVersion, f]));
    const sharedErpCountMap = buildSharedErpCountMap(fgData);
    const sharedPoolErps = buildSharedErpPoolUsageSet(fgData, productionPlans);
    const transferMap = new Map(
      transfers.map((t) => [`${t.partVersion}:${t.planSequence}`, t]),
    );

    // Join in JS
    const items = suggestions.map((s) => {
      const fg = fgMap.get(s.partVersion);
      const t = transferMap.get(`${s.partVersion}:${s.planSequence}`);
      const inventoryAnomaly = combineInventoryAnomalySummaries(
        fg?.erpPartNo ? [fg.erpPartNo] : [],
        anomalySummaries,
      );

      // Compute status
      const status = s.isTransferred
        ? '已轉單'
        : isTransferBlocked(s.transferStatus)
          ? '待確認'
        : s.useManualQty
          ? '已儲存'
          : '未儲存';

      return {
        id: s.id,
        mrpRunId: s.mrpRunId,
        partVersion: s.partVersion,
        planSequence: s.planSequence,
        targetStartPeriod: s.targetStartPeriod,
        fulfillToPeriod: s.fulfillToPeriod,
        suggestedQty: s.suggestedQty,
        completionDate: s.completionDate,
        materialWeightKg: s.materialWeightKg,
        bufferPct: s.bufferPct,
        useManualQty: s.useManualQty,
        isTransferred: s.isTransferred,
        transferStatus: s.transferStatus,
        transferError: s.transferError,
        // Reference from fg_monthly
        customerPartNo: fg?.customerPartNo ?? null,
        customerCode: fg?.customerCode ?? null,
        erpPartNo: fg?.erpPartNo ?? null,
        sharedErpCount: fg?.erpPartNo ? sharedErpCountMap.get(fg.erpPartNo) ?? 1 : 1,
        usesSharedErpPool: fg?.erpPartNo ? sharedPoolErps.has(fg.erpPartNo.trim()) : false,
        forgingMachine: fg?.forgingMachine ?? null,
        forgingParent: fg?.forgingParent ?? null,
        firstProcess: fg?.firstProcess ?? null,
        currentStockPc: fg?.currentStockPc ?? null,
        inventoryValidationAvailable,
        inventoryAnomalyCount: inventoryAnomaly.count,
        inventoryAnomalyDiffPc: inventoryAnomaly.absoluteDiffPc,
        inventoryAnomalyErpPartNos: inventoryAnomaly.erpPartNos,
        mainMaterialKg: fg?.mainMaterialKg ?? null,
        unitWeightG: fg?.unitWeightG ?? null,
        sortGroup: fg?.sortGroup ?? null,
        productStatus: fg?.productStatus ?? null,
        // Transfer info
        transferId: t?.id ?? null,
        ragicRecordId: t?.ragicRecordId ?? null,
        ragicPlanNo: t?.ragicPlanNo ?? null,
        ragicUrl: t?.ragicUrl ?? null,
        workOrderStatus: t?.workOrderStatus ?? null,
        workOrderError: t?.workOrderError ?? null,
        workOrderCompletedAt: t?.workOrderCompletedAt ?? null,
        // Computed
        status,
      };
    });

    return NextResponse.json({
      items,
      total: items.length,
      runId: latest.id,
      runVersionCode: latest.versionCode,
      runDate: latest.createdAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
