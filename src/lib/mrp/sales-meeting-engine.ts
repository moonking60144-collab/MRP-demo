/**
 * Sales Meeting Weekly Projection Engine
 * Port of calculateMrpSalesMeeting() from Ragic JS (d4_21 workflow, lines 1-768)
 * Calculates 12 weekly forward periods (W01-W12) plus a 前期 bucket (W00) per customer part version.
 *
 * Data sources:
 *   Demand: staging.orders (unshipped qty by delivery week)
 *   Supply: staging.production_plans (plan qty by completion date week)
 *   Inventory: staging.inventory (matched by erpPartNo from part_versions)
 *   Product list: staging.part_versions (customer part version → ERP part no)
 *
 * Optimized for remote DB: writes batched with createMany.
 */
import prisma from '../db';
import { generateWeeklyPeriods, type MrpWeek } from './period-utils';
import { allocateSharedErpPool, type SharedPoolMember } from './shared-erp-pool';
import { createCalculationProgressThrottle } from './calculation-progress';
import { resolveInventoryAvailability } from '../sync/inventory-snapshot';
import {
  getRunInventoryRows,
  type RunCalculationInputs,
} from './run-calculation-inputs';

// 12 weekly forward periods (W01..W12) plus a separate "前期" bucket (W00).
// MUST stay at 12 to match Ragic's d4/36 workflow exactly:
//   - Ragic loops `for (i = 1; i <= 12; i++)` over `weeklyPeriods[i-1]` (only 12 periods used)
//   - avgDemandPerWeek divisor below is hard-coded to (12 + 1) = 13 (prior + 12 weeks)
// Earlier this was 13 which produced an extra W13 column the Ragic export
// doesn't have, AND inflated the W13 cell with all far-future demand because
// `dateToWeekLabel` clamped overflow to the last bucket.
const SALES_MEETING_WEEKS = 12;
const BATCH_SIZE = 500;

interface ProductRecord {
  partVersion: string;
  erpPartNo: string;
  customerCode: string | null;
  unit: string | null;
}

interface InventoryRecord {
  goodStockPc: number;
  goodStockKg: number;
  wfgStockPc: number | null;
  ye1StockPc: number | null;
  badStockPc: number;
  badStockKg: number;
  unit: string | null;
  purchaseLeadWeeks: number;
}

interface WeeklyDemand {
  quantity: number;
  priorityAt: Date | null;
}

type WeeklyDemandMap = Map<string, Map<string, WeeklyDemand>>;
type WeeklySupplyMap = Map<string, Map<string, number>>;

/**
 * Run the sales meeting weekly projection for a given MRP run
 */
