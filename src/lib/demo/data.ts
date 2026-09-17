import { Prisma } from '@prisma/client';
import { state, seedRuns } from './store';
import { evaluateInventoryLotQuantity } from '../sync/inventory-snapshot';
import { reconcileWorkOrderBomUsage, type WorkOrderMaterialMovementInput } from '../mrp/work-order-bom-usage';

export type DemoRow = Record<string, unknown>;
export interface DemoRun { id: number; versionCode: string; runDate: string; status: string; isLatest: boolean; completedAt: string | null; createdAt: string; createdBy: string; duration: number; syncCounts: Record<string, number>; errorMessage: string | null; stepTiming: Record<string, number>; stepStatus: DemoRow; logs: DemoRow[]; attempt: number; }
export interface DemoDataset { run: DemoRun; fg: DemoRow[]; cw: DemoRow[]; sales: DemoRow[]; fgPeriods: Record<string, DemoRow[]>; cwPeriods: Record<string, DemoRow[]>; salesPeriods: Record<string, DemoRow[]>; source: Record<string, DemoRow[]>; }

export function modelRow(name: string, overrides: DemoRow): DemoRow {
  const model = Prisma.dmmf.datamodel.models.find((item) => item.name === name);
  if (!model) throw new Error(`未知模型 ${name}`);
  return { ...Object.fromEntries(model.fields.filter((field) => field.kind !== 'object').map((field) => [field.name,
    field.isList ? [] : ['string', 'number', 'boolean'].includes(typeof field.default) ? field.default : !field.isRequired ? null : ['Int', 'Float', 'Decimal', 'BigInt'].includes(field.type) ? 0 : field.type === 'Boolean' ? false : field.type === 'DateTime' ? '2026-09-01T00:00:00.000Z' : field.type === 'Json' ? {} : '',
  ])), ...overrides };
}

const demoGlobal = globalThis as typeof globalThis & { demoRuns?: DemoRun[]; demoPresets?: DemoRow[]; demoIgnored?: string[]; demoFollow?: boolean };
export function runs(): DemoRun[] {
  return state().runs;
}
export const demoPreferences = demoGlobal;
const cache = new Map<number, DemoDataset>();
const monthStart = (month: number) => new Date(Date.UTC(2026, 8 + month, 1)).toISOString();
const weekStart = (week: number) => new Date(Date.UTC(2026, 8, 7 + (week - 1) * 7)).toISOString();

