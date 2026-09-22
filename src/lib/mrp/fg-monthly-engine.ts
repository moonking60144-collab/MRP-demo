/**
 * FG Monthly Projection Engine
 * Core MRP calculation: for each part version, project monthly stock vs demand
 * and suggest production plans when shortages are detected
 *
 * Optimized for remote DB: all staging data pre-loaded into memory,
 * output rows collected in arrays and batch-inserted with createMany.
 */
import prisma from '../db';
import { config } from '../config';
import { getApplySkipFgInventory } from '../app-settings';
import {
  generateMonthlyPeriods,
  dateToPeriodIndex,
  completionDateForPeriod,
  type MrpPeriod,
} from './period-utils';
import {
  allocateSharedErpPool,
  suggestSharedErpPoolSupply,
  type SharedPoolMember,
} from './shared-erp-pool';
import { computeFulfillmentPlanQty } from './fg-plan-suggestion';
import {
  buildSharedErpPoolUsageSet,
  resolveSharedErpPlanDisplayMember,
  selectSharedErpDisplayOwner,
} from './shared-erp-display';
import {
  attributeFgMonthlyOrderDemand,
  fgMonthlyDemandCalculation,
  fgMonthlyOrderPeriodIndex,
} from './fg-monthly-source-detail';
import { createCalculationProgressThrottle } from './calculation-progress';
import { settleAllOrThrow } from './run-attempt-control';
import { resolveInventoryAvailability } from '../sync/inventory-snapshot';
import { aggregateFirstProcessValue } from '../sync/first-process-source';
import {
  getRunInventoryRows,
  type RunCalculationInputs,
} from './run-calculation-inputs';
import {
  ORDER_DEMAND_CONTRACT_V1,
  resolveOrderDemandContribution,
} from './order-demand-contract';

interface PartData {
  partVersion: string;
  customerPartNo: string | null;
  customerCode: string | null;
  erpPartNo: string | null;
  forgingMachine: string | null;
  firstProcess: string | null;
  firstProcessErpPartNo?: string | null;
  firstProcessSourceType?: string | null;
  surfaceTreatment: string | null;
  forgingParent: string | null;
  processBomVersion: string | null;
  productStatus: string | null;
  stockPeriods: number;
  sortGroup: number | null;
  unitWeightG: number;
  mainMaterialKg: number;
  skipFgInventory: boolean;
}

interface PeriodData {
  ordersUnshipped: number;
  ordersTotal: number;
  forecastQty: number;
  plannedOutput: number;
  hasForecast: boolean;
  demandPriorityAt: Date | null;
  orderPriorityAt: Date | null;
  forecastPriorityAt: Date | null;
}

const BATCH_SIZE = 500; // createMany batch size

interface PartProjectionInputs {
  partData: PartData;
  rawStock: number;
  badStock: number;
  orders: Array<{
    designatedShipDate: Date | null;
    orderQty: unknown;
    preparedQty?: unknown;
    unprepQty?: unknown;
    shippedQty?: unknown;
    unshippedQty: unknown;
    soldQty?: unknown;
    unsoldQty?: unknown;
    salesStatus: string | null;
    shipmentStatus?: string | null;
    prepStatus: string | null;
  }>;
  forecasts: Array<{ forecastStart: Date | null; forecastQty: unknown }>;
  workOrders: Array<{ subProcessCode: string | null; jobOrderCode: string | null; woQty: unknown }>;
  plans: Array<{ completionDate: Date | null; planQty: unknown; reportedQty: unknown; closedQty: unknown }>;
  periods: MrpPeriod[];
  numPeriods: number;
  baseDate: Date;
  /** true 時把「不計算成品庫存」料件的成品庫存當 0;false 照算真實庫存（仿 Source）。 */
  applySkipFgInventory: boolean;
  orderDemandContractVersion?: string;
}

interface PartProjectionResult {
  woScheduled: number;
  woUnscheduled: number;
  planReportedQty: number;
  planClosedQty: number;
  priorUnshipped: number;
  priorDemandPriorityAt: Date | null;
  priorPlanOutput: number;
  period1PlanQty: number;
  totalUnshipped: number;
  totalPlanSupply: number;
  shortageStartPeriod: number | null;
  shortageStartPeriodNoPlan: number | null;
  missingForecastPeriods: number;
  shouldPlan: boolean;
  periodData: PeriodData[];
  periodResults: Array<{ remainingStock: number; remainingNoPlan: number; demandIntegrated: number }>;
  suggestions: ReturnType<typeof generatePlanSuggestions>;
}

interface FgMonthlyAggregationSummary {
  partVersion: string;
  firstProcess?: string | null;
  firstProcessErpPartNo?: string | null;
  firstProcessSourceType?: string | null;
  woScheduled: unknown;
  woUnscheduled: unknown;
  woTotal: unknown;
  planReportedQty: unknown;
  planClosedQty: unknown;
  priorPlanQty: unknown;
  period1PlanQty: unknown;
  priorUnshippedQty: unknown;
  totalUnshippedQty: unknown;
  totalPlanSupply: unknown;
}

interface FgMonthlyAggregationPeriod {
  partVersion: string;
  periodIndex: number;
  remainingStock: unknown;
  remainingNoPlan: unknown;
  demandIntegrated: unknown;
  ordersUnshipped: unknown;
  ordersTotal: unknown;
  forecastQty: unknown;
  plannedOutput: unknown;
}

interface FgMonthlyAggregationSource {
  summaries: readonly FgMonthlyAggregationSummary[];
  periods: readonly FgMonthlyAggregationPeriod[];
}

/**
 * Compute the FG monthly projection for one logical part (per-version OR aggregated group).
 * Mirrors Source d4/21 calculateMrpMonthlyProjection2, with invalid negative shipped quantity clamped.
 * Caller owns the I/O.
 */
