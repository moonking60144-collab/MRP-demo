import type { DemoDataset, DemoRow } from './data';
import { hydrateRows } from './calculator';
import { DemoError } from './run-control';
import { mutate, state } from './store';
import { requireLatest } from './operations';
import { ORDER_DEMAND_CONTRACT_V2, resolveOrderDemandContribution } from '../mrp/order-demand-contract';
import { attributeFgMonthlyOrderDemand, fgMonthlyOrderPeriodIndex, summarizeAttributedFgMonthlyOrders } from '../mrp/fg-monthly-source-detail';
import { dateToPeriodIndex, dateToWeekIndex, generateMonthlyPeriods, generateWeeklyPeriods } from '../mrp/period-utils';
import { summarizeComponentWeeklyUsage, matchesComponentWeeklyUsageType, isComponentWeeklyDateInScope, resolveComponentWeeklyMovementSummaryState } from '../mrp/component-weekly-usage';
import { isComponentWeeklyPurchaseOverdue } from '../mrp/component-weekly-purchase';
import { isMrpAvailableInventoryLot } from '../sync/inventory-snapshot';
import { isYe1Warehouse } from '../mrp/warehouse-stock';

const link = (row: DemoRow, type: string): DemoRow => ({ ...row, ragicUrl: row.ragicRecordId ? `/demo-record?type=${type}&id=${encodeURIComponent(String(row.ragicRecordId))}` : null });
export function sourceDetails(data: DemoDataset, partVersion: string, params: URLSearchParams, sales = false, all = false): unknown {
  const members: string[] = params.getAll('partVersion').length ? params.getAll('partVersion') : sales && params.has('memberPartVersions') ? JSON.parse(params.get('memberPartVersions')!) : [partVersion];
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string' || !data.source.part_versions.some((row) => row.partVersion === member))) throw new DemoError('來源客料版本無效。', 404);
  const parts = data.source.part_versions.filter((row) => members.includes(String(row.partVersion)));
  const erps = [...new Set(parts.map((row) => String(row.erpPartNo)))];
  const poolParts = data.source.part_versions.filter((row) => erps.includes(String(row.erpPartNo)));
  const periods = generateMonthlyPeriods(new Date(data.run.runDate), 12);
  const sourceOrders = data.source.orders.filter((row) => members.includes(String(row.partVersion)));
  const attributed = sourceOrders.map((row) => { const order = hydrateRows('StagingOrder', [row])[0]; const contribution = resolveOrderDemandContribution(order as unknown as Parameters<typeof resolveOrderDemandContribution>[0], ORDER_DEMAND_CONTRACT_V2); const attribution = attributeFgMonthlyOrderDemand(contribution, fgMonthlyOrderPeriodIndex(order as { designatedShipDate: Date | null }, periods), periods.length); return { ...link(row, 'order'), orderDemandContribution: contribution, orderDemandAttribution: attribution }; });
  const forecasts = data.source.forecasts.filter((row) => members.includes(String(row.partVersion)));
  const plans = data.source.production_plans.filter((row) => members.includes(String(row.partVersion)));
  const jobs = data.source.work_orders.filter((row) => members.includes(String(row.partVersion)));
  const boms = data.source.work_order_bom.filter((row) => jobs.some((job) => job.woNumber === row.woNumber));
  const summary = summarizeAttributedFgMonthlyOrders(attributed.map((row) => ({ contribution: row.orderDemandContribution, attribution: row.orderDemandAttribution })));
  const identity = { partVersion, runId: data.run.id, dbSource: params.get('dbSource'), contractVersion: ORDER_DEMAND_CONTRACT_V2, sourcePartVersions: members, partVersions: parts, erpPartNo: erps[0] ?? null, erpPartNos: erps };
  if (all) return { ...identity, inventory: data.source.inventory.filter((row) => erps.includes(String(row.erpPartNo))), orders: attributed, orderDemandSummary: summary, forecasts, workOrders: jobs, workOrderBoms: boms, productionPlans: plans.map((row) => link(row, 'production_plan')) };
  const type = params.get('type') ?? 'orders';
  if (sales) {
    const scope = params.get('scope') ?? 'week', index = Number(params.get('weekIndex') ?? 1);
    if (!['week', 'recent', 'all'].includes(scope) || !Number.isInteger(index) || index < 0 || index > 99) throw new DemoError('產銷來源範圍無效。');
    const weeks = generateWeeklyPeriods(new Date(data.run.runDate), 12);
    const inScope = (date: unknown) => { const week = dateToWeekIndex(date ? new Date(String(date)) : null, weeks); return scope === 'all' || scope === 'recent' && week != null && week <= 4 || scope === 'week' && week === index; };
    const orders = sourceOrders.filter((row) => inScope(row.designatedShipDate)).map((row) => link(row, 'order'));
    const selectedPlans = plans.filter((row) => inScope(row.completionDate)).map((row) => link(row, 'production_plan'));
    const item = data.sales.find((row) => row.partVersion === partVersion)!;
    const period = data.salesPeriods[partVersion]?.find((row) => row.weekIndex === index) ?? null;
    const poolDemand = data.source.orders.filter((row) => poolParts.some((part) => part.partVersion === row.partVersion) && inScope(row.designatedShipDate)).reduce((sum, row) => sum + Number(row.unshippedQty), 0);
    const demand = orders.reduce((sum, row) => sum + Number(row.unshippedQty), 0);
    return { ...identity, type, scope, customerPartNo: parts[0]?.customerPartNo ?? null, memberPartVersions: members, weekLabel: scope === 'all' ? '全部' : scope === 'recent' ? '前期＋4週' : period?.weekLabel ?? '前期', sharedPool: { isShared: poolParts.length > 1, isDisplayOwner: poolParts[0]?.partVersion === partVersion, members: poolParts.map((row) => ({ partVersion: row.partVersion, customerCode: row.customerCode })) }, summary: { goodStockPc: item.goodStockPc, goodStockKg: item.goodStockKg, wfgStockPc: item.wfgStockPc, ye1StockPc: item.ye1StockPc }, period, previousRemainingStock: index === 0 ? item.goodStockPc : data.salesPeriods[partVersion]?.find((row) => row.weekIndex === index - 1)?.remainingStock ?? null, summaryBalance: scope === 'week' ? null : { demand, remainingStock: Number(item.goodStockPc) - poolDemand, includesProductionPlans: false, members: members.map((member) => ({ partVersion: member, demand: orders.filter((row) => row.partVersion === member).reduce((sum, row) => sum + Number(row.unshippedQty), 0), remainingStock: Number(item.goodStockPc) - poolDemand })) }, orders, productionPlans: selectedPlans };
  }
  const index = params.has('periodIndex') ? Number(params.get('periodIndex')) : null;
  if (index !== null && (!Number.isInteger(index) || index < -1 || index > 11)) throw new DemoError('來源月份無效。');
  let records: DemoRow[];
  if (type === 'orders') records = attributed.filter((row) => index == null ? row.orderDemandAttribution.status === 'included_period' || row.orderDemandAttribution.status === 'included_prior' : row.orderDemandAttribution.periodIndex === index);
  else if (type === 'inventory') records = data.source.inventory.filter((row) => erps.includes(String(row.erpPartNo)));
  else if (type === 'forecasts' || type === 'production_plans') { const dateKey = type === 'forecasts' ? 'forecastStart' : 'completionDate'; records = (type === 'forecasts' ? forecasts : plans).filter((row) => index == null || row[dateKey] && dateToPeriodIndex(new Date(String(row[dateKey])), periods) === index); }
  else if (type === 'work_orders') { const metric = params.get('metric'); records = jobs.filter((row) => row.subProcessCode === 'HF01' && (metric !== 'woScheduled' || !['99', '', null].includes(row.jobOrderCode as string | null)) && (metric !== 'woUnscheduled' || ['99', '', null].includes(row.jobOrderCode as string | null))); }
  else throw new DemoError('來源類別無效。');
  const priorRecords = index === 0 ? attributed.filter((row) => row.orderDemandAttribution.status === 'included_prior') : [];
  return { ...identity, type, metric: params.get('metric'), partVersions: members, records, priorRecords, total: records.length, periodIndex: index, summary: type === 'orders' ? summarizeAttributedFgMonthlyOrders((records as typeof attributed).map((row) => ({ contribution: row.orderDemandContribution, attribution: row.orderDemandAttribution }))) : undefined, priorSummary: summarizeAttributedFgMonthlyOrders(priorRecords.map((row) => ({ contribution: row.orderDemandContribution, attribution: row.orderDemandAttribution }))) };
}
export function warehouseDetail(data: DemoDataset, params: URLSearchParams): unknown {
  const warehouse = params.get('warehouse') ?? 'INTERNAL', partVersion = params.get('partVersion');
  if (!['INTERNAL', 'YE1'].includes(warehouse)) throw new DemoError('倉庫無效。');
  const part = data.fg.find((row) => row.partVersion === partVersion && row.isAggregated === (params.get('aggregated') === 'true'));
  if (!part) throw new DemoError('找不到合成庫存料號。', 404);
  const members = part.isAggregated ? part.aggregatedMembers as string[] : [String(part.partVersion)];
  const erps = [...new Set(data.source.part_versions.filter((row) => members.includes(String(row.partVersion))).map((row) => String(row.erpPartNo)))];
  const lots: DemoRow[] = data.source.inventory_lots.filter((row) => erps.includes(String(row.erpPartNo)) && isYe1Warehouse(String(row.warehouseCode ?? '')) === (warehouse === 'YE1')).map((row) => ({ ...link(row, 'inventory_lot'), includedInMrp: isMrpAvailableInventoryLot({ stockStatus: row.stockStatus, qualityStatus: row.qualityStatus }), sourceWorkOrderRagicUrl: null }));
  const totalPc = lots.reduce((sum, row) => sum + Number(row.stockPc), 0), totalKg = lots.reduce((sum, row) => sum + Number(row.stockKg), 0);
  const available = lots.filter((row) => row.includedInMrp), availablePc = available.reduce((sum, row) => sum + Number(row.stockPc), 0), availableKg = available.reduce((sum, row) => sum + Number(row.stockKg), 0);
  const qualitySummaries = [...new Set(lots.map((row) => row.qualityStatus))].map((qualityStatus) => { const group = lots.filter((row) => row.qualityStatus === qualityStatus); return { qualityStatus, lotCount: group.length, stockPc: group.reduce((sum, row) => sum + Number(row.stockPc), 0), stockKg: group.reduce((sum, row) => sum + Number(row.stockKg), 0), includedInMrp: group.some((row) => row.includedInMrp) }; });
  return { warehouse: { code: warehouse, name: warehouse === 'YE1' ? 'YE1 展示交貨倉' : '廠內 HD' }, erpPartNos: erps, totalPc, totalKg, availablePc, availableKg, excludedPc: totalPc - availablePc, excludedKg: totalKg - availableKg, inventoryValidationAvailable: true, inventoryAnomalyCount: available.filter((row) => row.quantityAnomaly).length, qualitySummaries, lots };
}
export function usageDetail(data: DemoDataset, materialPartNo: string, params: URLSearchParams): unknown {
  const type = params.get('mrpType') ?? 'W';
  const item = data.cw.find((row) => row.materialPartNo === materialPartNo && row.mrpType === type);
  if (!item) throw new DemoError('找不到合成元件。', 404);
  const index = params.get('weekIndex') === 'all' || !params.has('weekIndex') ? null : Number(params.get('weekIndex'));
  if (index !== null && (!Number.isInteger(index) || index < 0 || index > 28)) throw new DemoError('元件週別無效。');
  const periods = data.cwPeriods[materialPartNo];
  const expectedUsage = periods.filter((row) => index === null || row.weekIndex === index).reduce((sum, row) => sum + Number(row.usage), 0);
  const weeks = generateWeeklyPeriods(new Date(data.run.runDate), 28);
  const bomRows = hydrateRows('StagingWorkOrderBom', data.source.work_order_bom).filter((row) => matchesComponentWeeklyUsageType({ sourceType: row.sourceType as string | null, processCode: row.processCode as string | null }, type as 'W' | 'B' | 'D'));
  const result = summarizeComponentWeeklyUsage({ materialPartNo, weekIndex: index, weeks, expectedUsage, expectedUnit: String(item.unit), enforceUnitConsistency: type === 'W', bomRows, workOrders: hydrateRows('StagingWorkOrder', data.source.work_orders) } as unknown as Parameters<typeof summarizeComponentWeeklyUsage>[0]);
  const inventory = data.source.inventory.find((row) => row.erpPartNo === materialPartNo)!;
  const master = Object.hasOwn(state().leadTimes, materialPartNo) ? state().leadTimes[materialPartNo] : inventory.purchaseLeadWeeksConfigured === false ? null : Number(inventory.purchaseLeadWeeks);
  const initialStock = Number(type === 'W' ? item.goodStockKg : item.goodStockPc);
  let priorEnding = initialStock;
  const projection = periods.map((row) => { const openingStock = priorEnding; const calculatedEndingStock = openingStock + Number(row.receipts) - Number(row.usage); const endingStock = row.remainingStock == null ? calculatedEndingStock : Number(row.remainingStock); priorEnding = endingStock; return { ...row, openingStock, calculatedEndingStock, endingStock, difference: endingStock - calculatedEndingStock }; });
  const summaryRows = [...result.included, ...result.excluded].filter((row) => row.reason !== 'unit_mismatch' && row.reason !== 'unlinked_work_order');
  const sumComplete = (key: 'grossIssuedQty' | 'consumedQty' | 'returnedQty' | 'netIssuedQty' | 'reservedQty' | 'remainingUsage') => summaryRows.some((row) => row[key] === null) ? null : summaryRows.reduce((sum, row) => sum + Number(row[key]), 0);
  const purchaseOrders = data.source.purchase_orders.filter((row) => row.productNo === materialPartNo).map((row) => {
    const delivery = row.deliveryDate ? new Date(String(row.deliveryDate)) : null;
    const isOverdue = isComponentWeeklyPurchaseOverdue(delivery, new Date(data.run.runDate));
    const arrivesAfterShortage = !!delivery && (item.shortageStartWeek === 0 || !!item.shortageStartDate && delivery > new Date(String(item.shortageStartDate)));
    const positive = Number(row.unreceivedQty) > 0;
    return { ...row, unreceivedQty: Number(row.unreceivedQty), isOverdue, arrivesAfterShortage, countsAsProjectedSupply: !!delivery && !isOverdue && positive, requiresExpedite: (isOverdue || arrivesAfterShortage) && positive, inSelectedScope: isComponentWeeklyDateInScope(delivery, weeks, index) };
  });
  return { materialPartNo, mrpType: type, runId: data.run.id, dbSource: params.get('dbSource'), runVersionCode: data.run.versionCode, runDate: data.run.runDate, usesLegacyPurchaseProjection: false, weekIndex: index, weekLabel: index === null ? null : periods.find((row) => row.weekIndex === index)?.weekLabel ?? null, weekStart: index === null ? null : periods.find((row) => row.weekIndex === index)?.weekStart ?? null, inventorySource: { ragicRecordId: inventory.ragicRecordId, erpPartNo: materialPartNo, purchaseLeadWeeks: master ?? 0, purchaseLeadWeeksConfigured: master !== null, ambiguous: false, candidateCount: 1 }, materialSummary: { ...item, initialStock, badStock: Number(type === 'W' ? item.badStockKg : item.badStockPc), supplyQty: periods.filter((row) => index === null || row.weekIndex === index).reduce((sum, row) => sum + Number(row.receipts), 0), plannedUsage: summaryRows.reduce((sum, row) => sum + row.plannedUsage, 0), ...Object.fromEntries((['grossIssuedQty', 'consumedQty', 'returnedQty', 'netIssuedQty', 'reservedQty', 'remainingUsage'] as const).map((key) => [key, sumComplete(key)])), overIssuedQty: summaryRows.reduce((sum, row) => sum + row.overIssuedQty, 0), movementState: resolveComponentWeeklyMovementSummaryState(summaryRows.map((row) => row.movementState)), expeditePurchaseQty: purchaseOrders.filter((row) => row.requiresExpedite).reduce((sum, row) => sum + Number(row.unreceivedQty), 0), expeditePurchaseCount: purchaseOrders.filter((row) => row.requiresExpedite).length }, weeklyProjection: projection, inventoryLots: data.source.inventory_lots.filter((row) => row.erpPartNo === materialPartNo), purchaseOrders, supplyWorkOrders: data.source.work_orders.filter((row) => row.erpPartNo === materialPartNo && isComponentWeeklyDateInScope(row.endDate ? new Date(String(row.endDate)) : null, weeks, index)), movements: [], movementContext: [], unscheduledDemand: { count: result.included.filter((row) => row.dateSource === 'missing').length, qty: result.included.filter((row) => row.dateSource === 'missing').reduce((sum, row) => sum + Number(row.remainingUsage), 0) }, ...result };
}
export function updateLeadTime(data: DemoDataset, material: string, params: URLSearchParams, body: DemoRow): unknown {
  requireLatest(data.run.id);
  const mrpType = params.get('mrpType');
  if (mrpType !== 'W' && mrpType !== 'B') throw new DemoError('僅 W/B 支援採購前置週數。');
  const row = data.source.inventory.find((item) => item.erpPartNo === material && item.ragicRecordId === body.ragicRecordId);
  if (!row) throw new DemoError('合成料號主檔身分不符。', 409);
  const value = body.purchaseLeadWeeks;
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 260)) throw new DemoError('採購前置週數必须是 null 或 0～260 整數。');
  const previous = Object.hasOwn(state().leadTimes, material) ? state().leadTimes[material] : row.purchaseLeadWeeksConfigured === false ? null : Number(row.purchaseLeadWeeks);
  const configured = previous !== null;
  if ((previous ?? 0) !== body.expectedPurchaseLeadWeeks || configured !== body.expectedConfigured) throw new DemoError('合成主檔已變動，請重新開啟明細確認。', 409);
  mutate((draft) => { draft.leadTimes[material] = value as number | null; });
  return { materialPartNo: material, ragicRecordId: row.ragicRecordId, runId: data.run.id, runVersionCode: data.run.versionCode, previousPurchaseLeadWeeks: previous ?? 0, previousConfigured: configured, purchaseLeadWeeks: value ?? 0, purchaseLeadWeeksConfigured: value !== null, updated: value !== previous, reconciled: false, currentRunUnchanged: true, requiresNewRun: value !== previous };
}
