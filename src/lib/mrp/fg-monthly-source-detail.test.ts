import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeFgMonthlyOrderDemand,
  fgMonthlyDemandCalculation,
  fgMonthlyDemandExplanation,
  fgMonthlyOrderPeriodIndex,
  fgMonthlySourcePeriod,
  fgMonthlySourceTypes,
  isFgMonthlySummarySourceMetric,
  summarizeAttributedFgMonthlyOrders,
} from './fg-monthly-source-detail';
import { resolveOrderDemandContribution } from './order-demand-contract';
import { generateMonthlyPeriods } from './period-utils';

test('月推期間來源依數字類型選擇訂單、預示量或生產計畫', () => {
  assert.deepEqual(fgMonthlySourceTypes('ordersUnshipped'), ['orders']);
  assert.deepEqual(fgMonthlySourceTypes('ordersTotal'), ['orders']);
  assert.deepEqual(fgMonthlySourceTypes('forecastQty'), ['forecasts']);
  assert.deepEqual(fgMonthlySourceTypes('plannedOutput'), ['production_plans']);
  assert.deepEqual(fgMonthlySourceTypes('demandIntegrated'), ['orders', 'forecasts']);
  assert.deepEqual(fgMonthlySourceTypes('woScheduled'), ['work_orders']);
  assert.deepEqual(fgMonthlySourceTypes('woUnscheduled'), ['work_orders']);
  assert.deepEqual(fgMonthlySourceTypes('woTotal'), ['work_orders']);
  assert.deepEqual(fgMonthlySourceTypes('planReportedQty'), ['production_plans']);
  assert.deepEqual(fgMonthlySourceTypes('planClosedQty'), ['production_plans']);
  assert.equal(isFgMonthlySummarySourceMetric('woScheduled'), true);
  assert.equal(isFgMonthlySummarySourceMetric('plannedOutput'), false);
});

test('訂單來源與月推 engine 都只依營業指定出貨日分桶，不 fallback 客戶需求日', () => {
  const periods = generateMonthlyPeriods(new Date('2026-07-27T00:00:00.000Z'), 3);

  assert.equal(fgMonthlyOrderPeriodIndex({ designatedShipDate: null }, periods), null);
  assert.equal(fgMonthlyOrderPeriodIndex({
    designatedShipDate: new Date('2026-08-12T00:00:00.000Z'),
  }, periods), 1);
});

test('訂單月份歸屬排除缺日期與投影外資料，前期只承擔未出庫需求', () => {
  const contribution = resolveOrderDemandContribution({
    orderQty: 1000,
    shippedQty: 300,
    unshippedQty: 700,
    salesStatus: '未結案',
  }, 'order-demand-v2-manual-close');

  assert.deepEqual(attributeFgMonthlyOrderDemand(contribution, null, 12), {
    status: 'excluded_missing_designated_ship_date',
    periodIndex: null,
    recognizedOrderQty: 0,
    outstandingOrderQty: 0,
    demandResolvedQty: 0,
  });
  assert.deepEqual(attributeFgMonthlyOrderDemand(contribution, 12, 12), {
    status: 'excluded_after_projection',
    periodIndex: 12,
    recognizedOrderQty: 0,
    outstandingOrderQty: 0,
    demandResolvedQty: 0,
  });
  assert.deepEqual(attributeFgMonthlyOrderDemand(contribution, -1, 12), {
    status: 'included_prior',
    periodIndex: -1,
    recognizedOrderQty: 0,
    outstandingOrderQty: 700,
    demandResolvedQty: 0,
  });
});

test('訂單來源摘要保留全量實際生命週期，但 MRP 合計只算月推已歸屬資料', () => {
  const included = resolveOrderDemandContribution({
    orderQty: 1000,
    preparedQty: 500,
    shippedQty: 300,
    soldQty: 200,
    unshippedQty: 700,
    salesStatus: '未結案',
  }, 'order-demand-v2-manual-close');
  const excluded = resolveOrderDemandContribution({
    orderQty: 600,
    preparedQty: 600,
    shippedQty: 600,
    soldQty: 600,
    unshippedQty: 0,
    salesStatus: '已結案',
  }, 'order-demand-v2-manual-close');

  const summary = summarizeAttributedFgMonthlyOrders([
    {
      contribution: included,
      attribution: attributeFgMonthlyOrderDemand(included, 0, 12),
    },
    {
      contribution: excluded,
      attribution: attributeFgMonthlyOrderDemand(excluded, null, 12),
    },
  ]);

  assert.equal(summary.rawOrderQty, 1600);
  assert.equal(summary.shippedQty, 900);
  assert.equal(summary.recognizedOrderQty, 1000);
  assert.equal(summary.outstandingOrderQty, 700);
  assert.equal(summary.demandResolvedQty, 300);
});

test('前期數字可建立與月份相同的來源請求 period contract', () => {
  assert.deepEqual(
    fgMonthlySourcePeriod('plannedOutput', 153875, -1, '前期未結'),
    {
      periodIndex: -1,
      periodLabel: '前期未結',
      demandIntegrated: 0,
      ordersUnshipped: 0,
      forecastQty: 0,
      plannedOutput: 153875,
      ordersTotal: 0,
      woScheduled: 0,
      woUnscheduled: 0,
      woTotal: 0,
      planReportedQty: 0,
      planClosedQty: 0,
    },
  );
});

test('月推摘要數字可建立全期間來源請求 contract', () => {
  assert.deepEqual(
    fgMonthlySourcePeriod('woScheduled', 300000, null, '鍛造已排'),
    {
      periodIndex: null,
      periodLabel: '鍛造已排',
      demandIntegrated: 0,
      ordersUnshipped: 0,
      forecastQty: 0,
      plannedOutput: 0,
      ordersTotal: 0,
      woScheduled: 300000,
      woUnscheduled: 0,
      woTotal: 0,
      planReportedQty: 0,
      planClosedQty: 0,
    },
  );
});

test('需求整合明細沿用月推公式並顯示已出貨扣除', () => {
  assert.deepEqual(fgMonthlyDemandCalculation({
    periodIndex: 0,
    periodLabel: '2026/07',
    demandIntegrated: 80,
    ordersUnshipped: 80,
    forecastQty: 60,
    plannedOutput: 0,
    ordersTotal: 100,
  }), {
    shippedQty: 20,
    baseDemand: 100,
    demandIntegrated: 80,
  });
});

test('未結量大於訂單總量時不得以負已出貨放大需求整合', () => {
  assert.deepEqual(fgMonthlyDemandCalculation({
    periodIndex: 0,
    periodLabel: '2026/07',
    demandIntegrated: 100,
    ordersUnshipped: 120,
    forecastQty: 60,
    plannedOutput: 0,
    ordersTotal: 100,
  }), {
    shippedQty: 0,
    baseDemand: 100,
    demandIntegrated: 100,
  });
});

test('聚合需求沿用逐成員計算後的加總，不以聚合總量重新套用 max 公式', () => {
  assert.deepEqual(fgMonthlyDemandExplanation({
    periodIndex: 0,
    periodLabel: '2026/07',
    demandIntegrated: 2893,
    ordersUnshipped: 2446,
    forecastQty: 11343,
    plannedOutput: 0,
    ordersTotal: 11396,
  }, true), {
    kind: 'aggregated',
    demandIntegrated: 2893,
  });
});
