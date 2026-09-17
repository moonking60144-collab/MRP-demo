const FG_DECIMAL_FIELDS = [
  'stockPeriods', 'unitWeightG', 'mainMaterialKg', 'currentStockPc', 'mainStockPc', 'auxStockPc', 'badStockPc',
  'woScheduled', 'woUnscheduled', 'woTotal', 'planReportedQty', 'planClosedQty',
  'priorUnshippedQty', 'totalUnshippedQty', 'totalPlanSupply', 'priorPlanQty', 'period1PlanQty',
];

export function normalizeFgMonthlyDecimals(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...row };
  for (const field of FG_DECIMAL_FIELDS) {
    if (normalized[field] != null) normalized[field] = Number(normalized[field]);
  }
  return normalized;
}
