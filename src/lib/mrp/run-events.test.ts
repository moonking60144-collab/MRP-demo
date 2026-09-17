import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emitRunRetentionCompleted,
  onRunRetentionCompleted,
} from './run-events';
import { createAutomaticRunRetentionResult } from './run-retention-result';

test('retention 完成事件傳遞實際刪除的 Run ID 並可取消訂閱', () => {
  const received: number[][] = [];
  const unsubscribe = onRunRetentionCompleted(({ result }) => {
    received.push(result.deletedIds);
  });
  const result = createAutomaticRunRetentionResult({
    startedAt: new Date('2026-07-29T01:00:00.000Z'),
    completedAt: new Date('2026-07-29T01:00:00.100Z'),
    candidateIds: [8],
    deletedIds: [8],
  });

  emitRunRetentionCompleted({ result });
  unsubscribe();
  emitRunRetentionCompleted({ result });

  assert.deepEqual(received, [[8]]);
});
