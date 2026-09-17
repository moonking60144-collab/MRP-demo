/**
 * Component Weekly Projection Engine
 * Port of calculateMrpWeeklyProjection() from Source JS (synthetic planning reference workflow, lines 811-1810)
 * Calculates a 27-week forward rolling stock projection plus a 前期 (W00)
 * bucket per material — matching Source's `for (i = 1; i <= 27; i++)` loop and
 * `avgUsagePerWeek = totalUsage / 28` analytic.
 *
 * Three MRP types:
 *   W線材   — Wire materials (inventory-driven, supply from purchase orders)
 *   B外購   — Purchased components (BOM-driven, supply from purchase orders)
 *   D內製組合 — In-house assemblies (BOM-driven, supply from work orders)
 *
 * Optimized for remote DB: bulk reads already used, writes now batched with createMany.
 */
import prisma from '../db';
import { config } from '../config';
import { runLog } from '../run-logger';
import { dateToWeekBucket, generateWeeklyPeriods, type MrpWeek } from './period-utils';
import { resolveWorkOrderBomDemand } from './work-order-bom-usage';
import { createCalculationProgressThrottle } from './calculation-progress';
import {
  componentWeeklyUnitsMatch,
  componentWeeklyUsageWhere,
  matchesComponentWeeklyUsageType,
  normalizeComponentWeeklyMaterialPartNo,
  resolveComponentWeeklyDemandDate,
  type ComponentWeeklyUsageBomRow,
} from './component-weekly-usage';
import { resolveInventoryAvailability } from '../sync/inventory-snapshot';
import {
  getRunInventoryRows,
  type RunCalculationInputs,
} from './run-calculation-inputs';
import {
  isComponentWeeklyPurchaseOverdue,
  resolveComponentWeeklyPurchaseDecision,
} from './component-weekly-purchase';
import { resolveComponentWeeklyInventorySources } from './component-weekly-inventory-source';

type MrpType = 'W' | 'B' | 'D';

interface InventoryRecord {
  erpPartNo: string;
  itemStatus: string | null;
  goodStockPc: number;
  goodStockKg: number;
  badStockPc: number;
  badStockKg: number;
  unit: string | null;
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean | null;
}

// usage/supply aggregated by yearWeek string → quantity
export type ComponentWeeklyMap = Map<string, Map<string, number>>; // materialNo → (weekLabel → qty)

export interface ComponentWeeklyPurchaseMeta {
  overduePurchaseQty: number;
  overduePurchaseCount: number;
  futurePurchaseQty: number;
  futurePurchaseCount: number;
  nextPurchaseReceiptDate: Date | null;
}

interface ComponentWeeklyPurchaseReceipt {
  deliveryDate: Date;
  unreceivedQty: number;
}

interface ComponentWeeklyProjectedPeriod {
  weekIndex: number;
  weekLabel: string;
  weekStart: Date | null;
  receipts: number;
  usage: number;
  endingStock: number;
}

const BATCH_SIZE = 500;