export function computePartProjection(opts: PartProjectionInputs): PartProjectionResult {
  const { partData, rawStock, orders, forecasts, workOrders, plans, periods, numPeriods, baseDate, applySkipFgInventory } = opts;
  const orderDemandContractVersion = opts.orderDemandContractVersion ?? ORDER_DEMAND_CONTRACT_V1;
  // 只有執行 MRP 時勾了開關,「不計算成品庫存」的料件才把庫存歸零;否則照算真實庫存。
  const calcStock = (applySkipFgInventory && partData.skipFgInventory) ? 0 : rawStock;

  // WO HF01 split — Source d4/21:2197-2205
  let totalHf01 = 0;
  let unscheduledHf01 = 0;
  for (const wo of workOrders) {
    if (wo.subProcessCode !== 'HF01') continue;
    const qty = Number(wo.woQty) || 0;
    totalHf01 += qty;
    const jc = wo.jobOrderCode;
    if (jc === '99' || jc === '' || jc === null) unscheduledHf01 += qty;
  }
  const woUnscheduled = unscheduledHf01;
  const woScheduled = totalHf01 - unscheduledHf01;

  let planReportedQty = 0;
  let planClosedQty = 0;
  for (const p of plans) {
    planReportedQty += Number(p.reportedQty) || 0;
    planClosedQty += Number(p.closedQty) || 0;
  }

  const periodData: PeriodData[] = periods.map(() => ({
    ordersUnshipped: 0,
    ordersTotal: 0,
    forecastQty: 0,
    plannedOutput: 0,
    hasForecast: false,
    demandPriorityAt: null,
    orderPriorityAt: null,
    forecastPriorityAt: null,
  }));

  let priorUnshipped = 0;
  let priorDemandPriorityAt: Date | null = null;
  let priorPlanOutput = 0;

  for (const order of orders) {
    const contribution = resolveOrderDemandContribution(order, orderDemandContractVersion);
    // 月份分桶用「營業指定出貨日」— 對齊 Source d4/21（非客戶訂單需求日）
    const pIdx = fgMonthlyOrderPeriodIndex(order, periods);
    const attribution = attributeFgMonthlyOrderDemand(contribution, pIdx, numPeriods);
    if (attribution.status === 'included_prior') {
      if (attribution.outstandingOrderQty > 0) {
        priorUnshipped += attribution.outstandingOrderQty;
        priorDemandPriorityAt = earlierDate(priorDemandPriorityAt, order.designatedShipDate);
      }
    } else if (attribution.status === 'included_period' && pIdx !== null) {
      periodData[pIdx].ordersTotal += attribution.recognizedOrderQty;
      periodData[pIdx].ordersUnshipped += attribution.outstandingOrderQty;
      if (attribution.recognizedOrderQty > 0 || attribution.outstandingOrderQty > 0) {
        periodData[pIdx].orderPriorityAt = earlierDate(
          periodData[pIdx].orderPriorityAt,
          order.designatedShipDate,
        );
      }
    }
  }

  for (const fc of forecasts) {
    if (!fc.forecastStart) continue;
    const pIdx = dateToPeriodIndex(fc.forecastStart, periods);
    if (pIdx < 0 || pIdx >= numPeriods) continue;
    periodData[pIdx].hasForecast = true;
    periodData[pIdx].forecastPriorityAt = earlierDate(
      periodData[pIdx].forecastPriorityAt,
      fc.forecastStart,
    );
    const qty = Number(fc.forecastQty) || 0;
    if (qty > 0) periodData[pIdx].forecastQty += qty;
  }

  for (const p of plans) {
    const qty = Number(p.planQty) || 0;
    if (!p.completionDate || qty <= 0) continue;
    const pIdx = dateToPeriodIndex(p.completionDate, periods);
    if (pIdx < 0) {
      priorPlanOutput += qty;
    } else if (pIdx < numPeriods) {
      periodData[pIdx].plannedOutput += qty;
    }
  }

  // 對齊 Source：前期計畫產出(priorPlanOutput)是 Source 的「第0期」，不併進第1期。
  // 改在 runningStock 起始補回 priorPlanOutput — 剩餘庫存數字完全不變，
  // 「計畫前期產出第1期」回到只放第1期當期計畫。priorPlanOutput 仍存於 priorPlanQty 欄。
  const period1PlanQty = periodData[0]?.plannedOutput ?? 0;

  // Running stock — Source d4/21:2457-2469
  let runningStock = calcStock - priorUnshipped + priorPlanOutput;
  let runningStockNoPlan = calcStock - priorUnshipped;
  const periodResults: PartProjectionResult['periodResults'] = [];
  for (let i = 0; i < numPeriods; i++) {
    const pd = periodData[i];
    const { demandIntegrated: demand } = fgMonthlyDemandCalculation(pd);
    pd.demandPriorityAt = pd.forecastQty > pd.ordersTotal
      ? pd.forecastPriorityAt
      : pd.ordersTotal > pd.forecastQty
        ? pd.orderPriorityAt
        : earlierDate(pd.orderPriorityAt, pd.forecastPriorityAt);
    runningStock = runningStock + pd.plannedOutput - demand;
    runningStockNoPlan = runningStockNoPlan - demand;
    periodResults.push({ remainingStock: runningStock, remainingNoPlan: runningStockNoPlan, demandIntegrated: demand });
  }

  // 缺預示期數 — Source d4/21:2484-2491 (loop `i <= stockingPeriods` with floating)
  let missingForecastPeriods = 0;
  const stockingPeriods = Math.floor(partData.stockPeriods || 0);
  for (let i = 0; i < Math.min(stockingPeriods, numPeriods); i++) {
    if (!periodData[i].hasForecast) missingForecastPeriods++;
  }

  let shortageStartPeriod: number | null = null;
  for (let i = 0; i < numPeriods; i++) {
    if (periodResults[i].remainingStock < 0) {
      shortageStartPeriod = i;
      break;
    }
  }

  // 無計劃量缺料期：不算計劃產出、純現有庫存撐到第幾期就缺（remainingNoPlan
  // 第一次 < 0）。對比 shortageStartPeriod（含計劃量）讓使用者看「不靠新排產
  // 的話實際缺料壓力」。
  let shortageStartPeriodNoPlan: number | null = null;
  for (let i = 0; i < numPeriods; i++) {
    if (periodResults[i].remainingNoPlan < 0) {
      shortageStartPeriodNoPlan = i;
      break;
    }
  }

  const shouldPlan =
    shortageStartPeriod !== null && stockingPeriods > 0 && shortageStartPeriod < stockingPeriods;

  const suggestions = shouldPlan
    ? generatePlanSuggestions(
        partData,
        periodData,
        periodResults,
        periods,
        calcStock - priorUnshipped + priorPlanOutput,
        baseDate,
      )
    : [];

  const totalUnshipped = priorUnshipped + periodData.reduce((s, p) => s + p.ordersUnshipped, 0);
  const totalPlanSupply = periodData.reduce((s, p) => s + p.plannedOutput, 0);

  return {
    woScheduled, woUnscheduled, planReportedQty, planClosedQty,
    priorUnshipped, priorDemandPriorityAt, priorPlanOutput, period1PlanQty,
    totalUnshipped, totalPlanSupply,
    shortageStartPeriod, shortageStartPeriodNoPlan, missingForecastPeriods, shouldPlan,
    periodData, periodResults, suggestions,
  };
}

