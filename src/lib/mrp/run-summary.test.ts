import assert from 'node:assert/strict';
import test from 'node:test';
import { toRunSummary } from './run-summary';

test('Run summary 保留精確 active duration，但不輸出完整 stepStatus', () => {
  const summary = toRunSummary({
    id: 7,
    versionCode: 'MRP-20260727-120000',
    runDate: new Date('2026-07-27T00:00:00.000Z'),
    status: 'completed',
    isLatest: true,
    createdAt: new Date('2026-07-27T04:00:00.000Z'),
    completedAt: new Date('2026-07-27T04:10:00.000Z'),
    createdBy: 'test',
    syncCounts: { orders: 10 },
    stepTiming: { orders: 1000 },
    errorMessage: null,
    stepStatus: {
      _totalActiveMs: 95_400,
      work_order_bom: { warningItems: Array.from({ length: 100 }) },
    },
  });

  assert.equal(summary.duration, 95);
  assert.equal('stepStatus' in summary, false);
  assert.deepEqual(summary.syncCounts, { orders: 10 });
});
