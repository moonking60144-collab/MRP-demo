import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDER_DEMAND_CONTRACT_V1,
  ORDER_DEMAND_CONTRACT_V2,
  resolveOrderDemandContribution,
  summarizeOrderDemandContributions,
} from './order-demand-contract';

test('v1 保持歷史 Run：人工結案整筆不參與訂單總量與未結需求', () => {
  const contribution = resolveOrderDemandContribution({
    orderQty: 1000,
    preparedQty: 500,
    unprepQty: 0,
    shippedQty: 300,
    unshippedQty: 0,
    soldQty: 200,
    unsoldQty: 0,
    prepStatus: '人工結案',
    shipmentStatus: '人工結案',
    salesStatus: '人工結案',
  }, ORDER_DEMAND_CONTRACT_V1);

  assert.equal(contribution.recognizedOrderQty, 0);
  assert.equal(contribution.outstandingOrderQty, 0);
  assert.equal(contribution.demandResolvedQty, 0);
  assert.equal(contribution.closedUnfulfilledQty, 700);
  assert.equal(contribution.basis, 'legacy_manual_close_excluded');
});

test('v2 一般訂單維持既有未出庫需求，不以未備貨量取代', () => {
  const contribution = resolveOrderDemandContribution({
    orderQty: 1000,
    preparedQty: 700,
    unprepQty: 300,
    shippedQty: 500,
    unshippedQty: 500,
    soldQty: 400,
    unsoldQty: 600,
    prepStatus: '未結案',
    shipmentStatus: '未結案',
    salesStatus: '未結案',
  }, ORDER_DEMAND_CONTRACT_V2);

  assert.equal(contribution.recognizedOrderQty, 1000);
  assert.equal(contribution.outstandingOrderQty, 500);
  assert.equal(contribution.demandResolvedQty, 500);
  assert.equal(contribution.preparedNotShippedQty, 200);
  assert.equal(contribution.closedUnfulfilledQty, 0);
  assert.equal(contribution.basis, 'open_order_unshipped');
});

test('v2 人工結案只以 direct 已出庫量認列，已備未出庫留在庫存側', () => {
  const contribution = resolveOrderDemandContribution({
    orderQty: 1000,
    preparedQty: 500,
    unprepQty: 0,
    shippedQty: 300,
    unshippedQty: 0,
    soldQty: 200,
    unsoldQty: 0,
    prepStatus: '人工結案',
    shipmentStatus: '人工結案',
    salesStatus: '人工結案',
  }, ORDER_DEMAND_CONTRACT_V2);

  assert.equal(contribution.recognizedOrderQty, 300);
  assert.equal(contribution.outstandingOrderQty, 0);
  assert.equal(contribution.demandResolvedQty, 300);
  assert.equal(contribution.preparedNotShippedQty, 200);
  assert.equal(contribution.closedUnfulfilledQty, 700);
  assert.equal(contribution.remainingToPrepareQty, 500);
  assert.equal(contribution.remainingToShipQty, 700);
  assert.equal(contribution.remainingToSellQty, 800);
  assert.equal(contribution.basis, 'manual_close_actual_shipped');
});

test('v2 人工結案缺 direct 已出庫量時保留未知並採保守零抵扣', () => {
  const contribution = resolveOrderDemandContribution({
    orderQty: 1000,
    preparedQty: 500,
    unprepQty: 0,
    shippedQty: null,
    unshippedQty: 0,
    soldQty: null,
    unsoldQty: 0,
    prepStatus: '人工結案',
    shipmentStatus: '人工結案',
    salesStatus: '人工結案',
  }, ORDER_DEMAND_CONTRACT_V2);

  assert.equal(contribution.shippedQty, null);
  assert.equal(contribution.recognizedOrderQty, 0);
  assert.equal(contribution.outstandingOrderQty, 0);
  assert.equal(contribution.demandResolvedQty, 0);
  assert.equal(contribution.preparedNotShippedQty, null);
  assert.equal(contribution.closedUnfulfilledQty, null);
  assert.deepEqual(contribution.anomalies, ['manual_close_shipped_unknown']);
});

test('訂單摘要只由 contribution reducer 加總並保留未知筆數', () => {
  const contributions = [
    resolveOrderDemandContribution({
      orderQty: 1000,
      preparedQty: 700,
      unprepQty: 300,
      shippedQty: 500,
      unshippedQty: 500,
      soldQty: 400,
      unsoldQty: 600,
      prepStatus: '未結案',
      shipmentStatus: '未結案',
      salesStatus: '未結案',
    }, ORDER_DEMAND_CONTRACT_V2),
    resolveOrderDemandContribution({
      orderQty: 1000,
      preparedQty: 500,
      unprepQty: 0,
      shippedQty: 300,
      unshippedQty: 0,
      soldQty: 200,
      unsoldQty: 0,
      prepStatus: '人工結案',
      shipmentStatus: '人工結案',
      salesStatus: '人工結案',
    }, ORDER_DEMAND_CONTRACT_V2),
  ];

  assert.deepEqual(summarizeOrderDemandContributions(contributions), {
    orderCount: 2,
    manualCloseCount: 1,
    anomalyCount: 0,
    unknownPreparedCount: 0,
    unknownShippedCount: 0,
    unknownSoldCount: 0,
    unknownPreparedNotShippedCount: 0,
    unknownClosedUnfulfilledCount: 0,
    rawOrderQty: 2000,
    preparedQty: 1200,
    shippedQty: 800,
    soldQty: 600,
    preparedNotShippedQty: 400,
    recognizedOrderQty: 1300,
    outstandingOrderQty: 500,
    demandResolvedQty: 800,
    closedUnfulfilledQty: 700,
  });
});
