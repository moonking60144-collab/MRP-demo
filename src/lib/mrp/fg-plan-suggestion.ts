export interface FulfillmentPeriodBalance {
  remainingStock: number;
  demandIntegrated: number;
}

export function canAutoRecalculatePlanQty(usesSharedErpPool: boolean): boolean {
  return !usesSharedErpPool;
}

export function computeMaterialKg(qty: number, mainMaterialKg: number, unitWeightG: number): number {
  if (mainMaterialKg > 0) return qty * mainMaterialKg;
  if (unitWeightG > 0) return (qty * unitWeightG) / 1000;
  return 0;
}

export function ceilPlanQty(value: number): number {
  // 去掉二進位浮點的微小尾差，不吞掉真正需要向上進位的小數需求。
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.ceil(value - tolerance);
}

export function computeFulfillmentPlanQty(
  periods: FulfillmentPeriodBalance[],
  fulfillPeriod: number,
  bufferPct: number,
  priorPlannedQty: number,
): number {
  if (fulfillPeriod <= 0 || periods.length === 0) return 0;

  const wholePeriodIdx = Math.floor(fulfillPeriod) - 1;
  const fraction = fulfillPeriod - Math.floor(fulfillPeriod);
  if (wholePeriodIdx < 0 || wholePeriodIdx >= periods.length) return 0;

  let shortage = -periods[wholePeriodIdx].remainingStock;
  if (fraction > 0 && wholePeriodIdx + 1 < periods.length) {
    shortage += fraction * periods[wholePeriodIdx + 1].demandIntegrated;
  }

  shortage -= priorPlannedQty;
  return Math.max(0, ceilPlanQty(shortage * (1 + bufferPct / 100)));
}
