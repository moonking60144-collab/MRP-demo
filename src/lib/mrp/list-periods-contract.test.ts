import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupPeriodRows,
  hasCompletePeriodMap,
  salesMeetingPeriodsCacheKey,
} from './list-periods-contract';
import { fgMonthlyPeriodsCacheKey } from './fg-monthly-period-client';

test('列表週期資料依料號分組且保留原始順序', () => {
  const rows = [
    { partVersion: 'A', periodIndex: 1 },
    { partVersion: 'B', periodIndex: 1 },
    { partVersion: 'A', periodIndex: 2 },
  ];

  assert.deepEqual(groupPeriodRows(rows, 'partVersion'), {
    A: [rows[0], rows[2]],
    B: [rows[1]],
  });
});

test('只有每一個可見料號都有週期資料才可預熱快取', () => {
  assert.equal(hasCompletePeriodMap(['A', 'B'], { A: [{}], B: [{}] }), true);
  assert.equal(hasCompletePeriodMap(['A', 'B'], { A: [{}], B: [] }), false);
  assert.equal(hasCompletePeriodMap(['A', 'B'], { A: [{}] }), false);
  assert.equal(hasCompletePeriodMap([], {}), false);
});

test('月推週期快取識別包含 aggregated、Run 與 DB source', () => {
  const row = { partVersion: 'A', mrpRunId: 55, dbSource: 'local' };
  assert.notEqual(
    fgMonthlyPeriodsCacheKey([row], false),
    fgMonthlyPeriodsCacheKey([row], true),
  );
  assert.notEqual(
    fgMonthlyPeriodsCacheKey([row], false),
    fgMonthlyPeriodsCacheKey([{ ...row, mrpRunId: 56 }], false),
  );
  assert.notEqual(
    fgMonthlyPeriodsCacheKey([row], false),
    fgMonthlyPeriodsCacheKey([{ ...row, dbSource: 'docker' }], false),
  );
});

test('產銷週期快取識別使用回應列的實際 Run', () => {
  assert.notEqual(
    salesMeetingPeriodsCacheKey([{ partVersion: 'A', mrpRunId: 55 }]),
    salesMeetingPeriodsCacheKey([{ partVersion: 'A', mrpRunId: 56 }]),
  );
  assert.equal(salesMeetingPeriodsCacheKey([]), null);
  assert.notEqual(
    salesMeetingPeriodsCacheKey([{
      partVersion: 'A',
      memberPartVersions: ['A'],
      mrpRunId: 55,
    }]),
    salesMeetingPeriodsCacheKey([{
      partVersion: 'A',
      memberPartVersions: ['A', 'A-V01'],
      mrpRunId: 55,
    }]),
  );
  assert.notEqual(
    salesMeetingPeriodsCacheKey([{
      partVersion: 'A',
      memberPartVersions: ['A', 'A-V01'],
      mrpRunId: 55,
      dbSource: 'local',
    }]),
    salesMeetingPeriodsCacheKey([{
      partVersion: 'A',
      memberPartVersions: ['A', 'A-V01'],
      mrpRunId: 55,
      dbSource: 'remote',
    }]),
  );
});