export function selectComponentWeeklyMaterialNumbers(
  mrpType: MrpType,
  inventoryMap: ReadonlyMap<string, Pick<InventoryRecord, 'itemStatus'>>,
  usageMap: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string[] {
  if (mrpType !== 'W') return Array.from(usageMap.keys());

  const materials = new Set<string>();
  for (const [erpPartNo, inventory] of inventoryMap) {
    const materialPartNo = normalizeComponentWeeklyMaterialPartNo(erpPartNo);
    if (!materialPartNo) continue;
    const itemStatus = inventory.itemStatus?.trim();
    if (!itemStatus || itemStatus === '使用中' || usageMap.has(materialPartNo)) {
      materials.add(materialPartNo);
    }
  }
  return Array.from(materials);
}

export function resolveComponentWeeklyUnit(
  mrpType: MrpType,
  inventoryUnit: string | null | undefined,
  usageUnit: string | null | undefined,
  inventoryStock?: {
    stockPc: number;
    stockKg: number;
  },
): string | null {
  const explicitInventoryUnit = inventoryUnit?.trim();
  if (explicitInventoryUnit) return explicitInventoryUnit;
  if (mrpType === 'W' && inventoryStock) {
    const hasPcStock = inventoryStock.stockPc !== 0;
    const hasKgStock = inventoryStock.stockKg !== 0;
    if (hasKgStock && !hasPcStock) return 'kg';
    if (hasPcStock && !hasKgStock) return 'pc';
  }
  return usageUnit?.trim() || null;
}

export function resolveComponentWeeklyInitialStock(
  mrpType: MrpType,
  unit: string | null | undefined,
  inventory: {
    stockPc: number;
    stockKg: number;
  },
): number {
  const unitUpper = unit?.trim().toUpperCase();
  if (unitUpper === 'KG') return inventory.stockKg;
  if (mrpType === 'W' && !unitUpper) return 0;
  return inventory.stockPc;
}

export function aggregateComponentWeeklyUsageRows(
  rows: readonly ComponentWeeklyUsageBomRow[],
  weeks: MrpWeek[],
  options: {
    enforceUnitConsistency?: boolean;
    canonicalUnits?: ReadonlyMap<string, string | null | undefined>;
    workOrderStartDates?: ReadonlyMap<string, Date | null | undefined>;
  } = {},
): {
  usageMap: ComponentWeeklyMap;
  unitMap: Map<string, string>;
  unitMismatchCountMap: Map<string, number>;
} {
  const usageMap: ComponentWeeklyMap = new Map();
  const unitMap = new Map<string, string>();
  const unitMismatchCountMap = new Map<string, number>();

  if (options.enforceUnitConsistency) {
    const sourceUnits = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const cleanComp = normalizeComponentWeeklyMaterialPartNo(row.componentNo);
      const sourceUnit = row.unit?.trim();
      if (!cleanComp || !sourceUnit) continue;
      if (!sourceUnits.has(cleanComp)) sourceUnits.set(cleanComp, new Map());
      sourceUnits.get(cleanComp)!.set(sourceUnit.toLowerCase(), sourceUnit);
    }

    const materials = new Set([
      ...rows
        .map((row) => normalizeComponentWeeklyMaterialPartNo(row.componentNo))
        .filter((material): material is string => material !== null),
      ...(options.canonicalUnits?.keys() ?? []),
    ]);
    for (const material of materials) {
      const canonicalUnit = options.canonicalUnits?.get(material)?.trim();
      if (canonicalUnit) {
        unitMap.set(material, canonicalUnit);
        continue;
      }
      const units = sourceUnits.get(material);
      if (units?.size === 1) unitMap.set(material, units.values().next().value!);
    }
  } else {
    for (const row of rows) {
      const cleanComp = normalizeComponentWeeklyMaterialPartNo(row.componentNo);
      if (!cleanComp || unitMap.has(cleanComp)) continue;
      const canonicalUnit = options.canonicalUnits?.get(cleanComp)?.trim() || row.unit?.trim();
      if (canonicalUnit) unitMap.set(cleanComp, canonicalUnit);
    }
  }

  for (const row of rows) {
    const cleanComp = normalizeComponentWeeklyMaterialPartNo(row.componentNo);
    if (!cleanComp) continue;

    if (!usageMap.has(cleanComp)) usageMap.set(cleanComp, new Map());
    if (
      options.enforceUnitConsistency
      && !componentWeeklyUnitsMatch(unitMap.get(cleanComp), row.unit)
    ) {
      unitMismatchCountMap.set(
        cleanComp,
        (unitMismatchCountMap.get(cleanComp) ?? 0) + 1,
      );
      continue;
    }

    const qty = resolveWorkOrderBomDemand({
      minUsage: row.minUsage,
      remainingUsage: row.remainingUsage,
      issuedQtyState: row.issuedQtyState,
    });
    if (qty <= 0) continue;

    const workOrderNo = row.woNumber?.trim();
    const demandDate = resolveComponentWeeklyDemandDate(
      row.startDate,
      workOrderNo ? options.workOrderStartDates?.get(workOrderNo) : null,
    );
    const weekLabel = dateToWeekBucket(demandDate.date, weeks);
    const compMap = usageMap.get(cleanComp)!;
    compMap.set(weekLabel, (compMap.get(weekLabel) || 0) + qty);
  }

  return { usageMap, unitMap, unitMismatchCountMap };
}

