import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutoRecalculatePlanQty,
  computeFulfillmentPlanQty,
  computeMaterialKg,
} from './fg-plan-suggestion';

test('調整滿足期時以含既有生產計畫的餘額計算', () => {
  const periods = [
    { remainingStock: 2_000, demandIntegrated: 50_000 },
    { remainingStock: 2_000, demandIntegrated: 50_000 },
    { remainingStock: -348_000, demandIntegrated: 350_000 },
  ];

  assert.equal(computeFulfillmentPlanQty(periods, 2, 10, 0), 0);
  assert.equal(computeFulfillmentPlanQty(periods, 3, 0, 0), 348_000);
});

test('後續規劃會扣除前面已規劃數量並支援半期需求', () => {
  const periods = [
    { remainingStock: -100, demandIntegrated: 100 },
    { remainingStock: -300, demandIntegrated: 200 },
  ];

  assert.equal(computeFulfillmentPlanQty(periods, 1.5, 10, 50), 165);
});

test('整數結果不受 JavaScript 浮點誤差多進位一件', () => {
  const periods = [
    { remainingStock: -100, demandIntegrated: 100 },
  ];

  assert.equal(computeFulfillmentPlanQty(periods, 1, 10, 0), 110);
});

test('真實的小數需求仍向上進位', () => {
  const periods = [
    { remainingStock: -100.0001, demandIntegrated: 100 },
  ];

  assert.equal(computeFulfillmentPlanQty(periods, 1, 10, 0), 111);
});

test('同 ERP 共用庫存規劃不使用缺少共享池上下文的前端自動重算', () => {
  assert.equal(canAutoRecalculatePlanQty(false), true);
  assert.equal(canAutoRecalculatePlanQty(true), false);
});

test('材料重量換算由月推與開單規劃共用同一規則', () => {
  assert.equal(computeMaterialKg(100, 0.25, 999), 25);
  assert.equal(computeMaterialKg(100, 0, 250), 25);
  assert.equal(computeMaterialKg(100, 0, 0), 0);
});
