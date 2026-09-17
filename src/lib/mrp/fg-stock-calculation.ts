export type StockBalanceKind = 'withPlan' | 'withoutPlan';

export interface StockCalculationPeriod {
  periodLabel: string;
  remainingStock: number;
  remainingNoPlan: number;
  demandIntegrated: number;
  plannedOutput: number;
}

export interface StockCalculationDetail {
  partVersion: string;
  erpPartNo: string | null;
  periodLabel: string;
  balanceKind: StockBalanceKind;
  calculationMode: 'direct' | 'shared' | 'aggregated';
  sharedErpCount: number;
  balance: number;
  openingBalance: number | null;
  openingLabel: string;
  plannedOutput: number;
  demandIntegrated: number;
  calculatedBalance: number | null;
  reconciled: boolean;
  initialTerms: Array<{ label: string; operator: '+' | '-'; value: number }>;
}

export function buildStockCalculationDetail(input: {
  partVersion: string;
  erpPartNo: string | null;
  periodIndex: number;
  balanceKind: StockBalanceKind;
  currentStockPc: number;
  priorUnshippedQty: number;
  priorPlanQty: number;
  periods: StockCalculationPeriod[];
  usesSharedErpPool: boolean;
  sharedErpCount: number;
  isAggregated?: boolean;
}): StockCalculationDetail {
  const period = input.periods[input.periodIndex];
  if (!period) throw new Error(`找不到第 ${input.periodIndex + 1} 期庫存資料`);

  const withPlan = input.balanceKind === 'withPlan';
  const balance = Number(withPlan ? period.remainingStock : period.remainingNoPlan) || 0;
  const demandIntegrated = Number(period.demandIntegrated) || 0;
  const plannedOutput = withPlan ? Number(period.plannedOutput) || 0 : 0;
  const calculationMode = input.isAggregated
    ? 'aggregated'
    : input.usesSharedErpPool
      ? 'shared'
      : 'direct';

  if (calculationMode === 'aggregated') {
    return {
      partVersion: input.partVersion,
      erpPartNo: input.erpPartNo,
      periodLabel: period.periodLabel,
      balanceKind: input.balanceKind,
      calculationMode,
      sharedErpCount: input.sharedErpCount,
      balance,
      openingBalance: null,
      openingLabel: '聚合成員期末餘額合計',
      plannedOutput,
      demandIntegrated,
      calculatedBalance: null,
      reconciled: true,
      initialTerms: [],
    };
  }

  if (calculationMode === 'shared') {
    const openingBalance = balance + demandIntegrated;
    return {
      partVersion: input.partVersion,
      erpPartNo: input.erpPartNo,
      periodLabel: period.periodLabel,
      balanceKind: input.balanceKind,
      calculationMode,
      sharedErpCount: input.sharedErpCount,
      balance,
      openingBalance,
      openingLabel: '本列扣用前共享池餘額',
      plannedOutput: 0,
      demandIntegrated,
      calculatedBalance: openingBalance - demandIntegrated,
      reconciled: true,
      initialTerms: [],
    };
  }

  const firstPeriod = input.periodIndex === 0;
  const previous = input.periods[input.periodIndex - 1];
  const initialTerms = firstPeriod
    ? [
        { label: '可用成品庫存', operator: '+' as const, value: Number(input.currentStockPc) || 0 },
        { label: '前期 MRP 未出庫需求', operator: '-' as const, value: Number(input.priorUnshippedQty) || 0 },
        ...(withPlan
          ? [{ label: '前期未結生產計畫', operator: '+' as const, value: Number(input.priorPlanQty) || 0 }]
          : []),
      ]
    : [];
  const openingBalance = firstPeriod
    ? initialTerms.reduce(
        (total, term) => total + (term.operator === '+' ? term.value : -term.value),
        0,
      )
    : Number(withPlan ? previous?.remainingStock : previous?.remainingNoPlan) || 0;
  const calculatedBalance = openingBalance + plannedOutput - demandIntegrated;

  return {
    partVersion: input.partVersion,
    erpPartNo: input.erpPartNo,
    periodLabel: period.periodLabel,
    balanceKind: input.balanceKind,
    calculationMode,
    sharedErpCount: input.sharedErpCount,
    balance,
    openingBalance,
    openingLabel: firstPeriod
      ? '首期期初可用量'
      : `上期${withPlan ? '剩餘庫存' : '剩餘庫存（無計劃）'}`,
    plannedOutput,
    demandIntegrated,
    calculatedBalance,
    reconciled: Math.abs(calculatedBalance - balance) < 0.001,
    initialTerms,
  };
}
