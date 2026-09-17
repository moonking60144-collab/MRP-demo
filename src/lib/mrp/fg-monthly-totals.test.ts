import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateFgMonthlyPeriodTotals } from './fg-monthly-totals';

test('成品月推合計依 ERP pool 只計一次期末餘額，其他欄位仍逐料號加總', () => {
  const result = aggregateFgMonthlyPeriodTotals(
    [
      { partVersion: 'PV-A', erpPartNo: ' ERP-SHARED ' },
      { partVersion: 'PV-B', erpPartNo: 'ERP-SHARED' },
      { partVersion: 'PV-C', erpPartNo: null },
    ],
    [
      {
        partVersion: 'PV-A', periodIndex: 0,
        remainingStock: 100, remainingNoPlan: 90,
        plannedOutput: 10, demandIntegrated: 20, forecastQty: null,
        ordersUnshipped: 5, ordersTotal: 8,
      },
      {
        partVersion: 'PV-B', periodIndex: 0,
        remainingStock: 80, remainingNoPlan: null,
        plannedOutput: 5, demandIntegrated: 30, forecastQty: 40,
        ordersUnshipped: null, ordersTotal: 4,
      },
      {
        partVersion: 'PV-C', periodIndex: 0,
        remainingStock: 20, remainingNoPlan: 10,
        plannedOutput: 2, demandIntegrated: null, forecastQty: 3,
        ordersUnshipped: 1, ordersTotal: null,
      },
      {
        partVersion: 'NOT-FILTERED', periodIndex: 0,
        remainingStock: -999, remainingNoPlan: -999,
        plannedOutput: 999, demandIntegrated: 999, forecastQty: 999,
        ordersUnshipped: 999, ordersTotal: 999,
      },
    ],
  );

  assert.deepEqual(result, [{
    periodIndex: 0,
    plannedOutput: 17,
    demandIntegrated: 50,
    forecastQty: 43,
    ordersUnshipped: 6,
    ordersTotal: 12,
    remainingStock: 100,
    remainingNoPlan: 100,
  }]);
});

test('成品月推合計保留全空欄位為 null 並依 periodIndex 排序', () => {
  const result = aggregateFgMonthlyPeriodTotals(
    [{ partVersion: 'PV-A', erpPartNo: null }],
    [
      {
        partVersion: 'PV-A', periodIndex: 2,
        remainingStock: null, remainingNoPlan: null,
        plannedOutput: null, demandIntegrated: null, forecastQty: null,
        ordersUnshipped: null, ordersTotal: null,
      },
      {
        partVersion: 'PV-A', periodIndex: 1,
        remainingStock: '12.5', remainingNoPlan: '-3',
        plannedOutput: '4', demandIntegrated: 0, forecastQty: null,
        ordersUnshipped: 0, ordersTotal: 0,
      },
    ],
  );

  assert.deepEqual(result, [
    {
      periodIndex: 1,
      plannedOutput: 4,
      demandIntegrated: 0,
      forecastQty: null,
      ordersUnshipped: 0,
      ordersTotal: 0,
      remainingStock: 12.5,
      remainingNoPlan: -3,
    },
    {
      periodIndex: 2,
      plannedOutput: null,
      demandIntegrated: null,
      forecastQty: null,
      ordersUnshipped: null,
      ordersTotal: null,
      remainingStock: null,
      remainingNoPlan: null,
    },
  ]);
});
