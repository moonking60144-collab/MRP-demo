import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRunLogs, selectRunLogDelta } from './run-progress-contract';

const logs = [
  { ts: 10, level: 'info' as const, msg: 'first', seq: 5 },
  { ts: 11, level: 'warn' as const, msg: 'second', seq: 6 },
  { ts: 12, level: 'error' as const, msg: 'third', seq: 7 },
];

test('Run progress 只回傳 cursor 之後的新日誌', () => {
  assert.deepEqual(selectRunLogDelta(logs, 5), {
    logs: logs.slice(1),
    nextSeq: 7,
    reset: false,
  });
});
test('ring buffer 已越過 cursor 時回傳目前完整視窗並要求 reset', () => {
  assert.deepEqual(selectRunLogDelta(logs, 2), {
    logs,
    nextSeq: 7,
    reset: true,
  });
});

test('舊日誌沒有 seq 時會產生單調序號並排除無效資料', () => {
  assert.deepEqual(normalizeRunLogs([
    { ts: 10, level: 'info', msg: 'first' },
    null,
    { ts: 11, level: 'invalid', msg: 'skip' },
    { ts: 12, level: 'warn', msg: 'second' },
  ]), [
    { ts: 10, level: 'info', msg: 'first', seq: 1 },
    { ts: 12, level: 'warn', msg: 'second', seq: 2 },
  ]);
});
