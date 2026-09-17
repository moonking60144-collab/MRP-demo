import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('開單規劃翻頁、篩選與每頁筆數變更都將表格捲回頂端', () => {
  const source = readFileSync(
    new URL('../components/plan-management.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const tableScrollRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /if \(tableScrollRef\.current\) tableScrollRef\.current\.scrollTop = 0;/);
  assert.match(source, /<div ref=\{tableScrollRef\} data-mrp-scroll/);
  assert.match(source, /onPageChange=\{handleTablePageChange\}/);
  assert.doesNotMatch(source, /onPageChange=\{setTablePage\}/);
  assert.match(
    source,
    /\[statusFilter, filtering\.filterState, sorting\.sortState, handleTablePageChange\]/,
  );
  assert.match(source, /setTableLimit\(limit\);\s+handleTablePageChange\(1\);/);
});
