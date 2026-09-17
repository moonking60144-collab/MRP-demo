import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDurationMs, formatRunPhaseTiming } from './run-duration';

test('Run 階段耗時分開顯示同步、Source 驗證與 MRP 計算，不把平行 step 相加', () => {
  assert.equal(formatDurationMs(93_249), '1m 33s');
  assert.equal(formatDurationMs(3370), '3.4s');
  assert.equal(formatRunPhaseTiming({
    sync_wall: 93_249,
    verify_plan_qty: 3370,
    calculation: 7067,
    inventory: 57_731,
    work_order_bom: 58_935,
  }), '同步 1m 33s · 驗證 3.4s · 計算 7.1s');
});

test('舊 Run 沒有階段 timing 時不顯示誤導性零值', () => {
  assert.equal(formatDurationMs(-1), '—');
  assert.equal(formatRunPhaseTiming(null), null);
  assert.equal(formatRunPhaseTiming({}), null);
});
