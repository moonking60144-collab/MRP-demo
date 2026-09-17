import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../components/component-weekly-traditional.tsx', import.meta.url),
  'utf8',
);

function assertBefore(first: string, second: string, start: number) {
  const firstIndex = source.indexOf(first, start);
  const secondIndex = source.indexOf(second, start);
  assert.ok(firstIndex >= start, `找不到 ${first}`);
  assert.ok(secondIndex >= start, `找不到 ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} 應位於 ${second} 前面`);
}

test('元件週推傳統檢視先顯示處置結果再顯示週期', () => {
  const headerStart = source.indexOf('{/* ===== HEADER ===== */}');
  const bodyStart = source.indexOf('{/* ===== BODY ===== */}');
  const exportStart = source.indexOf('const headerRow1:');
  const exportEnd = source.indexOf('const dataRows =', exportStart);

  assert.ok(headerStart >= 0 && bodyStart > headerStart);
  assertBefore('{/* Status group */}', '{/* Period groups */}', headerStart);
  assertBefore('{/* Status columns */}', '{/* Period group columns */}', headerStart);
  assertBefore(
    '{visibleStatusCols.map((column, statusIndex) => {',
    '{/* Period group cells */}',
    bodyStart,
  );
  assert.ok(exportStart >= 0 && exportEnd > exportStart);
  assertBefore('for (const col of STATUS_COLS)', 'for (const g of PERIOD_GROUPS)', exportStart);
});