/**
 * Run the FG monthly projection for a given MRP run
 */
export async function calculateFgMonthly(
  runId: number,
  inputs?: RunCalculationInputs,
): Promise<{ partCount: number; aggregationSource: FgMonthlyAggregationSource }> {
  const numPeriods = config.mrp.projectionMonths;
  const applySkipFg = await getApplySkipFgInventory();

  // Use the run's runDate (matches Source d4/21: monthlyPeriods built from triggerEntry runDate)
  const run = inputs
    ? null
    : await prisma.mrpRun.findUnique({
        where: { id: runId },
        select: { runDate: true, orderDemandContractVersion: true },
      });
  const baseDate = inputs?.runDate ? new Date(inputs.runDate) : run?.runDate ? new Date(run.runDate) : new Date();
  const orderDemandContractVersion = inputs?.orderDemandContractVersion
    ?? run?.orderDemandContractVersion
    ?? ORDER_DEMAND_CONTRACT_V1;
  const periods = generateMonthlyPeriods(baseDate, numPeriods);

  // Resume / 重跑前先清掉同 runId 的舊 row。原本依賴 createMany skipDuplicates
  // 等於「舊資料留著、新值無法覆蓋」，resume 後 UI 顯示停留在舊算結果。
  // 先刪 children (periods/suggestions) 再刪 parent (fg_monthly)。
  await prisma.fgPlanSuggestion.deleteMany({ where: { mrpRunId: runId } });
  await prisma.fgMonthlyPeriod.deleteMany({ where: { mrpRunId: runId, isAggregated: false } });
  await prisma.fgMonthly.deleteMany({ where: { mrpRunId: runId, isAggregated: false } });

  // ── 1. Bulk-load ALL staging data into memory maps (sequential to avoid pool exhaustion) ──
  const parts = inputs?.partVersionRows
    ?? await prisma.stagingPartVersion.findMany({ where: { mrpRunId: runId } });
  const allInventory = await getRunInventoryRows(runId, inputs);
  const allOrders = inputs?.orderRows
    ?? await prisma.stagingOrder.findMany({ where: { mrpRunId: runId } });
  const allForecasts = inputs?.forecastRows
    ?? await prisma.stagingForecast.findMany({ where: { mrpRunId: runId } });
  const allWorkOrders = inputs?.workOrderRows
    ?? await prisma.stagingWorkOrder.findMany({ where: { mrpRunId: runId } });
  const allPlans = inputs?.productionPlanRows
    ?? await prisma.stagingProductionPlan.findMany({ where: { mrpRunId: runId } });

  // Build lookup maps
  const inventoryByErp = new Map<string, typeof allInventory[0]>();
  for (const inv of allInventory) {
    if (inv.erpPartNo) inventoryByErp.set(inv.erpPartNo, inv);
  }

  const ordersByPartVersion = groupBy(allOrders, (o) => o.partVersion || '');
  const forecastsByPartVersion = groupBy(allForecasts, (f) => f.partVersion || '');
  const workOrdersByPartVersion = groupBy(allWorkOrders, (w) => w.partVersion || '');
  const plansByPartVersion = groupBy(allPlans, (p) => p.partVersion || '');
  const erpByPartVersion = new Map(parts.map((part) => [part.partVersion, part.erpPartNo]));
  const plansByErp = groupBy(allPlans, (plan) =>
    plan.erpPartNo || (plan.partVersion ? erpByPartVersion.get(plan.partVersion) || '' : ''));

  const preparedParts: Array<{
    partData: PartData;
    rawStock: number;
    mainStock: number;
    auxStock: number;
    badStock: number;
    result: PartProjectionResult;
  }> = [];

  for (const part of parts) {
    if (!part.partVersion || !part.erpPartNo) continue;

    const inv = inventoryByErp.get(part.erpPartNo);
    const partData: PartData = {
      partVersion: part.partVersion,
      customerPartNo: part.customerPartNo,
      customerCode: part.customerCode,
      erpPartNo: part.erpPartNo,
      forgingMachine: part.forgingMachine,
      firstProcess: inv?.firstProcess ?? part.firstProcess,
      firstProcessErpPartNo: inv?.firstProcessErpPartNo ?? null,
      firstProcessSourceType: inv?.firstProcessSourceType ?? null,
      surfaceTreatment: part.surfaceTreatment,
      forgingParent: part.forgingParent,
      processBomVersion: part.processBomVersion,
      productStatus: part.productStatus,
      stockPeriods: part.targetStockPeriods != null ? Number(part.targetStockPeriods) : 2,
      sortGroup: part.sortGroup,
      unitWeightG: Number(part.unitWeightG) || 0,
      mainMaterialKg: Number(part.mainMaterialKg) || 0,
      skipFgInventory: part.skipFgInventory,
    };
    const stock = resolveInventoryAvailability({
      goodStockPc: inv?.goodStockPc,
      goodStockKg: inv?.goodStockKg,
      inStockPc: inv?.inStockPc,
      inStockKg: inv?.inStockKg,
      mainStockPc: inv?.mainStockPc,
      mainStockKg: inv?.mainStockKg,
      auxStockPc: inv?.auxStockPc,
      auxStockKg: inv?.auxStockKg,
    });
    const rawStock = stock.inStockPc;
    const mainStock = stock.mainStockPc;
    const auxStock = stock.auxStockPc;
    const badStock = Number(inv?.badStockPc) || 0;
    const result = computePartProjection({
      partData,
      rawStock,
      badStock,
      orders: ordersByPartVersion.get(part.partVersion) || [],
      forecasts: forecastsByPartVersion.get(part.partVersion) || [],
      workOrders: workOrdersByPartVersion.get(part.partVersion) || [],
      plans: plansByPartVersion.get(part.partVersion) || [],
      periods,
      numPeriods,
      baseDate,
      applySkipFgInventory: applySkipFg,
      orderDemandContractVersion,
    });
    preparedParts.push({ partData, rawStock, mainStock, auxStock, badStock, result });
  }

  const sharedPoolErps = buildSharedErpPoolUsageSet(
    preparedParts.map((part) => ({
      partVersion: part.partData.partVersion,
      erpPartNo: part.partData.erpPartNo,
    })),
    allPlans,
  );
  const partsByErp = groupBy(preparedParts, (part) => part.partData.erpPartNo || '');
  for (const [erpPartNo, group] of partsByErp) {
    const memberKeys = new Set(group.map((part) => part.partData.partVersion));
    const sharedPlans = plansByErp.get(group[0].partData.erpPartNo!) || [];
    if (!sharedPoolErps.has(erpPartNo)) continue;

    const displayMember = selectSharedErpDisplayOwner(
      group.map((part) => part.partData),
    );
    const displayOwner = group.find(
      (part) => part.partData.partVersion === displayMember?.partVersion,
    );
    if (!displayOwner) continue;
    const initialStock = applySkipFg && group.every((part) => part.partData.skipFgInventory)
      ? 0
      : group[0].rawStock;
    let priorSupply = 0;
    const periodSupply = periods.map(() => 0);
    for (const plan of sharedPlans) {
      const attributedMember = resolveSharedErpPlanDisplayMember(
        plan,
        group.map((part) => part.partData),
        true,
      );
      const isSharedFallback = attributedMember?.partVersion === displayOwner.partData.partVersion
        && !memberKeys.has(plan.partVersion?.trim() || '');
      if (isSharedFallback) {
        displayOwner.result.planReportedQty += Number(plan.reportedQty) || 0;
        displayOwner.result.planClosedQty += Number(plan.closedQty) || 0;
      }
      const quantity = Number(plan.planQty) || 0;
      if (!plan.completionDate || quantity <= 0) continue;
      const periodIndex = dateToPeriodIndex(plan.completionDate, periods);
      if (periodIndex < 0) {
        priorSupply += quantity;
        if (isSharedFallback) {
          displayOwner.result.priorPlanOutput += quantity;
        }
      } else if (periodIndex < numPeriods) {
        periodSupply[periodIndex] += quantity;
        if (isSharedFallback) {
          displayOwner.result.periodData[periodIndex].plannedOutput += quantity;
          displayOwner.result.totalPlanSupply += quantity;
          if (periodIndex === 0) displayOwner.result.period1PlanQty += quantity;
        }
      }
    }
    const members: Array<SharedPoolMember & { targetPeriods: number }> = group.map((part) => ({
      key: part.partData.partVersion,
      customerCode: part.partData.customerCode,
      partVersion: part.partData.partVersion,
      priorDemand: {
        quantity: part.result.priorUnshipped,
        priorityAt: part.result.priorDemandPriorityAt,
      },
      periodDemands: part.result.periodResults.map((period, index) => ({
        quantity: period.demandIntegrated,
        priorityAt: part.result.periodData[index].demandPriorityAt,
      })),
      targetPeriods: Math.max(0, Math.floor(part.partData.stockPeriods || 0)),
    }));
    const allocation = allocateSharedErpPool({ initialStock, priorSupply, periodSupply, members });
    const sharedSuggestions = suggestSharedErpPoolSupply({
      initialStock,
      priorSupply,
      periodSupply,
      members,
      bufferPct: config.mrp.defaultBufferPct,
    });
    const suggestionsByMember = groupBy(sharedSuggestions, (suggestion) => suggestion.memberKey);

    for (const part of group) {
      const memberResult = allocation.members.get(part.partData.partVersion)!;
      for (let i = 0; i < numPeriods; i++) {
        part.result.periodResults[i].remainingStock = memberResult.remainingStock[i];
        part.result.periodResults[i].remainingNoPlan = memberResult.remainingNoPlan[i];
      }
      part.result.shortageStartPeriod = memberResult.shortageStartPeriod;
      part.result.shortageStartPeriodNoPlan = memberResult.shortageStartPeriodNoPlan;
      part.result.suggestions = (suggestionsByMember.get(part.partData.partVersion) || []).map((suggestion) => {
        const suggestedQty = suggestion.suggestedQty;
        const materialWeightKg = part.partData.mainMaterialKg > 0
          ? suggestedQty * part.partData.mainMaterialKg
          : part.partData.unitWeightG > 0
            ? (suggestedQty * part.partData.unitWeightG) / 1000
            : 0;
        return {
          sequence: suggestion.sequence,
          targetStartPeriod: suggestion.targetStartPeriod,
          fulfillToPeriod: suggestion.fulfillToPeriod,
          suggestedQty,
          completionDate: completionDateForPeriod(
            baseDate,
            Math.max(0, suggestion.targetStartPeriod - 1),
          ),
          materialWeightKg,
          bufferPct: config.mrp.defaultBufferPct,
        };
      });
      part.result.shouldPlan = part.result.suggestions.length > 0;
    }
  }

  const totalParts = preparedParts.length;
  let partCount = 0;
  const PROGRESS_CHECK_INTERVAL = 200;
  const shouldReportProgress = createCalculationProgressThrottle();

  // ── Collect output rows in arrays for batch insert ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryBatch: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periodBatch: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suggestionBatch: any[] = [];
  const aggregationSummaries = new Map<string, FgMonthlyAggregationSummary>();
  const aggregationPeriods = new Map<string, FgMonthlyAggregationPeriod>();

  for (const { partData, rawStock, mainStock, auxStock, badStock, result: r } of preparedParts) {

    const summaryRow = {
      mrpRunId: runId,
      partVersion: partData.partVersion,
      customerPartNo: partData.customerPartNo,
      customerCode: partData.customerCode,
      erpPartNo: partData.erpPartNo,
      forgingMachine: partData.forgingMachine,
      firstProcess: partData.firstProcess,
      firstProcessErpPartNo: partData.firstProcessErpPartNo ?? null,
      firstProcessSourceType: partData.firstProcessSourceType ?? null,
      surfaceTreatment: partData.surfaceTreatment,
      forgingParent: partData.forgingParent,
      processBomVersion: partData.processBomVersion,
      productStatus: partData.productStatus,
      stockPeriods: partData.stockPeriods,
      sortGroup: partData.sortGroup,
      unitWeightG: partData.unitWeightG,
      mainMaterialKg: partData.mainMaterialKg,
      currentStockPc: rawStock,
      mainStockPc: mainStock,
      auxStockPc: auxStock,
      badStockPc: badStock,
      skipFgInventory: partData.skipFgInventory,
      woScheduled: r.woScheduled,
      woUnscheduled: r.woUnscheduled,
      woTotal: r.woScheduled + r.woUnscheduled,
      planReportedQty: r.planReportedQty,
      planClosedQty: r.planClosedQty,
      priorPlanQty: r.priorPlanOutput,
      period1PlanQty: r.priorPlanOutput + r.period1PlanQty,
      shortageStartPeriod: r.shortageStartPeriod,
      shortageStartPeriodNoPlan: r.shortageStartPeriodNoPlan,
      missingForecastPeriods: r.missingForecastPeriods,
      shouldPlanProduction: r.shouldPlan,
      priorUnshippedQty: r.priorUnshipped,
      totalUnshippedQty: r.totalUnshipped,
      totalPlanSupply: r.totalPlanSupply,
    };
    summaryBatch.push(summaryRow);
    if (!aggregationSummaries.has(partData.partVersion)) {
      aggregationSummaries.set(partData.partVersion, summaryRow);
    }

    for (let i = 0; i < numPeriods; i++) {
      const periodRow = {
        mrpRunId: runId,
        partVersion: partData.partVersion,
        periodIndex: i,
        periodLabel: periods[i].label,
        periodStart: periods[i].start,
        periodEnd: periods[i].end,
        remainingStock: r.periodResults[i].remainingStock,
        remainingNoPlan: r.periodResults[i].remainingNoPlan,
        demandIntegrated: r.periodResults[i].demandIntegrated,
        ordersUnshipped: r.periodData[i].ordersUnshipped,
        ordersTotal: r.periodData[i].ordersTotal,
        forecastQty: r.periodData[i].forecastQty,
        plannedOutput: r.periodData[i].plannedOutput,
      };
      periodBatch.push(periodRow);
      const aggregationPeriodKey = `${partData.partVersion}\u0000${i}`;
      if (!aggregationPeriods.has(aggregationPeriodKey)) {
        aggregationPeriods.set(aggregationPeriodKey, periodRow);
      }
    }

    for (const sug of r.suggestions) {
      suggestionBatch.push({
        mrpRunId: runId,
        partVersion: partData.partVersion,
        planSequence: sug.sequence,
        targetStartPeriod: sug.targetStartPeriod,
        fulfillToPeriod: sug.fulfillToPeriod,
        suggestedQty: sug.suggestedQty,
        completionDate: sug.completionDate,
        materialWeightKg: sug.materialWeightKg,
        bufferPct: sug.bufferPct,
      });
    }

    partCount++;

    // Flush batches when they get large enough
    if (summaryBatch.length >= BATCH_SIZE) {
      await flushBatches(summaryBatch, periodBatch, suggestionBatch);
    }

    // Periodically update progress
    if (partCount % PROGRESS_CHECK_INTERVAL === 0 && shouldReportProgress()) {
      await updateProgress(runId, partCount, totalParts);
    }
  }

  // ── Flush remaining rows ──
  if (summaryBatch.length > 0) {
    await flushBatches(summaryBatch, periodBatch, suggestionBatch);
  }

  // Final progress update
  await updateProgress(runId, partCount, totalParts);

  return {
    partCount,
    aggregationSource: {
      summaries: [...aggregationSummaries.values()],
      periods: [...aggregationPeriods.values()],
    },
  };
}