export function projectComponentWeeklyBalance(input: {
  initialStock: number;
  usage: ReadonlyMap<string, number>;
  supply: ReadonlyMap<string, number>;
  weeks: MrpWeek[];
}): {
  periods: ComponentWeeklyProjectedPeriod[];
  totalUsage: number;
  shortageStartWeek: number | null;
  shortageStartDate: Date | null;
  shortageQty: number;
} {
  const firstWeekStart = input.weeks[0]?.start ?? null;
  let priorUsage = 0;
  let priorSupply = 0;

  if (firstWeekStart) {
    for (const [weekLabel, qty] of input.usage) {
      const weekStart = weekLabelToDate(weekLabel, input.weeks);
      if (weekStart !== null && weekStart < firstWeekStart) priorUsage += qty;
    }
    for (const [weekLabel, qty] of input.supply) {
      const weekStart = weekLabelToDate(weekLabel, input.weeks);
      if (weekStart !== null && weekStart < firstWeekStart) priorSupply += qty;
    }
  }

  let remainingStock = input.initialStock + priorSupply - priorUsage;
  let totalUsage = priorUsage;
  let shortageStartWeek: number | null = remainingStock < 0 ? 0 : null;
  let shortageStartDate: Date | null = null;
  let shortageQty = remainingStock < 0 ? Math.abs(remainingStock) : 0;
  const periods: ComponentWeeklyProjectedPeriod[] = [{
    weekIndex: 0,
    weekLabel: '前期',
    weekStart: null,
    receipts: priorSupply,
    usage: priorUsage,
    endingStock: remainingStock,
  }];

  for (let index = 0; index < input.weeks.length; index++) {
    const week = input.weeks[index]!;
    const weekUsage = input.usage.get(week.label) || 0;
    const weekSupply = input.supply.get(week.label) || 0;
    remainingStock = remainingStock + weekSupply - weekUsage;
    totalUsage += weekUsage;

    if (remainingStock < 0 && shortageStartWeek === null) {
      shortageStartWeek = index + 1;
      shortageStartDate = week.start;
      shortageQty = Math.abs(remainingStock);
    }

    periods.push({
      weekIndex: index + 1,
      weekLabel: week.label,
      weekStart: week.start,
      receipts: weekSupply,
      usage: weekUsage,
      endingStock: remainingStock,
    });
  }

  return {
    periods,
    totalUsage,
    shortageStartWeek,
    shortageStartDate,
    shortageQty,
  };
}

