import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('搜尋輸入先停留在工具列草稿，停頓後才更新共用查詢狀態', () => {
  const toolbarSource = readFileSync(
    new URL('../components/data-table/ui/table-toolbar.tsx', import.meta.url),
    'utf8',
  );
  const filteringSource = readFileSync(
    new URL('../components/data-table/hooks/use-table-filtering.ts', import.meta.url),
    'utf8',
  );

  assert.match(toolbarSource, /const GLOBAL_SEARCH_DEBOUNCE_MS = 500;/);
  assert.match(toolbarSource, /value=\{globalSearchDraft\}/);
  assert.match(toolbarSource, /onChange=\{\(e\) => \{\s*setGlobalSearchDraft\(e\.target\.value\);\s*onSearchDraftChange\?\.\(e\.target\.value\);/);
  assert.match(toolbarSource, /window\.setTimeout\(\(\) => \{\s*onGlobalSearchChange\(globalSearchDraft\);/);
  assert.doesNotMatch(toolbarSource, /onChange=\{\(e\) => onGlobalSearchChange\(e\.target\.value\)\}/);
  assert.match(filteringSource, /queryGlobalSearch: filterState\.globalSearch/);
  assert.doesNotMatch(filteringSource, /setQueryGlobalSearch/);
});
