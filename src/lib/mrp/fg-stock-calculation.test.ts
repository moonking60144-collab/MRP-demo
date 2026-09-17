import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStockCalculationDetail, type StockCalculationPeriod } from './fg-stock-calculation';

const periods: StockCalculationPeriod[] = [
  { periodLabel: '2026/07', remainingStock: 10_507, remainingNoPlan: -32_200, demandIntegrated: 40_000, plannedOutput: 0 },
  { periodLabel: '2026/08', remainingStock: 10_507, remainingNoPlan: -32_200, demandIntegrated: 0, plannedOutput: 0 },
  { periodLabel: '2026/09', remainingStock: 10_507, remainingNoPlan: -32_200, demandIntegrated: 0, plannedOutput: 0 },
  { periodLabel: '2026/10', remainingStock: -6_493, remainingNoPlan: -112_200, demandIntegrated: 80_000, plannedOutput: 63_000 },
];

test('首期剩餘庫存顯示可用庫存、前期訂單與前期計畫的完整算式', () => {
  const detail = buildStockCalculationDetail({
    partVersion: 'VS-1A021303', erpPartNo: '241332-V02-14PA', periodIndex: 0,
    balanceKind: 'withPlan', currentStockPc: 7_800, priorUnshippedQty: 0,
    priorPlanQty: 42_707, periods, usesSharedErpPool: false, sharedErpCount: 1,
  });

  assert.equal(detail.openingBalance, 50_507);
  assert.equal(detail.calculatedBalance, 10_507);
  assert.equal(detail.balance, 10_507);
  assert.equal(detail.reconciled, true);
});

test('後續期剩餘庫存以前期餘額加本期計畫再扣需求', () => {
  const detail = buildStockCalculationDetail({
    partVersion: 'VS-1A021303', erpPartNo: '241332-V02-14PA', periodIndex: 3,
    balanceKind: 'withPlan', currentStockPc: 7_800, priorUnshippedQty: 0,
    priorPlanQty: 42_707, periods, usesSharedErpPool: false, sharedErpCount: 1,
  });

  assert.equal(detail.openingBalance, 10_507);
  assert.equal(detail.plannedOutput, 63_000);
  assert.equal(detail.demandIntegrated, 80_000);
  assert.equal(detail.balance, -6_493);
  assert.equal(detail.reconciled, true);
});

test('無計劃量不加入前期與本期生產計畫', () => {
  const detail = buildStockCalculationDetail({
    partVersion: 'VS-1A021303', erpPartNo: '241332-V02-14PA', periodIndex: 0,
    balanceKind: 'withoutPlan', currentStockPc: 7_800, priorUnshippedQty: 0,
    priorPlanQty: 42_707, periods, usesSharedErpPool: false, sharedErpCount: 1,
  });

  assert.equal(detail.openingBalance, 7_800);
  assert.equal(detail.plannedOutput, 0);
  assert.equal(detail.balance, -32_200);
  assert.equal(detail.reconciled, true);
});

test('共享 ERP 顯示本列扣用前的共享池餘額，不假裝是單列庫存算式', () => {
  const detail = buildStockCalculationDetail({
    partVersion: 'SHARED-B', erpPartNo: 'ERP-SHARED', periodIndex: 0,
    balanceKind: 'withPlan', currentStockPc: 600, priorUnshippedQty: 0,
    priorPlanQty: 0,
    periods: [{ periodLabel: '2026/07', remainingStock: -100, remainingNoPlan: -100, demandIntegrated: 500, plannedOutput: 0 }],
    usesSharedErpPool: true, sharedErpCount: 2,
  });

  assert.equal(detail.calculationMode, 'shared');
  assert.equal(detail.openingBalance, 400);
  assert.equal(detail.calculatedBalance, -100);
});
