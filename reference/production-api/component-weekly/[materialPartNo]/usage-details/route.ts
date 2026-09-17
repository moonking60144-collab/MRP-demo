import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import {
  componentWeeklyUsageWhere,
  isComponentWeeklyDateInScope,
  isComponentWeeklyMrpType,
  parseComponentWeeklyUsageWeekIndex,
  resolveComponentWeeklyMovementSummaryState,
  summarizeComponentWeeklyUsage,
} from '@/lib/mrp/component-weekly-usage';
import { resolveComponentWeeklyInitialStock } from '@/lib/mrp/component-weekly-engine';
import { resolveComponentWeeklyInventorySources } from '@/lib/mrp/component-weekly-inventory-source';
import { isComponentWeeklyPurchaseOverdue } from '@/lib/mrp/component-weekly-purchase';
import type { MrpWeek } from '@/lib/mrp/period-utils';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ materialPartNo: string }> },
) {
  try {
    const { materialPartNo: encodedMaterialPartNo } = await params;
    const materialPartNo = decodeURIComponent(encodedMaterialPartNo).trim();
    const mrpType = req.nextUrl.searchParams.get('mrpType');
    const runId = Number(req.nextUrl.searchParams.get('runId'));
    const weekIndexParam = req.nextUrl.searchParams.get('weekIndex');
    const weekIndex = parseComponentWeeklyUsageWeekIndex(weekIndexParam);
    const dbSource = req.nextUrl.searchParams.get('dbSource');

    if (!materialPartNo) {
      return NextResponse.json({ error: 'materialPartNo required' }, { status: 400 });
    }
    if (!isComponentWeeklyMrpType(mrpType)) {
      return NextResponse.json({ error: 'mrpType query param required (W, B, or D)' }, { status: 400 });
    }
    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'runId query param required' }, { status: 400 });
    }
    if (weekIndex === undefined) {
      return NextResponse.json({ error: 'weekIndex query param required (0+, or all)' }, { status: 400 });
    }
    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }

    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    const [
      run,
      periods,
      bomCandidates,
      componentSummary,
      inventorySources,
      inventoryLots,
      purchaseOrders,
      supplyWorkOrders,
    ] = await Promise.all([
      client.mrpRun.findUnique({
        where: { id: runId },
        select: { versionCode: true, runDate: true },
      }),
      client.componentWeeklyPeriod.findMany({
        where: { mrpRunId: runId, mrpType, materialPartNo },
        orderBy: { weekIndex: 'asc' },
      }),
      client.stagingWorkOrderBom.findMany({
        where: {
          mrpRunId: runId,
          ...componentWeeklyUsageWhere(mrpType),
          componentNo: materialPartNo,
        },
        select: {
          ragicRecordId: true,
          componentNo: true,
          woNumber: true,
          sourceType: true,
          processCode: true,
          unit: true,
          minUsage: true,
          alreadyPicked: true,
          issuedQty: true,
          grossIssuedQty: true,
          consumedQty: true,
          returnedQty: true,
          netIssuedQty: true,
          reservedQty: true,
          remainingUsage: true,
          overIssuedQty: true,
          issuedQtyState: true,
          issuedDetailCount: true,
          issuedQtyError: true,
          movementState: true,
          movementDetailCount: true,
          movementError: true,
          startDate: true,
        },
      }),
      client.componentWeekly.findFirst({
        where: { mrpRunId: runId, mrpType, materialPartNo },
        select: {
          unit: true,
          goodStockPc: true,
          goodStockKg: true,
          badStockPc: true,
          badStockKg: true,
          avgWeeklyUsage: true,
          stockWeeks: true,
          purchaseLeadWeeks: true,
          purchaseLeadWeeksConfigured: true,
          shortageStartWeek: true,
          shortageStartDate: true,
          shortageQty: true,
          weeksUntilOrder: true,
          orderByDate: true,
          purchaseAction: true,
          overduePurchaseQty: true,
          overduePurchaseCount: true,
          futurePurchaseQty: true,
          futurePurchaseCount: true,
          nextPurchaseReceiptDate: true,
        },
      }),
      client.stagingInventory.findMany({
        where: { mrpRunId: runId, erpPartNo: materialPartNo },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          ragicRecordId: true,
          erpPartNo: true,
          subtypeCode: true,
          purchaseLeadWeeks: true,
          purchaseLeadWeeksConfigured: true,
        },
      }),
      client.stagingInventoryLot.findMany({
        where: { mrpRunId: runId, erpPartNo: materialPartNo },
        orderBy: [{ warehouseCode: 'asc' }, { lotNo: 'asc' }],
        select: {
          ragicRecordId: true,
          lotNo: true,
          warehouseCode: true,
          qualityStatus: true,
          stockStatus: true,
          stockPc: true,
          stockKg: true,
          sourceWorkOrderNo: true,
        },
      }),
      mrpType === 'D'
        ? Promise.resolve([])
        : client.stagingPurchaseOrder.findMany({
            where: { mrpRunId: runId, productNo: materialPartNo },
            orderBy: [{ deliveryDate: 'asc' }, { ragicRecordId: 'asc' }],
            select: {
              ragicRecordId: true,
              productNo: true,
              deliveryDate: true,
              unreceivedQty: true,
              category: true,
              status: true,
            },
          }),
      mrpType === 'D'
        ? client.stagingWorkOrder.findMany({
            where: { mrpRunId: runId, erpPartNo: materialPartNo },
            orderBy: [{ endDate: 'asc' }, { ragicRecordId: 'asc' }],
            select: {
              ragicRecordId: true,
              woNumber: true,
              erpPartNo: true,
              endDate: true,
              woQty: true,
              status: true,
            },
          })
        : Promise.resolve([]),
    ]);

    if (!run) return NextResponse.json({ error: 'MRP run not found' }, { status: 404 });
    const selectedPeriod = weekIndex === null
      ? null
      : periods.find((period) => period.weekIndex === weekIndex);
    if (weekIndex !== null && !selectedPeriod) {
      return NextResponse.json({ error: 'component weekly period not found' }, { status: 404 });
    }

    const weeks: MrpWeek[] = periods
      .filter((period) => period.weekIndex > 0 && period.weekStart)
      .map((period) => ({
        index: period.weekIndex - 1,
        label: period.weekLabel || `W${String(period.weekIndex).padStart(2, '0')}`,
        start: period.weekStart!,
        end: new Date(period.weekStart!.getTime() + 7 * 24 * 60 * 60 * 1000 - 1),
      }));
    const resolvedShortageStartDate = componentSummary?.shortageStartDate
      ?? (
        componentSummary?.shortageStartWeek && componentSummary.shortageStartWeek > 0
          ? periods.find((period) =>
              period.weekIndex === componentSummary.shortageStartWeek)?.weekStart ?? null
          : null
      );
    const {
      sourceByMaterialPartNo,
      sourceCountByMaterialPartNo,
    } = resolveComponentWeeklyInventorySources(
      inventorySources,
      mrpType,
    );
    const inventorySource = sourceByMaterialPartNo.get(materialPartNo) ?? null;
    const inventorySourceCandidateCount = sourceCountByMaterialPartNo.get(materialPartNo) ?? 0;
    const inventorySourceAmbiguous = inventorySourceCandidateCount > 1;
    const purchaseOrderDetails = purchaseOrders.map((row) => ({
      ...row,
      isOverdue: isComponentWeeklyPurchaseOverdue(row.deliveryDate, run.runDate),
      arrivesAfterShortage: !!row.deliveryDate && (
        componentSummary?.shortageStartWeek === 0
        || (
          !!resolvedShortageStartDate
          && row.deliveryDate > resolvedShortageStartDate
        )
      ),
    }));
    const positiveDatedPurchaseOrders = purchaseOrderDetails.filter((row) =>
      !!row.deliveryDate && (Number(row.unreceivedQty) || 0) > 0);
    const overduePurchaseOrders = positiveDatedPurchaseOrders.filter((row) => row.isOverdue);
    const futurePurchaseOrders = positiveDatedPurchaseOrders.filter((row) => !row.isOverdue);
    const purchaseOrdersRequiringExpedite = positiveDatedPurchaseOrders.filter((row) =>
      row.isOverdue || row.arrivesAfterShortage);
    const hasPersistedPurchaseDecision = mrpType === 'D'
      || (componentSummary?.purchaseAction ?? null) !== null;
    const scopedPurchaseOrders = purchaseOrderDetails.filter((row) =>
      isComponentWeeklyDateInScope(row.deliveryDate, weeks, weekIndex));
    const countableScopedPurchaseOrders = scopedPurchaseOrders.filter((row) =>
      !hasPersistedPurchaseDecision || !row.isOverdue);
    const scopedSupplyWorkOrders = supplyWorkOrders.filter((row) =>
      isComponentWeeklyDateInScope(row.endDate, weeks, weekIndex));

    const bomWorkOrderNumbers = bomCandidates
      .map((row) => row.woNumber?.trim())
      .filter((value): value is string => !!value);
    const inventorySourceWorkOrderNumbers = inventoryLots
      .map((row) => row.sourceWorkOrderNo?.trim())
      .filter((value): value is string => !!value);
    const woNumbers = [...new Set([...bomWorkOrderNumbers, ...inventorySourceWorkOrderNumbers])];
    const workOrders = woNumbers.length > 0
      ? await client.stagingWorkOrder.findMany({
          where: { mrpRunId: runId, woNumber: { in: woNumbers } },
          select: {
            ragicRecordId: true,
            woNumber: true,
            erpPartNo: true,
            status: true,
            startDate: true,
          },
        })
      : [];

    const summaryInput = {
      materialPartNo,
      weeks,
      bomRows: bomCandidates,
      workOrders,
    };
    const summary = summarizeComponentWeeklyUsage({
      ...summaryInput,
      weekIndex,
      expectedUnit: componentSummary?.unit ?? null,
      enforceUnitConsistency: mrpType === 'W',
      expectedUsage: selectedPeriod
        ? Number(selectedPeriod.usage) || 0
        : periods.reduce((sum, period) => sum + (Number(period.usage) || 0), 0),
    });
    const materialUnit = componentSummary?.unit?.trim().toLowerCase() || null;
    const selectedWorkOrderNumbers = [...new Set(
      [...summary.included, ...summary.excluded]
        .map((row) => row.woNumber)
        .filter((value): value is string => !!value),
    )];
    const movementContextRows = await client.stagingWorkOrderMaterialMovement.findMany({
      where: {
        mrpRunId: runId,
        componentNo: materialPartNo,
      },
      orderBy: [{ movementDate: 'asc' }, { ragicRecordId: 'asc' }],
    });
    const selectedWorkOrderNumberSet = new Set(selectedWorkOrderNumbers);
    const serializeMovement = (row: (typeof movementContextRows)[number]) => ({
      ...row,
      inputQtyPc: row.inputQtyPc === null ? null : Number(row.inputQtyPc),
      inputQtyKg: row.inputQtyKg === null ? null : Number(row.inputQtyKg),
      movementQtyPc: row.movementQtyPc === null ? null : Number(row.movementQtyPc),
      movementQtyKg: row.movementQtyKg === null ? null : Number(row.movementQtyKg),
    });
    const movementContext = movementContextRows.map(serializeMovement);
    const movementRows = movementContext.filter((row) =>
      selectedWorkOrderNumberSet.has(row.workOrderNo));

    const initialStock = resolveComponentWeeklyInitialStock(mrpType, materialUnit, {
      stockPc: Number(componentSummary?.goodStockPc) || 0,
      stockKg: Number(componentSummary?.goodStockKg) || 0,
    });
    let priorEnding = initialStock;
    const weeklyProjection = periods.map((period) => {
      const openingStock = priorEnding;
      const receipts = Number(period.receipts) || 0;
      const usage = Number(period.usage) || 0;
      const calculatedEnding = openingStock + receipts - usage;
      const endingStock = period.remainingStock === null
        ? calculatedEnding
        : Number(period.remainingStock);
      priorEnding = endingStock;
      return {
        weekIndex: period.weekIndex,
        weekLabel: period.weekLabel,
        weekStart: period.weekStart,
        openingStock,
        receipts,
        usage,
        calculatedEndingStock: calculatedEnding,
        endingStock,
        difference: endingStock - calculatedEnding,
      };
    });

    const summaryRows = [...summary.included, ...summary.excluded];
    const canonicalSummaryRows = summaryRows.filter((row) =>
      row.reason !== 'unit_mismatch' && row.reason !== 'unlinked_work_order');
    const unscheduledDemandRows = summary.included.filter((row) => row.dateSource === 'missing');
    const workOrderRecordIds = new Map(
      workOrders.flatMap((row) => {
        const workOrderNo = row.woNumber?.trim();
        return workOrderNo && row.ragicRecordId
          ? [[workOrderNo, row.ragicRecordId] as const]
          : [];
      }),
    );
    const sum = (selector: (row: (typeof summaryRows)[number]) => number | null) =>
      canonicalSummaryRows.reduce((total, row) => total + (selector(row) ?? 0), 0);
    const sumComplete = (selector: (row: (typeof summaryRows)[number]) => number | null) => {
      const values = canonicalSummaryRows.map(selector);
      return values.some((value) => value === null)
        ? null
        : values.reduce<number>((total, value) => total + (value ?? 0), 0);
    };
    const supplyQty = mrpType === 'D'
      ? scopedSupplyWorkOrders.reduce((total, row) => total + (Number(row.woQty) || 0), 0)
      : countableScopedPurchaseOrders.reduce((total, row) => total + (Number(row.unreceivedQty) || 0), 0);

    return NextResponse.json({
      materialPartNo,
      mrpType,
      runId,
      dbSource,
      runVersionCode: run.versionCode,
      runDate: run.runDate,
      usesLegacyPurchaseProjection: mrpType !== 'D' && !hasPersistedPurchaseDecision,
      weekIndex,
      weekLabel: selectedPeriod?.weekLabel ?? null,
      weekStart: selectedPeriod?.weekStart ?? null,
      inventorySource: inventorySource
        ? {
            ragicRecordId: inventorySourceAmbiguous ? null : inventorySource.ragicRecordId,
            erpPartNo: inventorySource.erpPartNo,
            purchaseLeadWeeks: Number(inventorySource.purchaseLeadWeeks) || 0,
            purchaseLeadWeeksConfigured: inventorySource.purchaseLeadWeeksConfigured,
            ambiguous: inventorySourceAmbiguous,
            candidateCount: inventorySourceCandidateCount,
          }
        : null,
      materialSummary: {
        unit: componentSummary?.unit ?? null,
        initialStock,
        badStock: materialUnit === 'kg'
          ? Number(componentSummary?.badStockKg) || 0
          : Number(componentSummary?.badStockPc) || 0,
        supplyQty,
        plannedUsage: sum((row) => row.plannedUsage),
        grossIssuedQty: sumComplete((row) => row.grossIssuedQty),
        consumedQty: sumComplete((row) => row.consumedQty),
        returnedQty: sumComplete((row) => row.returnedQty),
        netIssuedQty: sumComplete((row) => row.netIssuedQty),
        reservedQty: sumComplete((row) => row.reservedQty),
        remainingUsage: sumComplete((row) => row.remainingUsage),
        overIssuedQty: sum((row) => row.overIssuedQty),
        avgWeeklyUsage: Number(componentSummary?.avgWeeklyUsage) || 0,
        stockWeeks: Number(componentSummary?.stockWeeks) || 0,
        purchaseLeadWeeks: Number(componentSummary?.purchaseLeadWeeks) || 0,
        purchaseLeadWeeksConfigured: componentSummary?.purchaseLeadWeeksConfigured ?? null,
        shortageStartWeek: componentSummary?.shortageStartWeek ?? null,
        shortageStartDate: resolvedShortageStartDate,
        shortageQty: Number(componentSummary?.shortageQty) || 0,
        weeksUntilOrder: componentSummary?.weeksUntilOrder ?? null,
        orderByDate: componentSummary?.orderByDate ?? null,
        purchaseAction: componentSummary?.purchaseAction ?? null,
        overduePurchaseQty: hasPersistedPurchaseDecision
          ? Number(componentSummary?.overduePurchaseQty) || 0
          : overduePurchaseOrders.reduce((total, row) => total + (Number(row.unreceivedQty) || 0), 0),
        overduePurchaseCount: hasPersistedPurchaseDecision
          ? componentSummary?.overduePurchaseCount ?? 0
          : overduePurchaseOrders.length,
        futurePurchaseQty: hasPersistedPurchaseDecision
          ? Number(componentSummary?.futurePurchaseQty) || 0
          : futurePurchaseOrders.reduce((total, row) => total + (Number(row.unreceivedQty) || 0), 0),
        futurePurchaseCount: hasPersistedPurchaseDecision
          ? componentSummary?.futurePurchaseCount ?? 0
          : futurePurchaseOrders.length,
        nextPurchaseReceiptDate: hasPersistedPurchaseDecision
          ? componentSummary?.nextPurchaseReceiptDate ?? null
          : futurePurchaseOrders[0]?.deliveryDate ?? null,
        expeditePurchaseQty: purchaseOrdersRequiringExpedite.reduce(
          (total, row) => total + (Number(row.unreceivedQty) || 0),
          0,
        ),
        expeditePurchaseCount: purchaseOrdersRequiringExpedite.length,
        movementState: resolveComponentWeeklyMovementSummaryState(
          summaryRows.map((row) => row.movementState),
        ),
      },
      weeklyProjection,
      inventoryLots: inventoryLots.map((row) => ({
        ...row,
        sourceWorkOrderRagicRecordId: row.sourceWorkOrderNo
          ? workOrderRecordIds.get(row.sourceWorkOrderNo.trim()) ?? null
          : null,
        stockPc: Number(row.stockPc) || 0,
        stockKg: Number(row.stockKg) || 0,
      })),
      purchaseOrders: purchaseOrderDetails.map((row) => ({
        ...row,
        unreceivedQty: Number(row.unreceivedQty) || 0,
        countsAsProjectedSupply: !!row.deliveryDate
          && (!hasPersistedPurchaseDecision || !row.isOverdue)
          && (Number(row.unreceivedQty) || 0) > 0,
        requiresExpedite: (row.isOverdue || row.arrivesAfterShortage)
          && (Number(row.unreceivedQty) || 0) > 0,
        inSelectedScope: isComponentWeeklyDateInScope(row.deliveryDate, weeks, weekIndex),
      })),
      supplyWorkOrders: scopedSupplyWorkOrders.map((row) => ({
        ...row,
        woQty: Number(row.woQty) || 0,
      })),
      movements: movementRows,
      movementContext,
      unscheduledDemand: {
        count: unscheduledDemandRows.length,
        qty: unscheduledDemandRows.reduce(
          (total, row) => total + (row.remainingUsage ?? 0),
          0,
        ),
      },
      ...summary,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