// ── Aggregated (主件聚合) projection ──

const COSTDOWN_SUFFIX_RE = /-(D7|D9|CD[1-9])$/;

/** Strip SY costdown suffix from a customer part no (e.g. "X-D9" → "X"). */
export function getCustomerPartNoBase(customerPartNo: string | null): string {
  if (!customerPartNo) return '';
  return customerPartNo.replace(COSTDOWN_SUFFIX_RE, '');
}

/** Group key for 主件聚合: forging_parent + customer_part_no_base. */
function aggregationGroupKey(forgingParent: string | null, customerPartNo: string | null): string {
  return `${forgingParent ?? ''}#${getCustomerPartNoBase(customerPartNo)}`;
}

/**
 * Run the AGGREGATED FG monthly projection (按主件聚合).
 *
 * Variants sharing the same (forging_parent, customer_part_no_base) are merged into a single
 * group whose row in fg_monthly carries `is_aggregated=true` and `aggregated_members=[partVer1, partVer2, ...]`.
 *
 * Per the user's rule:
 *   - Orders + Forecasts: SUM across all variants in the group (every customer demand is real).
 *   - Inventory: SUM each unique ERP料號 only ONCE (don't double-count physical stock).
 *   - WO + Production plans: collected across all variants (records are naturally unique).
 *   - Then run the SAME Source d4/21 formula on the merged inputs.
 */