export function dataset(runId: number): DemoDataset {
  const snapshot = state().snapshots[String(runId)]; if (snapshot) return snapshot;
  const cached = cache.get(runId); if (cached) return cached;
  const run = runs().find((item) => item.id === runId);
  if (!run) throw new Error('找不到合成版本');
  const result = generateDataset(run);
  cache.set(runId, result); if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return result;
}
export function generateDataset(run: DemoRun = seedRuns()[0]): DemoDataset {
  const runId = run.id;
  const result: DemoDataset = { run, fg: [], cw: [], sales: [], fgPeriods: {}, cwPeriods: {}, salesPeriods: {}, source: Object.fromEntries(['part_versions', 'inventory', 'orders', 'forecasts', 'work_orders', 'work_order_bom', 'inventory_lots', 'work_order_material_movements', 'production_plans', 'purchase_orders'].map((table) => [table, []])) };
  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(3, '0');
    const erp = `DEMO-FG-${n}-V01`;
    const opening = i % 4 === 0 ? 60000 : 2000 + i * 90;
    const orderQty = 700 + i * 20 + runId * 50;
    const forecastQty = orderQty + 200;
    const plannedQty = 3000;
    const weight = 10 + i / 2;
    const partVersions = ['XA', 'XB'].map((customer) => `${customer}-PRODUCT-${n}-R1`);
    for (let j = 0; j < 2; j++) {
      const customer = j === 0 ? 'XA' : 'XB';
      const partVersion = partVersions[j];
      const customerPartNo = `PRODUCT-${n}`;
      const id = i * 2 + j;
      const periods = Array.from({ length: 13 }, (_, periodIndex) => {
        const demand = periodIndex === 0 ? 0 : forecastQty;
        const poolSupply = periodIndex > 0 && periodIndex % 3 === 1 ? plannedQty : 0;
        const cumulativeSupply = periodIndex === 0 ? 0 : Math.ceil(periodIndex / 3) * plannedQty;
        return modelRow('FgMonthlyPeriod', { id: id * 100 + periodIndex, mrpRunId: runId, partVersion, periodIndex, periodLabel: periodIndex === 0 ? '前期' : monthStart(periodIndex - 1).slice(0, 7), periodStart: monthStart(Math.max(0, periodIndex - 1)), remainingStock: opening + cumulativeSupply - forecastQty * 2 * periodIndex, remainingNoPlan: opening - forecastQty * 2 * periodIndex, demandIntegrated: demand, ordersUnshipped: periodIndex === 0 ? 0 : orderQty, ordersTotal: periodIndex === 0 ? 0 : orderQty, forecastQty: demand, plannedOutput: j === 0 ? poolSupply : 0, isAggregated: false });
      });
      const shortage = periods.find((period) => Number(period.remainingStock) < 0);
      const shortageNoPlan = periods.find((period) => Number(period.remainingNoPlan) < 0);
      const row = modelRow('FgMonthly', { id, mrpRunId: runId, partVersion, customerPartNo, customerCode: customer, erpPartNo: erp, sharedErpCount: 2, usesSharedErpPool: true, forgingMachine: `M${i % 3 + 1}`, firstProcess: '成形', surfaceTreatment: '展示表面處理', forgingParent: `DEMO-PARENT-${String(Math.ceil(i / 3)).padStart(2, '0')}`, processBomVersion: 'DEMO-BOM-V1', productStatus: '使用中', unitWeightG: weight, mainMaterialKg: weight * 0.001 * plannedQty, currentStockPc: opening, mainStockPc: opening - 500, auxStockPc: 500, badStockPc: i % 5 * 20, stockPeriods: 1, sortGroup: 9, inventoryValidationAvailable: true, inventoryAnomalyCount: 0, mainInventoryAnomalyCount: 0, auxInventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [], woScheduled: plannedQty, woUnscheduled: 0, woTotal: plannedQty, planReportedQty: 0, planClosedQty: 0, priorPlanQty: 0, shortageStartPeriod: shortage?.periodIndex ?? null, shortageStartPeriodNoPlan: shortageNoPlan?.periodIndex ?? null, missingForecastPeriods: 0, shouldPlanProduction: Boolean(shortage), priorUnshippedQty: 0, totalUnshippedQty: orderQty * 12, totalPlanSupply: j === 0 ? plannedQty * 4 : 0, lastPeriodRemainingNoPlan: opening - forecastQty * 24, skipFgInventory: false, isAggregated: false, aggregatedMembers: [] });
      result.fg.push(row); result.fgPeriods[partVersion] = periods;
      const salesPeriods = Array.from({ length: 28 }, (_, weekIndex) => {
        const demand = weekIndex === 0 ? 0 : Math.round(orderQty / 4);
        const cumulative = demand * 2 * weekIndex;
        const supply = weekIndex === 3 && j === 0 ? plannedQty : 0;
        return modelRow('SalesMeetingPeriod', { id: id * 100 + weekIndex, mrpRunId: runId, partVersion, weekIndex, weekLabel: weekIndex === 0 ? '前期' : `W${String(weekIndex).padStart(2, '0')}`, weekStart: weekIndex === 0 ? null : weekStart(weekIndex), remainingStock: opening + (weekIndex >= 3 ? plannedQty : 0) - cumulative, demand, supply });
      });
      const recent = Math.round(orderQty / 4) * 4;
      result.sales.push(modelRow('SalesMeeting', { id, mrpRunId: runId, customerCode: customer, customerPartNo, partVersion, memberPartVersions: [partVersion], erpPartNo: erp, unit: 'pc', goodStockPc: opening, goodStockKg: opening * weight / 1000, mainStockPc: opening - 500, auxStockPc: 500, badStockPc: i % 5 * 20, badStockKg: i % 5 * 20 * weight / 1000, avgDemandPerWeek: Math.round(orderQty / 4), stockWeeks: opening / (orderQty / 2), shortageStartWeek: salesPeriods.find((period) => Number(period.remainingStock) < 0)?.weekIndex ?? null, purchaseLeadWeeks: 2, outstanding04: recent, fgDiff04: opening - recent * 2, fgStatus04: opening >= recent * 2 ? '足夠' : '不足', totalOrderDemand: orderQty * 12, totalFgDiff: opening - orderQty * 24, sharedErpCount: 2, inventoryValidationAvailable: true, inventoryAnomalyCount: 0, mainInventoryAnomalyCount: 0, auxInventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [] }));
      result.salesPeriods[partVersion] = salesPeriods;
      result.source.part_versions.push(modelRow('StagingPartVersion', { id, mrpRunId: runId, sourceRecordId: `DEMO-PV-${id}`, partVersion, customerCode: customer, customerPartNo, erpPartNo: erp, unitWeightG: weight, forgingParent: row.forgingParent, forgingMachine: row.forgingMachine, firstProcess: '成形', surfaceTreatment: '展示表面處理', processBomVersion: 'DEMO-BOM-V1', productStatus: '使用中' }));
      for (let month = 0; month < 12; month++) {
        result.source.orders.push(modelRow('StagingOrder', { id: id * 100 + month, mrpRunId: runId, sourceRecordId: `DEMO-SO-${id}-${month}`, partVersion, orderQty, shippedQty: 0, unshippedQty: orderQty, deliveryDate: monthStart(month), orderDate: monthStart(month), orderNo: `DEMO-SO-${id}-${month}` }));
        result.source.forecasts.push(modelRow('StagingForecast', { id: id * 100 + month, mrpRunId: runId, sourceRecordId: `DEMO-FC-${id}-${month}`, partVersion, forecastQty, forecastDate: monthStart(month), forecastMonth: monthStart(month) }));
      }
      result.source.production_plans.push(modelRow('StagingProductionPlan', { id, mrpRunId: runId, sourceRecordId: `DEMO-PLAN-${id}`, partVersion, erpPartNo: erp, plannedQty: j === 0 ? plannedQty : 0, completionDate: monthStart(0), planNo: `DEMO-PLAN-${id}` }));
      const woNumber = `DEMO-WO-${id}`;
      result.source.work_orders.push(modelRow('StagingWorkOrder', { id, mrpRunId: runId, sourceRecordId: `DEMO-WO-${id}`, partVersion, erpPartNo: erp, woNumber, jobOrderCode: woNumber, orderQty: j === 0 ? plannedQty : 0, startDate: weekStart(3) }));
      for (const mrpType of ['W', 'B', 'D']) {
        const materialPartNo = `DEMO-${mrpType}-${String((i - 1) % 12 + 1).padStart(3, '0')}`;
        result.source.work_order_bom.push(modelRow('StagingWorkOrderBom', { id: id * 10 + (mrpType === 'W' ? 1 : mrpType === 'B' ? 2 : 3), mrpRunId: runId, sourceRecordId: `DEMO-BOM-${id}-${mrpType}`, componentNo: materialPartNo, woNumber, sourceType: mrpType === 'D' ? '內製' : '外購', processCode: mrpType === 'D' ? '組合' : '成形', unit: mrpType === 'W' ? 'kg' : 'pc', minUsage: j === 0 ? mrpType === 'W' ? plannedQty * weight / 1000 : plannedQty : 0, remainingUsage: j === 0 ? mrpType === 'W' ? plannedQty * weight / 1000 : plannedQty : 0, issuedQtyState: 'not_issued', movementState: 'fallback', startDate: weekStart(3) }));
      }
    }
    result.source.inventory.push(modelRow('StagingInventory', { id: i, mrpRunId: runId, sourceRecordId: `DEMO-INV-${i}`, erpPartNo: erp, goodStockPc: opening, goodStockKg: opening * weight / 1000, badStockPc: i % 5 * 20 }));
    for (const [warehouseCode, quantity] of [['MAIN', opening - 500], ['AUX', 500]] as const) result.source.inventory_lots.push(modelRow('StagingInventoryLot', { id: i * 2 + (warehouseCode === 'MAIN' ? 0 : 1), mrpRunId: runId, sourceRecordId: `DEMO-LOT-${i}-${warehouseCode}`, lotNo: `DEMO-LOT-${i}-${warehouseCode}`, erpPartNo: erp, warehouseCode, quantity, stockPc: quantity, unit: 'pc' }));
  }
  for (const mrpType of ['W', 'B', 'D']) for (let i = 1; i <= 12; i++) {
    const materialPartNo = `DEMO-${mrpType}-${String(i).padStart(3, '0')}`;
    const unit = mrpType === 'W' ? 'kg' : 'pc';
    const opening = mrpType === 'W' ? 160 + i * 20 : 1200 + i * 100;
    const usage = mrpType === 'W' ? 30 + i : 300 + i * 10;
    const periods = Array.from({ length: 28 }, (_, weekIndex) => modelRow('ComponentWeeklyPeriod', { id: i * 100 + weekIndex, mrpRunId: runId, materialPartNo, mrpType, weekIndex, weekLabel: weekIndex === 0 ? '前期' : `W${String(weekIndex).padStart(2, '0')}`, weekStart: weekIndex === 0 ? null : weekStart(weekIndex), remainingStock: opening + (weekIndex >= 6 ? opening : 0) - usage * weekIndex, usage: weekIndex === 0 ? 0 : usage, receipts: weekIndex === 6 ? opening : 0 }));
    const shortage = periods.find((period) => Number(period.remainingStock) < 0);
    result.cw.push(modelRow('ComponentWeekly', { id: i + (mrpType === 'W' ? 0 : mrpType === 'B' ? 100 : 200), mrpRunId: runId, materialPartNo, mrpType, unit, goodStockPc: mrpType === 'W' ? 0 : opening, goodStockKg: mrpType === 'W' ? opening : opening / 100, badStockPc: 0, badStockKg: 0, avgWeeklyUsage: usage * 27 / 28, stockWeeks: opening / usage, purchaseLeadWeeks: mrpType === 'D' ? 0 : 3, purchaseLeadWeeksConfigured: mrpType !== 'D', shortageStartWeek: shortage?.weekIndex ?? null, shortageStartDate: shortage ? weekStart(Number(shortage.weekIndex)) : null, shortageQty: shortage ? -Number(shortage.remainingStock) : 0, weeksUntilOrder: shortage ? Number(shortage.weekIndex) - 3 : null, orderByDate: shortage ? weekStart(Number(shortage.weekIndex) - 3) : null, purchaseAction: mrpType === 'D' ? null : shortage ? 'plan_order' : 'no_action', overduePurchaseQty: 0, overduePurchaseCount: 0, futurePurchaseQty: opening, futurePurchaseCount: 1, nextPurchaseReceiptDate: weekStart(6) }));
    result.cwPeriods[materialPartNo] = periods;
    result.source.purchase_orders.push(modelRow('StagingPurchaseOrder', { id: i + (mrpType === 'W' ? 0 : mrpType === 'B' ? 100 : 200), mrpRunId: runId, sourceRecordId: `DEMO-PO-${materialPartNo}`, productNo: materialPartNo, orderQty: opening, receiptQty: 0, unreceivedQty: opening, deliveryDate: weekStart(6), unit }));
  }
  for (const part of result.source.part_versions) Object.assign(part, { processBomVersion: '[V01-01HF][V01-02LM][V01-03PA]', unit: 'pc', targetStockPeriods: 4, sortGroup: 9 });
  for (const row of result.fg) row.processBomVersion = '[V01-01HF][V01-02LM][V01-03PA]';
  for (const order of result.source.orders) Object.assign(order, { designatedShipDate: order.deliveryDate, preparedQty: 0, unprepQty: order.orderQty, soldQty: 0, unsoldQty: order.orderQty, shipmentStatus: '未結案', salesStatus: '未結案', prepStatus: '未結案', orderType: '一般', customerPartNo: result.source.part_versions.find((part) => part.partVersion === order.partVersion)?.customerPartNo });
  for (const forecast of result.source.forecasts) forecast.forecastStart = forecast.forecastDate;
  for (const plan of result.source.production_plans) plan.planQty = plan.plannedQty;
  for (const job of result.source.work_orders) Object.assign(job, { woQty: job.orderQty, endDate: weekStart(5), subProcessCode: 'HF01', jobOrderCode: '01', status: '生產中' });
  for (const row of result.source.work_order_bom) if (String(row.componentNo).startsWith('DEMO-W-')) row.sourceType = '線材';
  for (const row of result.source.work_order_bom) Object.assign(row, { alreadyPicked: 'No', issuedQty: 0, grossIssuedQty: 0, consumedQty: 0, returnedQty: 0, netIssuedQty: 0, reservedQty: 0, overIssuedQty: 0 });
  for (const inv of result.source.inventory) Object.assign(inv, { unit: 'pc', subtypeCode: 'FG', inStockPc: inv.goodStockPc, inStockKg: inv.goodStockKg, mainStockPc: Number(inv.goodStockPc) - 500, auxStockPc: 500 });
  for (const lot of result.source.inventory_lots) { const unitWeightG = Number(result.fg.find((row) => row.erpPartNo === lot.erpPartNo)?.unitWeightG); Object.assign(lot, { inventoryLotNo: lot.lotNo, qualityStatus: '正常', stockStatus: '在庫', unitWeightG, stockKg: Number(lot.stockPc) * unitWeightG / 1000 }); Object.assign(lot, evaluateInventoryLotQuantity({ stockPc: lot.stockPc, stockKg: lot.stockKg, unitWeightG })); }
  for (const row of result.cw) result.source.inventory.push(modelRow('StagingInventory', { id: 1000 + Number(row.id), mrpRunId: runId, sourceRecordId: `DEMO-MATERIAL-${row.materialPartNo}`, erpPartNo: row.materialPartNo, subtypeCode: row.mrpType === 'W' ? 'MTRL-WR' : row.mrpType === 'B' ? 'COMP' : 'SEMI', unit: row.unit, goodStockPc: row.goodStockPc, goodStockKg: row.goodStockKg, purchaseLeadWeeks: 3, purchaseLeadWeeksConfigured: true }));
  for (const inv of result.source.inventory) {
    if (inv.erpPartNo === 'DEMO-W-001') inv.goodStockKg = 20;
    if (inv.erpPartNo === 'DEMO-W-003') inv.purchaseLeadWeeksConfigured = false;
  }
  const unknown = result.source.work_order_bom.find((row) => row.componentNo === 'DEMO-W-002' && Number(row.minUsage) > 0);
  if (unknown) Object.assign(unknown, { alreadyPicked: 'Yes', issuedQtyState: 'unknown', issuedQtyError: 'missing_issued_quantity', issuedQty: null, grossIssuedQty: null, consumedQty: null, returnedQty: null, netIssuedQty: null, reservedQty: null, remainingUsage: null, movementState: 'unknown' });
  const partial = result.source.work_order_bom.find((row) => row.componentNo === 'DEMO-B-003' && Number(row.minUsage) > 0);
  if (partial) Object.assign(partial, { alreadyPicked: 'Yes', issuedQtyState: 'known', issuedQty: Number(partial.minUsage) / 2, netIssuedQty: Number(partial.minUsage) / 2, grossIssuedQty: Number(partial.minUsage) / 2, remainingUsage: Number(partial.minUsage) / 2, movementState: 'known', consumedQty: 0, reservedQty: Number(partial.minUsage) / 2 });
  const full = result.source.work_order_bom.find((row) => row.componentNo === 'DEMO-D-004' && Number(row.minUsage) > 0);
  if (full) Object.assign(full, { alreadyPicked: 'Yes', issuedQtyState: 'known', issuedQty: full.minUsage, netIssuedQty: full.minUsage, grossIssuedQty: full.minUsage, remainingUsage: 0, movementState: 'known', consumedQty: full.minUsage, reservedQty: 0 });
  const returned = result.source.work_order_bom.find((row) => row.componentNo === 'DEMO-B-005' && Number(row.minUsage) > 0);
  const cases = [
    { bom: partial, gross: Number(partial?.issuedQty), consumed: 0, returned: 0, lotNo: 'DEMO-ISSUED-LOT-B003' },
    { bom: full, gross: Number(full?.minUsage), consumed: Number(full?.minUsage), returned: 0, lotNo: 'DEMO-ISSUED-LOT-D004' },
    { bom: returned, gross: Number(returned?.minUsage), consumed: Number(returned?.minUsage), returned: 300, lotNo: 'DEMO-MATERIAL-LOT-DEMO-B-005-2' },
  ];
  for (const example of cases) {
    if (!example.bom) continue;
    const rows: DemoRow[] = [];
    const add = (basisType: string, movementType: string, qty: number, movementQty: number, day: number) => {
      const movementDate = new Date(weekStart(1)); movementDate.setUTCDate(movementDate.getUTCDate() + day);
      const id = 9000 + result.source.work_order_material_movements.length;
      const row = modelRow('StagingWorkOrderMaterialMovement', { id, mrpRunId: runId, sourceRecordId: `DEMO-MOVEMENT-${id}`, workOrderNo: example.bom!.woNumber, bomItemKey: example.bom!.sourceRecordId, inventoryLotNo: example.lotNo, componentNo: example.bom!.componentNo, movementDate: movementDate.toISOString(), basisType, movementType, inputUnit: 'pc', inputQtyPc: qty, movementQtyPc: movementQty });
      rows.push(row); result.source.work_order_material_movements.push(row);
    };
    add('入-採購單', 'IN入庫', example.gross, example.gross, 0);
    add('調-製令單領料', 'TRANS調撥', example.gross, 0, 7);
    if (example.consumed) add('出-工單耗用', 'OUT出庫', example.consumed, -example.consumed, 8);
    if (example.returned) add('入-製令單退料', 'IN入庫', example.returned, example.returned, 9);
    Object.assign(example.bom, { alreadyPicked: 'Yes', issuedQty: example.gross, issuedDetailCount: 1, issuedQtyError: null }, reconcileWorkOrderBomUsage({ plannedUsage: Number(example.bom.minUsage), bomUnit: example.bom.unit, ledgerIssuedQty: example.gross, formUsage: { issuedQty: example.gross, remainingUsage: Math.max(Number(example.bom.minUsage) - example.gross, 0), issuedQtyState: 'known', issuedDetailCount: 1, issuedQtyError: null }, movements: rows as unknown as WorkOrderMaterialMovementInput[], movementSourceAvailable: true }));
  }
  for (const inv of result.source.inventory.filter((row) => row.subtypeCode !== 'FG')) {
    const example = cases.find((row) => row.bom?.componentNo === inv.erpPartNo);
    const stockPc = Number(inv.goodStockPc), stockKg = Number(inv.goodStockKg);
    const secondPc = example?.returned || stockPc / 2;
    for (const index of [1, 2]) result.source.inventory_lots.push(modelRow('StagingInventoryLot', { id: 2000 + result.source.inventory_lots.length, mrpRunId: runId, sourceRecordId: `DEMO-MATERIAL-LOT-${inv.erpPartNo}-${index}`, lotNo: `DEMO-MATERIAL-LOT-${inv.erpPartNo}-${index}`, erpPartNo: inv.erpPartNo, warehouseCode: 'MAIN', qualityStatus: '正常', stockStatus: '在庫', stockPc: index === 1 ? stockPc - secondPc : secondPc, stockKg: example?.returned ? (index === 1 ? stockPc - secondPc : secondPc) / 100 : stockKg / 2, sourceWorkOrderNo: example?.returned && index === 2 ? example.bom?.woNumber : null }));
    if (example?.bom && !example.returned) result.source.inventory_lots.push(modelRow('StagingInventoryLot', { id: 2000 + result.source.inventory_lots.length, mrpRunId: runId, sourceRecordId: example.lotNo, lotNo: example.lotNo, erpPartNo: inv.erpPartNo, warehouseCode: 'PROCESS', qualityStatus: '正常', stockStatus: example.consumed ? '已結清' : '在製', stockPc: example.gross - example.consumed, stockKg: (example.gross - example.consumed) / 100, sourceWorkOrderNo: example.bom.woNumber }));
  }
  return result;
}
