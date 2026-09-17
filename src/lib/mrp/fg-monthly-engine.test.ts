import assert from 'node:assert/strict';
import test from 'node:test';
import { computePartProjection } from './fg-monthly-engine';
import { computeFulfillmentPlanQty } from './fg-plan-suggestion';
import { ORDER_DEMAND_CONTRACT_V2 } from './order-demand-contract';
import { generateMonthlyPeriods } from './period-utils';

test('既有生產計畫覆蓋前期需求時，只在實際缺料期產生建議', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 4);
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-V01',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-V01-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 4,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 0,
    badStock: 0,
    orders: [],
    forecasts: [
      { forecastStart: periods[0].start, forecastQty: 50 },
      { forecastStart: periods[1].start, forecastQty: 50 },
      { forecastStart: periods[2].start, forecastQty: 200 },
    ],
    workOrders: [],
    plans: [
      { completionDate: periods[0].start, planQty: 100, reportedQty: 0, closedQty: 0 },
      { completionDate: periods[1].start, planQty: 100, reportedQty: 0, closedQty: 0 },
    ],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
  });

  assert.deepEqual(
    result.periodResults.map((period) => period.remainingStock),
    [50, 100, -100, -100],
  );
  assert.deepEqual(
    result.suggestions.map((suggestion) => suggestion.targetStartPeriod),
    [2],
  );
});

test('前期生產計畫供給會先抵扣再判斷第一個缺料期', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 3);
  const priorDate = new Date(Date.UTC(2026, 5, 30));
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-V02',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-V02-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 3,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 0,
    badStock: 0,
    orders: [],
    forecasts: [
      { forecastStart: periods[0].start, forecastQty: 50 },
      { forecastStart: periods[1].start, forecastQty: 100 },
    ],
    workOrders: [],
    plans: [
      { completionDate: priorDate, planQty: 100, reportedQty: 0, closedQty: 0 },
    ],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
  });

  assert.deepEqual(
    result.periodResults.map((period) => period.remainingStock),
    [50, -50, -50],
  );
  assert.deepEqual(
    result.suggestions.map((suggestion) => suggestion.targetStartPeriod),
    [1],
  );
});

test('engine 建議量用相同滿足期與緩衝率在畫面重算時不得改變', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 4);
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-V03',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-V03-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 4,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 100,
    badStock: 0,
    orders: [],
    forecasts: [
      { forecastStart: periods[2].start, forecastQty: 200 },
    ],
    workOrders: [],
    plans: [],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
  });

  assert.equal(result.suggestions.length, 1);
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.suggestedQty, 110);
  assert.equal(
    suggestion.suggestedQty,
    computeFulfillmentPlanQty(
      result.periodResults,
      suggestion.fulfillToPeriod,
      suggestion.bufferPct * 100,
      0,
    ),
  );
});

test('多筆 engine 建議逐筆扣除前序規劃後仍與畫面重算一致', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 6);
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-V04',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-V04-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 2,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 0,
    badStock: 0,
    orders: [],
    forecasts: [
      { forecastStart: periods[0].start, forecastQty: 100 },
      { forecastStart: periods[2].start, forecastQty: 200 },
    ],
    workOrders: [],
    plans: [],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
  });

  assert.deepEqual(
    result.suggestions.map((suggestion) => suggestion.suggestedQty),
    [110, 209],
  );
  let priorPlannedQty = 0;
  for (const suggestion of result.suggestions) {
    assert.equal(
      suggestion.suggestedQty,
      computeFulfillmentPlanQty(
        result.periodResults,
        suggestion.fulfillToPeriod,
        suggestion.bufferPct * 100,
        priorPlannedQty,
      ),
    );
    priorPlannedQty += suggestion.suggestedQty;
  }
});

test('未結量大於訂單總量時月推引擎不得以負已出貨放大需求整合', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 1);
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-V05',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-V05-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 1,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 100,
    badStock: 0,
    orders: [{
      designatedShipDate: periods[0].start,
      orderQty: 100,
      unshippedQty: 120,
      salesStatus: '未結案',
      prepStatus: null,
    }],
    forecasts: [
      { forecastStart: periods[0].start, forecastQty: 60 },
    ],
    workOrders: [],
    plans: [],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
  });

  assert.equal(result.periodResults[0].demandIntegrated, 100);
  assert.equal(result.periodResults[0].remainingStock, 0);
});

test('v2 人工結案只用實際已出庫量抵扣預示，已備未出庫不重複釋放庫存', () => {
  const baseDate = new Date('2026-07-16T00:00:00.000Z');
  const periods = generateMonthlyPeriods(baseDate, 1);
  const result = computePartProjection({
    partData: {
      partVersion: 'TEST-MANUAL-CLOSE',
      customerPartNo: 'TEST',
      customerCode: 'T',
      erpPartNo: 'TEST-MANUAL-CLOSE-01PA',
      forgingMachine: null,
      firstProcess: null,
      surfaceTreatment: null,
      forgingParent: null,
      processBomVersion: null,
      productStatus: '使用中',
      stockPeriods: 1,
      sortGroup: 1,
      unitWeightG: 0,
      mainMaterialKg: 0,
      skipFgInventory: false,
    },
    rawStock: 500,
    badStock: 0,
    orders: [{
      designatedShipDate: periods[0].start,
      orderQty: 1000,
      preparedQty: 500,
      unprepQty: 0,
      shippedQty: 300,
      unshippedQty: 0,
      soldQty: 200,
      unsoldQty: 0,
      salesStatus: '人工結案',
      shipmentStatus: '人工結案',
      prepStatus: '人工結案',
    }],
    forecasts: [{ forecastStart: periods[0].start, forecastQty: 1000 }],
    workOrders: [],
    plans: [],
    periods,
    numPeriods: periods.length,
    baseDate,
    applySkipFgInventory: false,
    orderDemandContractVersion: ORDER_DEMAND_CONTRACT_V2,
  });

  assert.equal(result.periodData[0].ordersTotal, 300);
  assert.equal(result.periodData[0].ordersUnshipped, 0);
  assert.equal(result.periodResults[0].demandIntegrated, 700);
  assert.equal(result.periodResults[0].remainingStock, -200);
});