export async function calculateFgMonthlyAggregated(
  runId: number,
  inputs?: RunCalculationInputs,
  source?: FgMonthlyAggregationSource,
): Promise<{ groupCount: number }> {
  const numPeriods = config.mrp.projectionMonths;
  const run = inputs
    ? null
    : await prisma.mrpRun.findUnique({ where: { id: runId }, select: { runDate: true } });
  const baseDate = inputs?.runDate ? new Date(inputs.runDate) : run?.runDate ? new Date(run.runDate) : new Date();
  const periods = generateMonthlyPeriods(baseDate, numPeriods);

  // 同 calculateFgMonthly：清舊 aggregated row。is_aggregated=true 區分，
  // 不會碰到 per-version 的 row。
  await prisma.fgMonthlyPeriod.deleteMany({ where: { mrpRunId: runId, isAggregated: true } });
  await prisma.fgMonthly.deleteMany({ where: { mrpRunId: runId, isAggregated: true } });

  const parts = inputs?.partVersionRows
    ?? await prisma.stagingPartVersion.findMany({ where: { mrpRunId: runId } });
  const allInventory = await getRunInventoryRows(runId, inputs);
  const [perSummaries, perPeriods] = source
    ? [source.summaries, source.periods]
    : await Promise.all([
      prisma.fgMonthly.findMany({
        where: { mrpRunId: runId, isAggregated: false },
      }),
      prisma.fgMonthlyPeriod.findMany({
        where: { mrpRunId: runId, isAggregated: false },
      }),
    ]);
  const allForecasts = inputs?.forecastRows
    ?? await prisma.stagingForecast.findMany({
      where: { mrpRunId: runId },
      select: { partVersion: true, forecastStart: true },
    });

  const inventoryByErp = new Map<string, typeof allInventory[0]>();
  for (const inv of allInventory) {
    if (inv.erpPartNo) inventoryByErp.set(inv.erpPartNo, inv);
  }
  const summaryByPart = new Map(perSummaries.map((summary) => [summary.partVersion, summary]));
  const periodsByPart = groupBy(perPeriods, (period) => period.partVersion);
  const erpByPart = new Map(parts.map((part) => [part.partVersion, part.erpPartNo]));
  const finalBalanceByErpPeriod = new Map<string, { remainingStock: number; remainingNoPlan: number }>();
  for (const period of perPeriods) {
    const erpPartNo = erpByPart.get(period.partVersion);
    if (!erpPartNo) continue;
    const key = `${erpPartNo}\u0000${period.periodIndex}`;
    const remainingStock = Number(period.remainingStock) || 0;
    const remainingNoPlan = Number(period.remainingNoPlan) || 0;
    const current = finalBalanceByErpPeriod.get(key);
    if (!current) {
      finalBalanceByErpPeriod.set(key, { remainingStock, remainingNoPlan });
    } else {
      current.remainingStock = Math.min(current.remainingStock, remainingStock);
      current.remainingNoPlan = Math.min(current.remainingNoPlan, remainingNoPlan);
    }
  }
  const forecastPresence = new Set<string>();
  for (const forecast of allForecasts) {
    if (!forecast.partVersion || !forecast.forecastStart) continue;
    const periodIndex = dateToPeriodIndex(forecast.forecastStart, periods);
    if (periodIndex >= 0 && periodIndex < numPeriods) {
      forecastPresence.add(`${forecast.partVersion}\u0000${periodIndex}`);
    }
  }

  // Build groups: key → list of part rows
  const groups = new Map<string, Array<(typeof parts)[number]>>();
  for (const p of parts) {
    if (!p.partVersion || !p.erpPartNo) continue; // mirror Source d4/21:2293 skip
    const key = aggregationGroupKey(p.forgingParent, p.customerPartNo);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(p);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryBatch: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periodBatch: any[] = [];
  let groupCount = 0;
  const totalGroups = groups.size;
  const PROGRESS_CHECK_INTERVAL = 200;
  const shouldReportProgress = createCalculationProgressThrottle();

  for (const [, members] of groups) {
    // Pick representative variant: prefer one whose customerPartNo equals the cdBase (i.e. the
    // "main part" with no costdown suffix). Otherwise fall back to first by part_version.
    const sortedMembers = [...members].sort((a, b) => (a.partVersion || '').localeCompare(b.partVersion || ''));
    const main = sortedMembers.find((p) =>
      p.customerPartNo && getCustomerPartNoBase(p.customerPartNo) === p.customerPartNo,
    ) ?? sortedMembers[0];

    const uniqueErps = new Set<string>();
    for (const p of members) if (p.erpPartNo) uniqueErps.add(p.erpPartNo);
    let aggRawStock = 0;
    let aggMainStock = 0;
    let aggAuxStock = 0;
    let aggBadStock = 0;
    for (const erp of uniqueErps) {
      const inv = inventoryByErp.get(erp);
      if (!inv) continue;
      const stock = resolveInventoryAvailability(inv);
      aggRawStock += stock.inStockPc;
      aggMainStock += stock.mainStockPc;
      aggAuxStock += stock.auxStockPc;
      aggBadStock += Number(inv.badStockPc) || 0;
    }

    const skipFg = members.every((m) => m.skipFgInventory);
    const stockPeriods = Math.max(0, ...members.map((m) => Number(m.targetStockPeriods) || 0));
    const memberSummaries = members
      .map((member) => summaryByPart.get(member.partVersion))
      .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));
    if (memberSummaries.length === 0) continue;
    const memberPeriods = members.flatMap((member) => periodsByPart.get(member.partVersion) ?? []);
    const periodsByIndex = groupBy(memberPeriods, (period) => String(period.periodIndex));
    const aggregatedPeriods = periods.map((period, periodIndex) => {
      const sourcePeriods = periodsByIndex.get(String(periodIndex)) ?? [];
      let remainingStock = 0;
      let remainingNoPlan = 0;
      for (const erp of uniqueErps) {
        const balance = finalBalanceByErpPeriod.get(`${erp}\u0000${periodIndex}`);
        remainingStock += balance?.remainingStock ?? 0;
        remainingNoPlan += balance?.remainingNoPlan ?? 0;
      }
      return {
        period,
        remainingStock,
        remainingNoPlan,
        demandIntegrated: sumNumbers(sourcePeriods, (row) => row.demandIntegrated),
        ordersUnshipped: sumNumbers(sourcePeriods, (row) => row.ordersUnshipped),
        ordersTotal: sumNumbers(sourcePeriods, (row) => row.ordersTotal),
        forecastQty: sumNumbers(sourcePeriods, (row) => row.forecastQty),
        plannedOutput: sumNumbers(sourcePeriods, (row) => row.plannedOutput),
      };
    });
    const shortageStartPeriod = aggregatedPeriods.findIndex((period) => period.remainingStock < 0);
    const shortageStartPeriodNoPlan = aggregatedPeriods.findIndex((period) => period.remainingNoPlan < 0);
    const effectiveStockPeriods = stockPeriods || 2;
    let missingForecastPeriods = 0;
    for (let i = 0; i < Math.min(effectiveStockPeriods, numPeriods); i++) {
      if (!members.some((member) => forecastPresence.has(`${member.partVersion}\u0000${i}`))) {
        missingForecastPeriods++;
      }
    }

    summaryBatch.push({
      mrpRunId: runId,
      partVersion: main.partVersion,
      customerPartNo: getCustomerPartNoBase(main.customerPartNo),
      customerCode: main.customerCode,
      erpPartNo: main.erpPartNo,
      forgingMachine: main.forgingMachine,
      firstProcess: aggregateFirstProcessValue(memberSummaries.map(row => row.firstProcess)),
      firstProcessErpPartNo: aggregateFirstProcessValue(memberSummaries.map(row => row.firstProcessErpPartNo)),
      firstProcessSourceType: aggregateFirstProcessValue(memberSummaries.map(row => row.firstProcessSourceType)),
      surfaceTreatment: main.surfaceTreatment,
      forgingParent: main.forgingParent,
      processBomVersion: main.processBomVersion,
      productStatus: main.productStatus,
      stockPeriods,
      sortGroup: main.sortGroup,
      unitWeightG: Number(main.unitWeightG) || 0,
      mainMaterialKg: Number(main.mainMaterialKg) || 0,
      currentStockPc: aggRawStock,
      mainStockPc: aggMainStock,
      auxStockPc: aggAuxStock,
      badStockPc: aggBadStock,
      skipFgInventory: skipFg,
      woScheduled: sumNumbers(memberSummaries, (row) => row.woScheduled),
      woUnscheduled: sumNumbers(memberSummaries, (row) => row.woUnscheduled),
      woTotal: sumNumbers(memberSummaries, (row) => row.woTotal),
      planReportedQty: sumNumbers(memberSummaries, (row) => row.planReportedQty),
      planClosedQty: sumNumbers(memberSummaries, (row) => row.planClosedQty),
      priorPlanQty: sumNumbers(memberSummaries, (row) => row.priorPlanQty),
      period1PlanQty: sumNumbers(memberSummaries, (row) => row.period1PlanQty),
      shortageStartPeriod: shortageStartPeriod >= 0 ? shortageStartPeriod : null,
      shortageStartPeriodNoPlan: shortageStartPeriodNoPlan >= 0 ? shortageStartPeriodNoPlan : null,
      missingForecastPeriods,
      shouldPlanProduction: shortageStartPeriod >= 0 && shortageStartPeriod < effectiveStockPeriods,
      priorUnshippedQty: sumNumbers(memberSummaries, (row) => row.priorUnshippedQty),
      totalUnshippedQty: sumNumbers(memberSummaries, (row) => row.totalUnshippedQty),
      totalPlanSupply: sumNumbers(memberSummaries, (row) => row.totalPlanSupply),
      isAggregated: true,
      aggregatedMembers: sortedMembers.map((m) => m.partVersion!).filter(Boolean),
    });

    for (let i = 0; i < numPeriods; i++) {
      const aggregated = aggregatedPeriods[i];
      periodBatch.push({
        mrpRunId: runId,
        partVersion: main.partVersion,
        periodIndex: i,
        periodLabel: periods[i].label,
        periodStart: periods[i].start,
        periodEnd: periods[i].end,
        remainingStock: aggregated.remainingStock,
        remainingNoPlan: aggregated.remainingNoPlan,
        demandIntegrated: aggregated.demandIntegrated,
        ordersUnshipped: aggregated.ordersUnshipped,
        ordersTotal: aggregated.ordersTotal,
        forecastQty: aggregated.forecastQty,
        plannedOutput: aggregated.plannedOutput,
        isAggregated: true,
      });
    }

    groupCount++;
    if (summaryBatch.length >= BATCH_SIZE) {
      await flushAggregatedBatches(summaryBatch, periodBatch);
    }
    if (groupCount % PROGRESS_CHECK_INTERVAL === 0 && shouldReportProgress()) {
      await updateProgress(runId, groupCount, totalGroups);
    }
  }

  if (summaryBatch.length > 0) {
    await flushAggregatedBatches(summaryBatch, periodBatch);
  }
  await updateProgress(runId, groupCount, totalGroups);

  return { groupCount };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flushAggregatedBatches(summaryBatch: any[], periodBatch: any[]) {
  const writes: Promise<unknown>[] = [];
  if (summaryBatch.length > 0) {
    writes.push(prisma.fgMonthly.createMany({ data: summaryBatch.splice(0), skipDuplicates: true }));
  }
  if (periodBatch.length > 0) {
    writes.push(prisma.fgMonthlyPeriod.createMany({ data: periodBatch.splice(0), skipDuplicates: true }));
  }
  await settleAllOrThrow(writes);
}

