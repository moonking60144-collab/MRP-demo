import type { FgMonthlyItem, PeriodDetail } from '@/components/fg-monthly-traditional';
import { archiveFgCamel, type ArchiveFgReport } from './fg-report-contract';

const textFields = new Set(['partVersion', 'customerPartNo', 'customerCode', 'erpPartNo', 'forgingMachine', 'firstProcess', 'surfaceTreatment', 'forgingParent', 'processBomVersion', 'productStatus', 'periodLabel', 'periodStart', 'periodEnd']);
const booleanFields = new Set(['skipFgInventory', 'shouldPlanProduction', 'isAggregated']);

function convert(row: Record<string, string | null>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const name = archiveFgCamel(key);
    return [name, value === null || textFields.has(name) ? value : booleanFields.has(name) ? value === 'true' : Number(value)];
  }));
}

export function adaptArchiveFgReport(report: ArchiveFgReport) {
  const periods: Record<string, PeriodDetail[]> = Object.create(null);
  const partVersions = new Set(report.rows.map(row => row.part_version));
  const identities = new Set<string>();
  for (const raw of report.periods) {
    if (raw.mrp_run_id !== String(report.run.sourceRunId) || raw.is_aggregated !== String(report.aggregated) || !partVersions.has(raw.part_version)) throw new Error('歷史月份與選取版本不一致');
    const index = Number(raw.period_index);
    if (raw.period_index === null || !Number.isInteger(index) || index < 0 || index >= 100) throw new Error('歷史月份索引無效');
    const identity = `${raw.part_version}\u0000${index}`;
    if (identities.has(identity)) throw new Error('歷史月份資料重複');
    identities.add(identity);
    const converted = convert(raw);
    const list = periods[raw.part_version!] ?? [];
    // Keep null quantities and missing month positions; TraditionalView's snapshot path renders them as unknown.
    while (list.length <= index) list.push({ periodIndex: list.length, periodLabel: `M${list.length + 1}`, remainingStock: null, remainingNoPlan: null, demandIntegrated: null, ordersUnshipped: null, ordersTotal: null, forecastQty: null, plannedOutput: null } as unknown as PeriodDetail);
    list[index] = { ...converted, periodLabel: raw.period_label ?? `M${index + 1}` } as unknown as PeriodDetail;
    periods[raw.part_version!] = list;
  }
  const missingFields = [...new Set([...report.missingFields, 'inventoryAnomalyCount'])];
  const items = report.rows.map(raw => {
    if (raw.mrp_run_id !== String(report.run.sourceRunId) || raw.is_aggregated !== String(report.aggregated)) throw new Error('歷史資料與選取版本不一致');
    const item = convert(raw);
    const ownPeriods = periods[raw.part_version!] ?? [];
    return { ...item,
      sharedErpCount: report.aggregated ? 1 : Number(raw.shared_erp_count ?? 1),
      usesSharedErpPool: false,
      inventoryValidationAvailable: false, inventoryAnomalyCount: null,
      wfgInventoryAnomalyCount: 0, ye1InventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [],
      wfgStockPc: report.warehouseAvailable ? item.wfgStockPc : null,
      ye1StockPc: report.warehouseAvailable ? item.ye1StockPc : null,
      lastPeriodRemainingNoPlan: ownPeriods.at(-1)?.remainingNoPlan ?? null,
    } as unknown as FgMonthlyItem;
  });
  return { items, snapshot: { periods, missingFields, label: `${report.run.versionCode}_Run${report.run.sourceRunId}` } };
}
