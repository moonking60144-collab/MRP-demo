import type { ComponentWeeklyItem } from '@/components/component-weekly-traditional';
import type { ComponentWeeklyPeriodDetail } from '../mrp/component-weekly-periods';
import { componentWeeklyRowKey } from '../mrp/component-weekly-periods';
import type { SalesMeetingItem, SalesMeetingPeriodDetail } from '../mrp/sales-meeting-types';
import type { ArchiveWeeklyReport } from './weekly-report-contract';
import { archiveFgCamel } from './fg-report-contract';

const textFields = new Set(['materialPartNo', 'mrpType', 'unit', 'partVersion', 'customerPartNo', 'customerCode', 'erpPartNo', 'weekLabel', 'weekStart', 'purchaseAction', 'shortageStartDate', 'orderByDate', 'nextPurchaseReceiptDate', 'fgStatus04']);
const names: Record<string, string> = { outstanding_0_4: 'outstanding04', fg_diff_0_4: 'fgDiff04', fg_status_0_4: 'fgStatus04' };
function convert(row: Record<string, string | null>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const name = names[key] ?? archiveFgCamel(key);
    return [name, value === null || textFields.has(name) ? value : name === 'purchaseLeadWeeksConfigured' ? value === 'true' : Number(value)];
  }));
}

export function adaptArchiveWeeklyReport(report: ArchiveWeeklyReport) {
  const component = report.kind === 'component';
  const identityField = component ? 'material_part_no' : 'part_version';
  const identities = new Map<string, string>();
  const items = report.rows.map(row => {
    if (row.mrp_run_id !== String(report.run.sourceRunId) || !row[identityField] || (component && row.mrp_type !== report.mrpType)) throw new Error('歷史週推版本不一致');
    const item = convert(row);
    const key = component ? componentWeeklyRowKey(item as unknown as ComponentWeeklyItem) : row.part_version!;
    if (identities.has(row[identityField]!)) throw new Error('歷史週推料號重複');
    identities.set(row[identityField]!, key);
    return component ? item : { ...item, memberPartVersions: [row.part_version], sharedErpCount: 1,
      inventoryValidationAvailable: false, inventoryAnomalyCount: null,
      wfgInventoryAnomalyCount: 0, ye1InventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [],
      wfgStockPc: report.warehouseAvailable ? item.wfgStockPc : null, ye1StockPc: report.warehouseAvailable ? item.ye1StockPc : null };
  });
  const periods: Record<string, Array<ComponentWeeklyPeriodDetail & SalesMeetingPeriodDetail>> = Object.create(null);
  const seen = new Set<string>();
  for (const row of report.periods) {
    const key = identities.get(row[identityField]!);
    const index = Number(row.week_index);
    if (!key || row.mrp_run_id !== String(report.run.sourceRunId) || (component && row.mrp_type !== report.mrpType) || row.week_index === null || !Number.isInteger(index) || index < 0 || index >= 100) throw new Error('歷史週期身份或索引無效');
    if (seen.has(`${key}\u0000${index}`)) throw new Error('歷史週期重複');
    seen.add(`${key}\u0000${index}`);
    const list = periods[key] ?? [];
    while (list.length <= index) list.push({ weekIndex: list.length, weekLabel: list.length === 0 ? '前期' : `W${list.length}`, weekStart: null, remainingStock: null, usage: null, receipts: null, demand: null, supply: null } as unknown as ComponentWeeklyPeriodDetail & SalesMeetingPeriodDetail);
    list[index] = convert(row) as unknown as ComponentWeeklyPeriodDetail & SalesMeetingPeriodDetail;
    periods[key] = list;
  }
  return { componentItems: items as unknown as ComponentWeeklyItem[], salesItems: items as unknown as SalesMeetingItem[],
    snapshot: { periods, missingFields: [...report.missingFields, ...(!component ? ['inventoryAnomalyCount'] : [])], label: `${report.run.versionCode}_Run${report.run.sourceRunId}` } };
}
