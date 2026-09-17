import assert from 'node:assert/strict';
import test from 'node:test';
import { accumulateSyncWallTiming } from './sync-timing';

test('sync wall 在 Resume 後累計前次與本次 attempt 耗時', () => {
  assert.deepEqual(accumulateSyncWallTiming({ sync_wall: 43_000, inventory: 900 }, 70), {
    sync_wall: 43_070,
    inventory: 900,
    sync_attempt_wall: 70,
  });
});
test('無效的歷史 timing 不會污染新的 sync wall', () => {
  assert.deepEqual(accumulateSyncWallTiming({ sync_wall: Number.NaN }, 1_250), {
    sync_wall: 1_250,
    sync_attempt_wall: 1_250,
  });
});
