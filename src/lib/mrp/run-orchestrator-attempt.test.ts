import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import prisma from '../db';
import { sendRunSignal } from '../sync/sync-engine';
import { withRunAttempt } from './run-attempt-control';
import { clearStaleRuns, forceResetRuns } from './run-orchestrator';

const runDelegate = prisma.mrpRun as unknown as {
  updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
};
const originalUpdateMany = runDelegate.updateMany;

afterEach(() => {
  runDelegate.updateMany = originalUpdateMany;
  sendRunSignal(702, 'resume');
});

test('stale cleanup 與強制重設不得釋放仍在本 process 執行的 run', async () => {
  const calls: Record<string, unknown>[] = [];
  runDelegate.updateMany = async (args) => {
    calls.push(args);
    return { count: 0 };
  };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const attempt = withRunAttempt(702, async () => gate);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await clearStaleRuns(0);
  const reset = await forceResetRuns();

  assert.deepEqual(reset, { cleared: 0, runningLocalRunIds: [702] });
  const staleWhere = calls[0].where as Record<string, unknown>;
  const resetWhere = calls[1].where as Record<string, unknown>;
  assert.deepEqual(staleWhere.status, { in: ['pending', 'syncing', 'synced', 'calculating'] });
  assert.ok(staleWhere.createdAt);
  assert.deepEqual(staleWhere.id, { notIn: [702] });
  assert.deepEqual(resetWhere.status, { in: ['pending', 'syncing', 'synced', 'calculating'] });
  assert.deepEqual(resetWhere.id, { notIn: [702] });

  release();
  await attempt;
});
