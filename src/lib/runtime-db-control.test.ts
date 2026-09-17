import assert from 'node:assert/strict';
import test from 'node:test';
import { withRuntimeDbControl } from './db';

test('run-start 與資料庫切換臨界區必須依序執行', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withRuntimeDbControl(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = withRuntimeDbControl(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ['first:start']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});
