const SUM_FIELDS = [
  'plannedOutput',
  'demandIntegrated',
  'forecastQty',
  'ordersUnshipped',
  'ordersTotal',
] as const;

type SumField = typeof SUM_FIELDS[number];

export interface FgMonthlyTotalsSummaryRow {
  partVersion: string;
  erpPartNo: string | null;
}

export interface FgMonthlyTotalsPeriodRow {
  partVersion: string;
  periodIndex: number;
  remainingStock: unknown;
  remainingNoPlan: unknown;
  plannedOutput: unknown;
  demandIntegrated: unknown;
  forecastQty: unknown;
  ordersUnshipped: unknown;
  ordersTotal: unknown;
}

export interface FgMonthlyPeriodTotal extends Record<SumField, number | null> {
  periodIndex: number;
  remainingStock: number | null;
  remainingNoPlan: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addNullable(current: number | null, value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? current : (current ?? 0) + number;
}

function minimumNullable(current: number | null, value: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null) return current;
  return current === null ? number : Math.min(current, number);
}

function emptyPeriodTotal(periodIndex: number): FgMonthlyPeriodTotal {
  return {
    periodIndex,
    plannedOutput: null,
    demandIntegrated: null,
    forecastQty: null,
    ordersUnshipped: null,
    ordersTotal: null,
    remainingStock: null,
    remainingNoPlan: null,
  };
}

export function aggregateFgMonthlyPeriodTotals(
  summaries: readonly FgMonthlyTotalsSummaryRow[],
  periods: readonly FgMonthlyTotalsPeriodRow[],
): FgMonthlyPeriodTotal[] {
  const poolByPartVersion = new Map(summaries.map((summary) => [
    summary.partVersion,
    summary.erpPartNo?.trim() || summary.partVersion,
  ]));
  const totalsByPeriod = new Map<number, FgMonthlyPeriodTotal>();
  const balancesByPeriodPool = new Map<string, {
    periodIndex: number;
    remainingStock: number | null;
    remainingNoPlan: number | null;
  }>();

  for (const period of periods) {
    const poolKey = poolByPartVersion.get(period.partVersion);
    if (!poolKey) continue;

    const total = totalsByPeriod.get(period.periodIndex) || emptyPeriodTotal(period.periodIndex);
    for (const field of SUM_FIELDS) {
      total[field] = addNullable(total[field], period[field]);
    }
    totalsByPeriod.set(period.periodIndex, total);

    const balanceKey = `${period.periodIndex}\u0000${poolKey}`;
    const balance = balancesByPeriodPool.get(balanceKey) || {
      periodIndex: period.periodIndex,
      remainingStock: null,
      remainingNoPlan: null,
    };
    balance.remainingStock = minimumNullable(balance.remainingStock, period.remainingStock);
    balance.remainingNoPlan = minimumNullable(balance.remainingNoPlan, period.remainingNoPlan);
    balancesByPeriodPool.set(balanceKey, balance);
  }

  for (const balance of balancesByPeriodPool.values()) {
    const total = totalsByPeriod.get(balance.periodIndex);
    if (!total) continue;
    total.remainingStock = addNullable(total.remainingStock, balance.remainingStock);
    total.remainingNoPlan = addNullable(total.remainingNoPlan, balance.remainingNoPlan);
  }

  return [...totalsByPeriod.values()].sort((left, right) => left.periodIndex - right.periodIndex);
}
