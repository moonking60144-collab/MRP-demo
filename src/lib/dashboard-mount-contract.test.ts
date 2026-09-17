import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('儀表板 mount 會先接回執行中 Run，再註冊 timer cleanup', () => {
  const source = readFileSync(
    new URL('../components/dashboard.tsx', import.meta.url),
    'utf8',
  );
  const mountStart = source.indexOf('    fetchDashboard();');
  const activeRunFetch = source.indexOf("    fetch('/api/runs/active')", mountStart);
  const timerCleanup = source.indexOf('    return () => {', mountStart);

  assert.notEqual(mountStart, -1, '找不到儀表板 mount effect');
  assert.notEqual(activeRunFetch, -1, '找不到執行中 Run 接回請求');
  assert.notEqual(timerCleanup, -1, '找不到 timer cleanup');
  assert.ok(
    activeRunFetch < timerCleanup,
    '執行中 Run 接回請求不可放在 effect cleanup return 之後',
  );
});
