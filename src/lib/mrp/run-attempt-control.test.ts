import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PhaseTimeoutError,
  getActiveLocalRunIds,
  settleAllOrThrow,
  withRunAttempt,
  withSettledTimeout,
} from './run-attempt-control';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('平行工作其中一個失敗時，仍等待已啟動的其他工作收尾才回報錯誤', async () => {
  let lateWriteFinished = false;
  const failed = Promise.reject(new Error('worker A failed'));
  const inFlight = sleep(25).then(() => {
    lateWriteFinished = true;
  });

  await assert.rejects(settleAllOrThrow([failed, inFlight] as const), /worker A failed/);
  assert.equal(lateWriteFinished, true);
});

test('階段逾時必須等待底層工作收尾，不得留下 detached promise', async () => {
  let underlyingFinished = false;
  const underlying = sleep(25).then(() => {
    underlyingFinished = true;
    return 42;
  });

  await assert.rejects(
    withSettledTimeout('slow phase', underlying, 5),
    (error: unknown) => error instanceof PhaseTimeoutError,
  );
  assert.equal(underlyingFinished, true);
});

test('run attempt 執行期間維持 process-local lease，完成後才釋放', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const attempt = withRunAttempt(701, async () => {
    await gate;
  });

  await sleep(0);
  assert.deepEqual(getActiveLocalRunIds(), [701]);
  await assert.rejects(withRunAttempt(701, async () => undefined), /already has an active local attempt/);

  release();
  await attempt;
  assert.deepEqual(getActiveLocalRunIds(), []);
});
