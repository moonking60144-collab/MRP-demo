export interface SalesMeetingGroupableRow {
  [key: string]: unknown;
  id: number;
  mrpRunId: number;
  customerCode: string | null;
  customerPartNo: string | null;
  partVersion: string;
  erpPartNo: string | null;
  unit: string | null;
  goodStockPc: number;
  goodStockKg: number;
  mainStockPc: number | null;
  auxStockPc: number | null;
  badStockPc: number;
  badStockKg: number;
  avgDemandPerWeek: number;
  stockWeeks: number;
  shortageStartWeek: number | null;
  purchaseLeadWeeks: number;
  outstanding04: number;
  fgDiff04: number;
  fgStatus04: string | null;
  totalOrderDemand: number;
  totalFgDiff: number;
  dbSource?: string;
  inventoryAnomalyCount?: number;
}

export type SalesMeetingDisplayRow<T extends SalesMeetingGroupableRow> = T & {
  memberPartVersions: string[];
};

function displayGroupKey(row: SalesMeetingGroupableRow): string {
  const customerPartNo = row.customerPartNo?.trim() || row.partVersion.trim();
  return [
    row.dbSource || '',
    String(row.mrpRunId),
    row.customerCode?.trim() || '',
    customerPartNo,
    row.erpPartNo?.trim() || '',
  ].join('\u0000');
}

function minimumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

export function groupSalesMeetingRows<T extends SalesMeetingGroupableRow>(
  rows: readonly T[],
): Array<SalesMeetingDisplayRow<T>> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = displayGroupKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const members = [...group].sort((left, right) => left.partVersion.localeCompare(right.partVersion));
    const representative = members[0]!;
    const outstanding04 = members.reduce((sum, row) => sum + row.outstanding04, 0);
    const fgDiff04 = Math.min(...members.map((row) => row.fgDiff04));
    return {
      ...representative,
      customerPartNo: representative.customerPartNo?.trim() || representative.partVersion,
      memberPartVersions: members.map((row) => row.partVersion),
      avgDemandPerWeek: members.reduce((sum, row) => sum + row.avgDemandPerWeek, 0),
      shortageStartWeek: minimumNullable(members.map((row) => row.shortageStartWeek)),
      purchaseLeadWeeks: Math.max(...members.map((row) => row.purchaseLeadWeeks)),
      outstanding04,
      fgDiff04,
      fgStatus04: outstanding04 === 0 ? '無訂單' : fgDiff04 < 0 ? '不足' : '足夠',
      totalOrderDemand: members.reduce((sum, row) => sum + row.totalOrderDemand, 0),
      totalFgDiff: Math.min(...members.map((row) => row.totalFgDiff)),
    };
  });
}

export function expandSalesMeetingFacetRows<T extends SalesMeetingDisplayRow<SalesMeetingGroupableRow>>(
  rows: readonly T[],
  columnId: string,
): Array<T | { partVersion: string }> {
  if (columnId !== 'partVersion') return [...rows];
  return rows.flatMap((row) => (
    row.memberPartVersions.map((partVersion) => ({ partVersion }))
  ));
}

export interface SalesMeetingPeriodGroupableRow {
  id: number;
  mrpRunId: number;
  partVersion: string;
  weekIndex: number;
  weekLabel: string | null;
  weekStart: Date | string | null;
  remainingStock: number | null;
  demand: number;
  supply: number;
}

export function groupSalesMeetingPeriods<T extends SalesMeetingPeriodGroupableRow>(
  rows: readonly T[],
  displayPartVersion: string,
): T[] {
  const periods = new Map<number, T[]>();
  for (const row of rows) {
    const period = periods.get(row.weekIndex) || [];
    period.push(row);
    periods.set(row.weekIndex, period);
  }

  return [...periods.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, periodRows]) => {
      const representative = periodRows.find((row) => row.partVersion === displayPartVersion)
        || periodRows[0]!;
      return {
        ...representative,
        partVersion: displayPartVersion,
        demand: periodRows.reduce((sum, row) => sum + row.demand, 0),
        supply: periodRows.reduce((sum, row) => sum + row.supply, 0),
        remainingStock: minimumNullable(periodRows.map((row) => row.remainingStock)),
      };
    });
}

export function buildSalesMeetingPeriodMap<T extends SalesMeetingPeriodGroupableRow>(
  rows: readonly T[],
  groups: readonly { partVersion: string; memberPartVersions: readonly string[] }[],
): Record<string, T[]> {
  const groupPeriods = new Map(groups.map((group) => [group.partVersion, [] as T[]]));
  const groupsByMember = new Map<string, string[]>();
  for (const group of groups) {
    for (const member of group.memberPartVersions) {
      const displayPartVersions = groupsByMember.get(member) || [];
      displayPartVersions.push(group.partVersion);
      groupsByMember.set(member, displayPartVersions);
    }
  }
  for (const row of rows) {
    for (const displayPartVersion of groupsByMember.get(row.partVersion) || []) {
      groupPeriods.get(displayPartVersion)!.push(row);
    }
  }
  return Object.fromEntries(groups.map((group) => [
    group.partVersion,
    groupSalesMeetingPeriods(groupPeriods.get(group.partVersion) || [], group.partVersion),
  ]));
}