// ── Batch insert helpers ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flushBatches(summaryBatch: any[], periodBatch: any[], suggestionBatch: any[]) {
  const writes: Promise<unknown>[] = [];
  if (summaryBatch.length > 0) {
    writes.push(prisma.fgMonthly.createMany({ data: summaryBatch.splice(0), skipDuplicates: true }));
  }
  if (periodBatch.length > 0) {
    writes.push(prisma.fgMonthlyPeriod.createMany({ data: periodBatch.splice(0), skipDuplicates: true }));
  }
  if (suggestionBatch.length > 0) {
    writes.push(prisma.fgPlanSuggestion.createMany({ data: suggestionBatch.splice(0), skipDuplicates: true }));
  }
  await settleAllOrThrow(writes);
}

async function updateProgress(runId: number, partCount: number, totalParts: number) {
  await prisma.$executeRaw`
    UPDATE demo."MrpRun"
    SET "stepStatus" = jsonb_set(
      COALESCE("stepStatus", '{}'::jsonb),
      '{_calcProgress}'::text[],
      ${JSON.stringify({ status: 'running', partsProcessed: partCount, totalParts })}::jsonb
    )
    WHERE id = ${runId}
  `;
}

// ── Utility helpers ──

function earlierDate(current: Date | null, candidate: Date | null): Date | null {
  if (!candidate) return current;
  if (!current || candidate < current) return candidate;
  return current;
}