export function aggregateComponentWeeklyPurchaseSupply(
  rows: readonly {
    productNo: string | null;
    deliveryDate: Date | null;
    unreceivedQty: unknown;
  }[],
  weeks: MrpWeek[],
  runDate: Date,
): {
  supplyMap: ComponentWeeklyMap;
  purchaseMetaMap: Map<string, ComponentWeeklyPurchaseMeta>;
  purchaseReceiptMap: Map<string, ComponentWeeklyPurchaseReceipt[]>;
} {
  const supplyMap: ComponentWeeklyMap = new Map();
  const purchaseMetaMap = new Map<string, ComponentWeeklyPurchaseMeta>();
  const purchaseReceiptMap = new Map<string, ComponentWeeklyPurchaseReceipt[]>();

  for (const row of rows) {
    if (!row.productNo || !row.deliveryDate) continue;
    const materialPartNo = normalizeComponentWeeklyMaterialPartNo(row.productNo);
    if (!materialPartNo) continue;
    const qty = Number(row.unreceivedQty) || 0;
    if (qty <= 0) continue;

    const meta = purchaseMetaMap.get(materialPartNo) ?? {
      overduePurchaseQty: 0,
      overduePurchaseCount: 0,
      futurePurchaseQty: 0,
      futurePurchaseCount: 0,
      nextPurchaseReceiptDate: null,
    };
    if (isComponentWeeklyPurchaseOverdue(row.deliveryDate, runDate)) {
      meta.overduePurchaseQty += qty;
      meta.overduePurchaseCount += 1;
      purchaseMetaMap.set(materialPartNo, meta);
      continue;
    }

    meta.futurePurchaseQty += qty;
    meta.futurePurchaseCount += 1;
    if (
      meta.nextPurchaseReceiptDate === null
      || row.deliveryDate < meta.nextPurchaseReceiptDate
    ) {
      meta.nextPurchaseReceiptDate = row.deliveryDate;
    }
    purchaseMetaMap.set(materialPartNo, meta);

    if (!purchaseReceiptMap.has(materialPartNo)) purchaseReceiptMap.set(materialPartNo, []);
    purchaseReceiptMap.get(materialPartNo)!.push({
      deliveryDate: row.deliveryDate,
      unreceivedQty: qty,
    });

    const weekLabel = dateToWeekBucket(row.deliveryDate, weeks);
    if (!supplyMap.has(materialPartNo)) supplyMap.set(materialPartNo, new Map());
    const materialSupply = supplyMap.get(materialPartNo)!;
    materialSupply.set(weekLabel, (materialSupply.get(weekLabel) || 0) + qty);
  }

  return { supplyMap, purchaseMetaMap, purchaseReceiptMap };
}

/**
 * Run the component weekly projection for a given MRP run and type
 */