export async function calculateSalesMeeting(
  runId: number,
  inputs?: RunCalculationInputs,
): Promise<{ partCount: number }> {
  const run = inputs
    ? null
    : await prisma.mrpRun.findUnique({ where: { id: runId }, select: { runDate: true } });
  const baseDate = inputs?.runDate ? new Date(inputs.runDate) : run?.runDate ? new Date(run.runDate) : new Date();
  const weeks = generateWeeklyPeriods(baseDate, SALES_MEETING_WEEKS);

  // Resume / 重跑前清舊 row。同 fg-monthly 的 deleteMany 邏輯。
  await prisma.salesMeetingPeriod.deleteMany({ where: { mrpRunId: runId } });
  await prisma.salesMeeting.deleteMany({ where: { mrpRunId: runId } });

  // 1. Load bulk data
  const productMap = await loadProductList(runId, inputs);
  const inventoryMap = await loadInventory(runId, inputs);
  const demandMap = await loadOrderDemand(runId, weeks, inputs);
  const supplyMaps = await loadProductionSupply(runId, weeks, productMap, inputs);

  const projectionLabels = [...weeks.map((week) => week.label), 'FUTURE'];
  const prepared = Array.from(productMap.values()).map((product) => {
    const inv = inventoryMap.get(product.erpPartNo);
    const demand = demandMap.get(product.partVersion) || new Map<string, WeeklyDemand>();
    const supply = supplyMaps.byPartVersion.get(product.partVersion) || new Map<string, number>();
    const unit = product.unit || inv?.unit || null;
    const priorDemand = demand.get('PRIOR') ?? { quantity: 0, priorityAt: null };
    const priorSupply = supply.get('PRIOR') || 0;
    const periodDemands = projectionLabels.map((label) =>
      demand.get(label) ?? { quantity: 0, priorityAt: null });
    const periodSupply = projectionLabels.map((label) => supply.get(label) || 0);
    const totalOrderDemand = Array.from(demand.values())
      .reduce((sum, value) => sum + value.quantity, 0);
    const outstanding04 = priorDemand.quantity
      + periodDemands.slice(0, 4).reduce((sum, value) => sum + value.quantity, 0);

    return {
      product,
      inv,
      unit,
      priorDemand,
      priorSupply,
      periodDemands,
      periodSupply,
      totalOrderDemand,
      outstanding04,
      avgDemandPerWeek: totalOrderDemand / (SALES_MEETING_WEEKS + 1),
    };
  });

  const totalParts = prepared.length;
  let partCount = 0;
  const PROGRESS_CHECK_INTERVAL = 200;
  const shouldReportProgress = createCalculationProgressThrottle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryBatch: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periodBatch: any[] = [];

  const byErp = groupBy(prepared, (part) => part.product.erpPartNo);
  for (const [, group] of byErp) {
    const displayOwner = [...group].sort((a, b) => {
      const customerA = a.product.customerCode ?? '';
      const customerB = b.product.customerCode ?? '';
      if (customerA < customerB) return -1;
      if (customerA > customerB) return 1;
      if (a.product.partVersion < b.product.partVersion) return -1;
      if (a.product.partVersion > b.product.partVersion) return 1;
      return 0;
    })[0];
    const poolUnit = group[0].inv?.unit || group.find((part) => part.unit)?.unit || null;
    const poolInventory = group[0].inv;
    const initialStock = poolInventory
      ? (poolUnit || '').toUpperCase() === 'KG'
        ? poolInventory.goodStockKg
        : poolInventory.goodStockPc
      : 0;
    const erpSupply = supplyMaps.byErp.get(group[0].product.erpPartNo) || new Map<string, number>();
    const priorSupply = erpSupply.get('PRIOR') || 0;
    const periodSupply = projectionLabels.map((label) => erpSupply.get(label) || 0);
    const unassignedPriorSupply = priorSupply
      - group.reduce((sum, part) => sum + part.priorSupply, 0);
    if (unassignedPriorSupply > 0) displayOwner.priorSupply += unassignedPriorSupply;
    for (let i = 0; i < projectionLabels.length; i++) {
      const unassignedSupply = periodSupply[i]
        - group.reduce((sum, part) => sum + part.periodSupply[i], 0);
      if (unassignedSupply > 0) displayOwner.periodSupply[i] += unassignedSupply;
    }
    const members: SharedPoolMember[] = group.map((part) => ({
      key: part.product.partVersion,
      customerCode: part.product.customerCode,
      partVersion: part.product.partVersion,
      priorDemand: part.priorDemand,
      periodDemands: part.periodDemands,
    }));
    const allocation = allocateSharedErpPool({ initialStock, priorSupply, periodSupply, members });
    const groupAvgDemand = group.reduce((sum, part) => sum + part.totalOrderDemand, 0)
      / (SALES_MEETING_WEEKS + 1);
    const stockWeeks = groupAvgDemand > 0 ? initialStock / groupAvgDemand : 0;

    for (const part of group) {
      const { product, inv, unit } = part;
      const memberResult = allocation.members.get(product.partVersion)!;
      const ownEvents = allocation.demandEvents
        .filter((event) => event.memberKey === product.partVersion);
      const last04Event = [...ownEvents]
        .reverse()
        .find((event) => event.periodIndex <= 3);
      const lastTotalEvent = ownEvents.at(-1);
      const fgDiff04 = last04Event?.remainingNoPlan ?? memberResult.remainingNoPlan[3];
      const totalFgDiff = lastTotalEvent?.remainingNoPlan
        ?? memberResult.remainingNoPlan[projectionLabels.length - 1];
      const shortageStartWeek = memberResult.shortageStartPeriod === null
        ? null
        : memberResult.shortageStartPeriod + 1;
      const fgStatus04 = part.outstanding04 === 0
        ? '無訂單'
        : fgDiff04 < 0 ? '不足' : '足夠';

      periodBatch.push({
        mrpRunId: runId,
        partVersion: product.partVersion,
        weekIndex: 0,
        weekLabel: '前期',
        weekStart: null,
        remainingStock: null,
        demand: part.priorDemand.quantity,
        supply: part.priorSupply,
      });
      for (let i = 0; i < SALES_MEETING_WEEKS; i++) {
        periodBatch.push({
          mrpRunId: runId,
          partVersion: product.partVersion,
          weekIndex: i + 1,
          weekLabel: weeks[i].label,
          weekStart: weeks[i].start,
          remainingStock: memberResult.remainingStock[i],
          demand: part.periodDemands[i].quantity,
          supply: part.periodSupply[i],
        });
      }

      summaryBatch.push({
        mrpRunId: runId,
        customerCode: product.customerCode,
        partVersion: product.partVersion,
        erpPartNo: product.erpPartNo,
        unit,
        goodStockPc: inv?.goodStockPc ?? 0,
        goodStockKg: inv?.goodStockKg ?? 0,
        wfgStockPc: inv?.wfgStockPc ?? null,
        ye1StockPc: inv?.ye1StockPc ?? null,
        badStockPc: inv?.badStockPc ?? 0,
        badStockKg: inv?.badStockKg ?? 0,
        avgDemandPerWeek: part.avgDemandPerWeek,
        stockWeeks,
        shortageStartWeek,
        purchaseLeadWeeks: inv?.purchaseLeadWeeks || 0,
        outstanding04: part.outstanding04,
        fgDiff04,
        fgStatus04,
        totalOrderDemand: part.totalOrderDemand,
        totalFgDiff,
      });

      partCount++;
      if (summaryBatch.length >= BATCH_SIZE) {
        await flushBatches(summaryBatch, periodBatch);
      }
      if (partCount % PROGRESS_CHECK_INTERVAL === 0 && shouldReportProgress()) {
        await updateProgress(runId, partCount, totalParts);
      }
    }
  }

  // Flush remaining
  if (summaryBatch.length > 0) {
    await flushBatches(summaryBatch, periodBatch);
  }

  // Final progress update
  await updateProgress(runId, partCount, totalParts);

  return { partCount };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flushBatches(summaryBatch: any[], periodBatch: any[]) {
  if (summaryBatch.length > 0) {
    await prisma.salesMeeting.createMany({ data: summaryBatch.splice(0), skipDuplicates: true });
  }
  if (periodBatch.length > 0) {
    await prisma.salesMeetingPeriod.createMany({ data: periodBatch.splice(0), skipDuplicates: true });
  }
}

async function updateProgress(runId: number, count: number, total: number) {
  await prisma.$executeRaw`
    UPDATE public.mrp_run
    SET step_status = jsonb_set(
      COALESCE(step_status, '{}'::jsonb),
      '{_salesMeetingProgress}'::text[],
      ${JSON.stringify({ status: 'running', partsProcessed: count, totalParts: total })}::jsonb
    )
    WHERE id = ${runId}
  `;
}

// ============================================================
// Data loading helpers (unchanged — already bulk loads)
// ============================================================

async function loadProductList(
  runId: number,
  inputs?: RunCalculationInputs,
): Promise<Map<string, ProductRecord>> {
  const rows = inputs?.partVersionRows
    ?? await prisma.stagingPartVersion.findMany({
      where: { mrpRunId: runId },
    });

  const map = new Map<string, ProductRecord>();
  for (const row of rows) {
    if (!row.partVersion || !row.erpPartNo) continue;
    const cleanPart = row.partVersion.trim();
    map.set(cleanPart, {
      partVersion: cleanPart,
      erpPartNo: row.erpPartNo.trim(),
      customerCode: row.customerCode,
      unit: row.unit,
    });
  }

  return map;
}

async function loadInventory(
  runId: number,
  inputs?: RunCalculationInputs,
): Promise<Map<string, InventoryRecord>> {
  const rows = await getRunInventoryRows(runId, inputs);

  const map = new Map<string, InventoryRecord>();
  for (const row of rows) {
    if (!row.erpPartNo) continue;
    const cleanErp = row.erpPartNo.trim();
    const stock = resolveInventoryAvailability(row);
    map.set(cleanErp, {
      goodStockPc: stock.inStockPc,
      goodStockKg: stock.inStockKg,
      wfgStockPc: row.wfgStockPc == null ? null : Number(row.wfgStockPc),
      ye1StockPc: row.ye1StockPc == null ? null : Number(row.ye1StockPc),
      badStockPc: Number(row.badStockPc) || 0,
      badStockKg: Number(row.badStockKg) || 0,
      unit: row.unit,
      purchaseLeadWeeks: Number(row.purchaseLeadWeeks) || 0,
    });
  }

  return map;
}

async function loadOrderDemand(
  runId: number,
  weeks: MrpWeek[],
  inputs?: RunCalculationInputs,
): Promise<WeeklyDemandMap> {
  const rows = inputs?.orderRows.filter((row) =>
    row.shipmentStatus === '未結案' && row.salesStatus === '未結案')
    ?? await prisma.stagingOrder.findMany({
      where: {
        mrpRunId: runId,
        shipmentStatus: '未結案',
        salesStatus: '未結案',
      },
    });

  const demandMap: WeeklyDemandMap = new Map();
  for (const row of rows) {
    // 週分桶用「營業指定出貨日」— 對齊 Ragic（與 fg-monthly 月分桶一致）
    if (!row.partVersion || !row.designatedShipDate) continue;
    const cleanPart = row.partVersion.trim();
    const qty = Number(row.unshippedQty) || 0;
    if (qty <= 0) continue;

    const weekLabel = dateToWeekLabel(row.designatedShipDate, weeks);

    if (!demandMap.has(cleanPart)) demandMap.set(cleanPart, new Map());
    const partMap = demandMap.get(cleanPart)!;
    const current = partMap.get(weekLabel);
    partMap.set(weekLabel, {
      quantity: (current?.quantity || 0) + qty,
      priorityAt: !current?.priorityAt || row.designatedShipDate < current.priorityAt
        ? row.designatedShipDate
        : current.priorityAt,
    });
  }

  return demandMap;
}

async function loadProductionSupply(
  runId: number,
  weeks: MrpWeek[],
  productMap: Map<string, ProductRecord>,
  inputs?: RunCalculationInputs,
): Promise<{ byPartVersion: WeeklySupplyMap; byErp: WeeklySupplyMap }> {
  const rows = inputs?.productionPlanRows
    ?? await prisma.stagingProductionPlan.findMany({
      where: { mrpRunId: runId },
    });

  const byPartVersion: WeeklySupplyMap = new Map();
  const byErp: WeeklySupplyMap = new Map();
  for (const row of rows) {
    if (!row.completionDate) continue;
    const cleanPart = row.partVersion?.trim() || '';
    const qty = Number(row.planQty) || 0;
    if (qty <= 0) continue;

    const weekLabel = dateToWeekLabel(row.completionDate, weeks);
    if (cleanPart) addWeeklySupply(byPartVersion, cleanPart, weekLabel, qty);
    const erpPartNo = row.erpPartNo?.trim() || productMap.get(cleanPart)?.erpPartNo || '';
    if (erpPartNo) addWeeklySupply(byErp, erpPartNo, weekLabel, qty);
  }

  return { byPartVersion, byErp };
}

function addWeeklySupply(map: WeeklySupplyMap, key: string, weekLabel: string, qty: number) {
  if (!map.has(key)) map.set(key, new Map());
  const values = map.get(key)!;
  values.set(weekLabel, (values.get(weekLabel) || 0) + qty);
}

// ============================================================
// Date/week mapping helpers
// ============================================================

function dateToWeekLabel(date: Date, weeks: MrpWeek[]): string {
  for (const week of weeks) {
    if (date >= week.start && date <= week.end) return week.label;
  }
  if (weeks.length > 0 && date < weeks[0].start) return 'PRIOR';
  // Far-future dates (delivery beyond the last displayed week) get their
  // own bucket so they don't inflate the last week's cell. They are still
  // included in U99 (totalOrderDemand) since that sums every key in the
  // demand map. Ragic stores demand by ISO yearWeek which gives the same
  // effect — only the displayed weeks land in U[i] cells.
  return 'FUTURE';
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const group = map.get(key);
    if (group) group.push(item);
    else map.set(key, [item]);
  }
  return map;
}
