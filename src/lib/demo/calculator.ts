import { Prisma, type PrismaClient } from '@prisma/client';
import { calculationContext } from './calculation-context';
import { generateDataset, modelRow, type DemoDataset, type DemoRow, type DemoRun } from './data';
import { calculateFgMonthly, calculateFgMonthlyAggregated } from '../mrp/fg-monthly-engine';
import { calculateComponentWeekly } from '../mrp/component-weekly-engine';
import { calculateSalesMeeting } from '../mrp/sales-meeting-engine';
import { ORDER_DEMAND_CONTRACT_V2 } from '../mrp/order-demand-contract';
import type { RunCalculationInputs } from '../mrp/run-calculation-inputs';

export function hydrateRows(modelName: string, rows: DemoRow[]): DemoRow[] {
  const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === modelName)!;
  const dates = model.fields.filter((field) => field.type === 'DateTime').map((field) => field.name);
  return rows.map((row) => ({ ...row, ...Object.fromEntries(dates.map((key) => [key, row[key] ? new Date(String(row[key])) : null])) }));
}
export async function calculateSyntheticRun(run: DemoRun, leadTimes: Record<string, number | null> = {}, plans: DemoRow[] = [], progress: (step: string) => Promise<void> = async () => {}, applySkipInventory = false): Promise<{ data: DemoDataset; suggestions: DemoRow[] }> {
  const data = generateDataset(run);
  for (const inventory of data.source.inventory) if (String(inventory.erpPartNo) in leadTimes) { inventory.purchaseLeadWeeks = leadTimes[String(inventory.erpPartNo)] ?? 0; inventory.purchaseLeadWeeksConfigured = leadTimes[String(inventory.erpPartNo)] !== null; }
  for (const plan of plans) if (plan.ragicRecordId) data.source.production_plans.push(modelRow('StagingProductionPlan', { id: 5000 + Number(plan.id), mrpRunId: run.id, ragicRecordId: plan.ragicRecordId, planNo: plan.ragicPlanNo, partVersion: plan.partVersion, planQty: plan.suggestedQty, completionDate: plan.completionDate }));
  for (const plan of plans) if (plan.workOrderStatus === 'succeeded') {
    const artifact = plan.workOrderResponse as { workOrder?: DemoRow; bom?: DemoRow[] } | null;
    if (!artifact?.workOrder || !artifact.bom?.length) throw new Error('合成工令缺少已持久化的工令/BOM，不能沿用成功標記。');
    data.source.work_orders.push({ ...artifact.workOrder, mrpRunId: run.id });
    data.source.work_order_bom.push(...artifact.bom.map((row) => ({ ...row, mrpRunId: run.id })));
  }
  const inputTables = { partVersionRows: ['StagingPartVersion', 'part_versions'], inventoryRows: ['StagingInventory', 'inventory'], orderRows: ['StagingOrder', 'orders'], forecastRows: ['StagingForecast', 'forecasts'], workOrderRows: ['StagingWorkOrder', 'work_orders'], workOrderBomRows: ['StagingWorkOrderBom', 'work_order_bom'], productionPlanRows: ['StagingProductionPlan', 'production_plans'], purchaseOrderRows: ['StagingPurchaseOrder', 'purchase_orders'] };
  const inputs = { runDate: new Date(run.runDate), orderDemandContractVersion: ORDER_DEMAND_CONTRACT_V2, ...Object.fromEntries(Object.entries(inputTables).map(([key, [model, table]]) => [key, hydrateRows(model, data.source[table])])) } as unknown as RunCalculationInputs;
  const output: Record<string, DemoRow[]> = {};
  const models = { fgMonthly: 'FgMonthly', fgMonthlyPeriod: 'FgMonthlyPeriod', fgPlanSuggestion: 'FgPlanSuggestion', componentWeekly: 'ComponentWeekly', componentWeeklyPeriod: 'ComponentWeeklyPeriod', salesMeeting: 'SalesMeeting', salesMeetingPeriod: 'SalesMeetingPeriod' };
  const client: Record<string, unknown> = { appSetting: { findUnique: async () => ({ value: applySkipInventory }) }, $executeRaw: async () => 0 };
  let nextId = 1;
  for (const [table, model] of Object.entries(models)) {
    output[table] = [];
    client[table] = {
      deleteMany: async ({ where }: { where: DemoRow }) => { output[table] = output[table].filter((row) => !Object.entries(where).every(([key, value]) => row[key] === value)); return { count: 0 }; },
      createMany: async ({ data: rows }: { data: DemoRow[] }) => { output[table].push(...rows.map((row) => modelRow(model, { ...row, id: nextId++ }))); return { count: rows.length }; },
      findMany: async () => output[table],
    };
  }
  await calculationContext.run(client as unknown as PrismaClient, async () => {
    await progress('fg_monthly');
    const fg = await calculateFgMonthly(run.id, inputs);
    await progress('fg_aggregated');
    await calculateFgMonthlyAggregated(run.id, inputs, fg.aggregationSource);
    for (const kind of ['W', 'B', 'D'] as const) { await progress(`component_${kind.toLowerCase()}`); await calculateComponentWeekly(run.id, kind, inputs); }
    await progress('sales_meeting');
    await calculateSalesMeeting(run.id, inputs);
  });
  const serialize = (rows: DemoRow[]): DemoRow[] => JSON.parse(JSON.stringify(rows));
  data.fg = serialize(output.fgMonthly);
  data.cw = serialize(output.componentWeekly);
  data.sales = serialize(output.salesMeeting);
  const by = (rows: DemoRow[], key: string, aggregate = false): Record<string, DemoRow[]> => {
    const grouped: Record<string, DemoRow[]> = {};
    for (const row of serialize(rows)) { const id = String(row[key]) + (aggregate && row.isAggregated ? ':aggregate' : ''); (grouped[id] ??= []).push(row); }
    return grouped;
  };
  data.fgPeriods = by(output.fgMonthlyPeriod, 'partVersion', true);
  data.cwPeriods = by(output.componentWeeklyPeriod, 'materialPartNo');
  data.salesPeriods = by(output.salesMeetingPeriod, 'partVersion');
  return { data, suggestions: serialize(output.fgPlanSuggestion) };
}
