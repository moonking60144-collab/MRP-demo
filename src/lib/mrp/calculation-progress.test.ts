import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalculationProgressThrottle } from './calculation-progress';

test('計算進度更新最多每秒落資料庫一次', () => {
  let now = 0;
  const shouldReport = createCalculationProgressThrottle(() => now);

  assert.equal(shouldReport(), false);

  now = 999;
  assert.equal(shouldReport(), false);

  now = 1000;
  assert.equal(shouldReport(), true);
  assert.equal(shouldReport(), false);

  now = 1999;
  assert.equal(shouldReport(), false);

  now = 2000;
  assert.equal(shouldReport(), true);
});