function sumNumbers<T>(items: T[], valueFn: (item: T) => unknown): number {
  return items.reduce((sum, item) => sum + (Number(valueFn(item)) || 0), 0);
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * Generate up to 3 production plan suggestions for a part with shortages
 */
function generatePlanSuggestions(
  part: PartData,
  periodData: PeriodData[],
  periodResults: Array<{ remainingStock: number; remainingNoPlan: number; demandIntegrated: number }>,
  periods: MrpPeriod[],
  initialBalance: number,
  baseDate: Date,
): Array<{
  sequence: number;
  targetStartPeriod: number;
  fulfillToPeriod: number;
  suggestedQty: number;
  completionDate: Date;
  materialWeightKg: number;
  bufferPct: number;
}> {
  const bufferPct = config.mrp.defaultBufferPct;
  const targetPeriods = part.stockPeriods || 2;
  const suggestions: Array<{
    sequence: number;
    targetStartPeriod: number;
    fulfillToPeriod: number;
    suggestedQty: number;
    completionDate: Date;
    materialWeightKg: number;
    bufferPct: number;
  }> = [];

  let simStock = initialBalance;
  let planNum = 0;
  let priorSuggestedQty = 0;

  for (let i = 0; i < periodData.length && planNum < 3; i++) {
    const demand = periodResults[i].demandIntegrated;
    simStock += periodData[i].plannedOutput - demand;

    if (simStock < 0) {
      const endPeriod = Math.min(i + targetPeriods, periodData.length);
      const fulfillToPeriod = endPeriod - 1 + 0.5;
      const suggestedQty = computeFulfillmentPlanQty(
        periodResults,
        fulfillToPeriod,
        bufferPct * 100,
        priorSuggestedQty,
      );
      if (suggestedQty <= 0) continue;
      planNum++;

      const materialWeightKg = part.mainMaterialKg > 0
        ? suggestedQty * part.mainMaterialKg
        : part.unitWeightG > 0
          ? (suggestedQty * part.unitWeightG) / 1000
          : 0;

      const completionDate = completionDateForPeriod(baseDate, Math.max(0, i - 1));

      suggestions.push({
        sequence: planNum,
        targetStartPeriod: i,
        fulfillToPeriod,
        suggestedQty,
        completionDate,
        materialWeightKg,
        bufferPct,
      });

      simStock += suggestedQty;
      priorSuggestedQty += suggestedQty;
    }
  }

  return suggestions;
}
