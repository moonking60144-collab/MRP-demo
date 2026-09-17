import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedConcurrency,
  mapWithBoundedConcurrency,
} from './bounded-concurrency';

test('movement snapshot 並行設定只接受正整數且不超過上限', () => {
  assert.equal(boundedConcurrency(undefined, 2, 2), 2);
  assert.equal(boundedConcurrency('bad', 2, 2), 2);
  assert.equal(boundedConcurrency('0', 2, 2), 2);
  assert.equal(boundedConcurrency('9', 2, 2), 2);
  assert.equal(boundedConcurrency('1', 2, 2), 1);
});

test('受控並行保留結果順序且不超過指定上限', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithBoundedConcurrency([30, 5, 20, 10], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value / 5;
  });

  assert.deepEqual(results, [6, 1, 4, 2]);
  assert.equal(peak, 2);
});

test('任一批次失敗後只等待既有 in-flight，不再派發後續工作', async () => {
  const started: number[] = [];
  await assert.rejects(
    () => mapWithBoundedConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    }),
    /boom/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(started.includes(2), false);
  assert.equal(started.includes(3), false);
});
