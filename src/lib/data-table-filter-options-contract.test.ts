import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('欄頭與進階 FilterModal 共用同一套所有型別 options lifecycle', () => {
  const headerSource = readSource('../components/data-table/ui/column-header-menu.tsx');
  const modalSource = readSource('../components/data-table/ui/filter-modal.tsx');
  const hookSource = readSource('../components/data-table/ui/use-column-filter-options.ts');

  assert.match(headerSource, /useColumnFilterOptions\(\{/);
  assert.match(modalSource, /useColumnFilterOptions\(\{/);
  assert.match(hookSource, /const abortController = new AbortController\(\)/);
  assert.match(hookSource, /requestIdRef\.current !== requestId/);
  assert.match(hookSource, /mergeColumnFilterOptions\(baseOptions, selectedValues\)/);
});

test('四個 server 列表把同一個 facet context 傳給欄頭與進階 FilterModal', () => {
  const toolbarSource = readSource('../components/data-table/ui/table-toolbar.tsx');
  const fgSource = readSource('../components/fg-monthly.tsx');
  const salesSource = readSource('../components/sales-meeting.tsx');
  const componentSource = readSource('../components/component-weekly.tsx');
  const sourceDataSource = readSource('../components/source-data.tsx');

  assert.match(toolbarSource, /optionContext=\{filterOptionContext\}/);
  assert.match(toolbarSource, /loadOptions=\{loadFilterOptions\}/);
  for (const source of [fgSource, salesSource, componentSource, sourceDataSource]) {
    assert.match(source, /filterOptionContext=\{columnHeader\.menuController\.optionContext\}/);
    assert.match(source, /loadFilterOptions=\{columnHeader\.menuController\.loadOptions\}/);
  }
});

test('三個完整載入列表把原始資料集傳給共用 faceted options', () => {
  const toolbarSource = readSource('../components/data-table/ui/table-toolbar.tsx');
  const localSources = [
    readSource('../components/plan-management.tsx'),
    readSource('../components/production-plans.tsx'),
    readSource('../components/run-history.tsx'),
  ];
  assert.match(toolbarSource, /optionRows=\{filterOptionRows\}/);
  for (const source of localSources) {
    assert.match(source, /optionRows:/);
    assert.match(source, /filterOptionRows=\{columnHeader\.menuController\.optionRows\}/);
  }
});

test('四支 server API 都排除目前欄位並回傳通用 facet options', () => {
  const routes = [
    readSource('../app/api/fg-monthly/route.ts'),
    readSource('../app/api/sales-meeting/route.ts'),
    readSource('../app/api/component-weekly/route.ts'),
    readSource('../app/api/source-data/route.ts'),
  ];
  for (const route of routes) {
    assert.match(route, /excludeSerializedColumnFilter/);
    assert.match(route, /collectColumnFacetOptions/);
    assert.match(route, /facetType/);
  }
});

test('FG 合併資料庫有庫存異常條件時不得走未 enrichment 的客戶 facet 快速路徑', () => {
  const route = readSource('../app/api/fg-monthly/route.ts');
  assert.match(
    route,
    /facet === 'customerCode' && facetType && inventoryAnomalyFilters\.length === 0/,
  );
});