export async function calculateComponentWeekly(
  runId: number,
  mrpType: MrpType,
  inputs?: RunCalculationInputs,
): Promise<{ materialCount: number }> {
  const numWeeks = config.mrp.componentWeeks; // 28
  const run = inputs
    ? null
    : await prisma.mrpRun.findUnique({ where: { id: runId }, select: { runDate: true } });
  const baseDate = inputs?.runDate ? new Date(inputs.runDate) : run?.runDate ? new Date(run.runDate) : new Date();
  const weeks = generateWeeklyPeriods(baseDate, numWeeks);

  // Resume / 重跑前清舊 row（per mrpType）。同 fg-monthly 的 deleteMany 邏輯。
  await prisma.componentWeeklyPeriod.deleteMany({ where: { mrpRunId: runId, mrpType } });
  await prisma.componentWeekly.deleteMany({ where: { mrpRunId: runId, mrpType } });

  // 1. Load bulk data
  const inventoryMap = await loadInventory(runId, mrpType, inputs);
  const { usageMap, unitMap, unitMismatchCountMap } = await loadUsage(
    runId,
    mrpType,
    weeks,
    inventoryMap,
    inputs,
  );
  const unitMismatchCount = Array.from(unitMismatchCountMap.values())
    .reduce((total, count) => total + count, 0);
  if (unitMismatchCount > 0) {
    runLog.warn(
      `[Component weekly ${mrpType}] Excluded ${unitMismatchCount} BOM row(s) whose unit did not match the material canonical unit`,
    );
  }
  const { supplyMap, purchaseMetaMap, purchaseReceiptMap } = await loadSupply(
    runId,
    mrpType,
    weeks,
    baseDate,
    inputs,
  );

  // 2. Build material list
  const materials = selectComponentWeeklyMaterialNumbers(mrpType, inventoryMap, usageMap);
  const totalMaterials = materials.length;
  let materialCount = 0;
  const PROGRESS_CHECK_INTERVAL = 200;
  const shouldReportProgress = createCalculationProgressThrottle();

  // Collect output rows for batch insert
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryBatch: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periodBatch: any[] = [];

  // 3. Calculate for each material
  for (const materialNo of materials) {
    const inv = inventoryMap.get(materialNo);
    const usage = usageMap.get(materialNo) || new Map<string, number>();
    const supply = supplyMap.get(materialNo) || new Map<string, number>();
    const purchaseMeta = purchaseMetaMap.get(materialNo) ?? {
      overduePurchaseQty: 0,
      overduePurchaseCount: 0,
      futurePurchaseQty: 0,
      futurePurchaseCount: 0,
      nextPurchaseReceiptDate: null,
    };
    const purchaseReceipts = purchaseReceiptMap.get(materialNo) ?? [];

    const unit = resolveComponentWeeklyUnit(
      mrpType,
      inv?.unit,
      unitMap.get(materialNo),
      inv
        ? { stockPc: inv.goodStockPc, stockKg: inv.goodStockKg }
        : undefined,
    );

    const initialStock = inv
      ? resolveComponentWeeklyInitialStock(mrpType, unit, {
          stockPc: inv.goodStockPc,
          stockKg: inv.goodStockKg,
        })
      : 0;

    const projection = projectComponentWeeklyBalance({ initialStock, usage, supply, weeks });
    for (const period of projection.periods) {
      periodBatch.push({
        mrpRunId: runId,
        materialPartNo: materialNo,
        mrpType,
        weekIndex: period.weekIndex,
        weekLabel: period.weekLabel,
        weekStart: period.weekStart,
        remainingStock: period.weekIndex === 0 ? null : period.endingStock,
        usage: period.usage,
        receipts: period.receipts,
      });
    }

    // Analytics — Source synthetic planning reference line 1776 hardcodes the divisor as 28
    // (1 prior + 27 forward). Keeping the formula expressed in terms of
    // `numWeeks + 1` so a future change to componentWeeks updates both the
    // forward loop and the divisor in lock-step.
    const avgWeeklyUsage = projection.totalUsage / (numWeeks + 1);
    const stockWeeks = avgWeeklyUsage > 0 ? initialStock / avgWeeklyUsage : 0;
    const purchaseLeadWeeks = inv?.purchaseLeadWeeks || 0;
    const purchaseLeadWeeksConfigured = inv?.purchaseLeadWeeksConfigured ?? false;
    const latePurchaseQty = projection.shortageStartWeek === null
      ? 0
      : purchaseReceipts.reduce((total, receipt) => {
          const isLate = projection.shortageStartWeek === 0
            || (
              projection.shortageStartDate !== null
              && receipt.deliveryDate > projection.shortageStartDate
            );
          return isLate ? total + receipt.unreceivedQty : total;
        }, 0);
    const decision = resolveComponentWeeklyPurchaseDecision({
      mrpType,
      shortageStartWeek: projection.shortageStartWeek,
      shortageQty: projection.shortageQty,
      purchaseLeadWeeks,
      purchaseLeadWeeksConfigured,
      overduePurchaseQty: purchaseMeta.overduePurchaseQty,
      overduePurchaseCount: purchaseMeta.overduePurchaseCount,
      futurePurchaseQty: purchaseMeta.futurePurchaseQty,
      latePurchaseQty,
      shortageStartDate: projection.shortageStartDate,
      nextPurchaseReceiptDate: purchaseMeta.nextPurchaseReceiptDate,
    });
    const orderByDate = decision.weeksUntilOrder !== null && decision.weeksUntilOrder > 0
      ? weeks[decision.weeksUntilOrder - 1]?.start ?? null
      : null;

    summaryBatch.push({
      mrpRunId: runId,
      materialPartNo: materialNo,
      mrpType,
      unit,
      goodStockPc: inv?.goodStockPc ?? 0,
      goodStockKg: inv?.goodStockKg ?? 0,
      badStockPc: inv?.badStockPc ?? 0,
      badStockKg: inv?.badStockKg ?? 0,
      avgWeeklyUsage,
      stockWeeks,
      purchaseLeadWeeks,
      purchaseLeadWeeksConfigured,
      shortageStartWeek: projection.shortageStartWeek,
      shortageStartDate: projection.shortageStartDate,
      shortageQty: projection.shortageQty,
      weeksUntilOrder: decision.weeksUntilOrder,
      orderByDate,
      purchaseAction: decision.purchaseAction,
      ...purchaseMeta,
    });

    materialCount++;

    // Flush batches when large enough
    if (summaryBatch.length >= BATCH_SIZE) {
      await flushBatches(summaryBatch, periodBatch);
    }

    // Progress update
    if (materialCount % PROGRESS_CHECK_INTERVAL === 0 && shouldReportProgress()) {
      await updateProgress(runId, mrpType, materialCount, totalMaterials);
    }
  }

  // Flush remaining
  if (summaryBatch.length > 0) {
    await flushBatches(summaryBatch, periodBatch);
  }

  // Final progress update
  await updateProgress(runId, mrpType, materialCount, totalMaterials);

  return { materialCount };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flushBatches(summaryBatch: any[], periodBatch: any[]) {
  if (summaryBatch.length > 0) {
    await prisma.componentWeekly.createMany({ data: summaryBatch.splice(0), skipDuplicates: true });
  }
  if (periodBatch.length > 0) {
    await prisma.componentWeeklyPeriod.createMany({ data: periodBatch.splice(0), skipDuplicates: true });
  }
}

async function updateProgress(runId: number, mrpType: string, count: number, total: number) {
  await prisma.$executeRaw`
    UPDATE demo."MrpRun"
    SET step_status = jsonb_set(
      COALESCE(step_status, '{}'::jsonb),
      ${`{_componentProgress_${mrpType}}`}::text[],
      ${JSON.stringify({ status: 'running', materialsProcessed: count, totalMaterials: total })}::jsonb
    )
    WHERE id = ${runId}
  `;
}

// ============================================================
// Data loading helpers (unchanged — already bulk loads)
// ============================================================

async function loadInventory(
  runId: number,
  mrpType: MrpType,
  inputs?: RunCalculationInputs,
): Promise<Map<string, InventoryRecord>> {
  const rows = await getRunInventoryRows(runId, inputs);
  const { sourceByMaterialPartNo } = resolveComponentWeeklyInventorySources(rows, mrpType);

  const map = new Map<string, InventoryRecord>();
  for (const [cleanErp, row] of sourceByMaterialPartNo) {
    const stock = resolveInventoryAvailability(row);
    map.set(cleanErp, {
      erpPartNo: cleanErp,
      itemStatus: row.itemStatus,
      goodStockPc: stock.inStockPc,
      goodStockKg: stock.inStockKg,
      badStockPc: Number(row.badStockPc) || 0,
      badStockKg: Number(row.badStockKg) || 0,
      unit: row.unit,
      purchaseLeadWeeks: Number(row.purchaseLeadWeeks) || 0,
      purchaseLeadWeeksConfigured: row.purchaseLeadWeeksConfigured,
    });
  }

  return map;
}

async function loadUsage(
  runId: number,
  mrpType: MrpType,
  weeks: MrpWeek[],
  inventoryMap: ReadonlyMap<string, InventoryRecord>,
  inputs?: RunCalculationInputs,
): Promise<{
  usageMap: ComponentWeeklyMap;
  unitMap: Map<string, string>;
  unitMismatchCountMap: Map<string, number>;
}> {
  const where = { mrpRunId: runId, ...componentWeeklyUsageWhere(mrpType) };
  const rows = inputs?.workOrderBomRows.filter((row) =>
    matchesComponentWeeklyUsageType(row, mrpType))
    ?? await prisma.stagingWorkOrderBom.findMany({ where });
  const workOrders = inputs?.workOrderRows
    ?? await prisma.stagingWorkOrder.findMany({
      where: { mrpRunId: runId },
      select: { woNumber: true, startDate: true },
    });
  const workOrderStartDates = new Map<string, Date | null>();
  for (const workOrder of workOrders) {
    const workOrderNo = workOrder.woNumber?.trim();
    if (workOrderNo && !workOrderStartDates.has(workOrderNo)) {
      workOrderStartDates.set(workOrderNo, workOrder.startDate);
    }
  }

  return aggregateComponentWeeklyUsageRows(rows, weeks, {
    enforceUnitConsistency: mrpType === 'W',
    workOrderStartDates,
    canonicalUnits: new Map(
      Array.from(inventoryMap, ([materialPartNo, inventory]) => [
        materialPartNo,
        resolveComponentWeeklyUnit(
          mrpType,
          inventory.unit,
          null,
          { stockPc: inventory.goodStockPc, stockKg: inventory.goodStockKg },
        ),
      ]),
    ),
  });
}

async function loadSupply(
  runId: number,
  mrpType: MrpType,
  weeks: MrpWeek[],
  runDate: Date,
  inputs?: RunCalculationInputs,
): Promise<{
  supplyMap: ComponentWeeklyMap;
  purchaseMetaMap: Map<string, ComponentWeeklyPurchaseMeta>;
  purchaseReceiptMap: Map<string, ComponentWeeklyPurchaseReceipt[]>;
}> {
  const supplyMap: ComponentWeeklyMap = new Map();
  const purchaseMetaMap = new Map<string, ComponentWeeklyPurchaseMeta>();
  const purchaseReceiptMap = new Map<string, ComponentWeeklyPurchaseReceipt[]>();

  if (mrpType === 'W' || mrpType === 'B') {
    const rows = inputs?.purchaseOrderRows
      ?? await prisma.stagingPurchaseOrder.findMany({
        where: { mrpRunId: runId },
      });

    const purchaseSupply = aggregateComponentWeeklyPurchaseSupply(rows, weeks, runDate);
    for (const [materialPartNo, materialSupply] of purchaseSupply.supplyMap) {
      supplyMap.set(materialPartNo, materialSupply);
    }
    for (const [materialPartNo, purchaseMeta] of purchaseSupply.purchaseMetaMap) {
      purchaseMetaMap.set(materialPartNo, purchaseMeta);
    }
    for (const [materialPartNo, purchaseReceipts] of purchaseSupply.purchaseReceiptMap) {
      purchaseReceiptMap.set(materialPartNo, purchaseReceipts);
    }
  } else if (mrpType === 'D') {
    const rows = inputs?.workOrderRows
      ?? await prisma.stagingWorkOrder.findMany({
        where: { mrpRunId: runId },
      });

    for (const row of rows) {
      if (!row.erpPartNo || !row.endDate) continue;
      const cleanNo = normalizeComponentWeeklyMaterialPartNo(row.erpPartNo);
      if (!cleanNo) continue;
      const qty = Number(row.woQty) || 0;
      if (qty <= 0) continue;

      const weekLabel = dateToWeekBucket(row.endDate, weeks);
      if (!supplyMap.has(cleanNo)) supplyMap.set(cleanNo, new Map());
      const compMap = supplyMap.get(cleanNo)!;
      compMap.set(weekLabel, (compMap.get(weekLabel) || 0) + qty);
    }
  }

  return { supplyMap, purchaseMetaMap, purchaseReceiptMap };
}

// ============================================================
// Date/week mapping helpers
// ============================================================

function weekLabelToDate(label: string, weeks: MrpWeek[]): Date | null {
  if (label === 'PRIOR') return new Date(1900, 0, 1);
  // Returning null prevents the FUTURE bucket from being added to priorUsage
  // (the prior gate is `weekStart < firstWeekStart`).
  if (label === 'FUTURE') return null;
  const week = weeks.find((w) => w.label === label);
  return week?.start || null;
}
