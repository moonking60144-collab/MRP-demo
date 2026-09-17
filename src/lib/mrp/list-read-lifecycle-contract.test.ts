import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const component of ['fg-monthly', 'sales-meeting', 'component-weekly', 'source-data']) {
  test(`${component} 列表取消、錯誤與快取寫入保留同一 request owner`, () => {
    const source = readFileSync(new URL(`../../components/${component}.tsx`, import.meta.url), 'utf8');
    const begin = source.indexOf('const fetchData = useCallback');
    const end = source.indexOf('//', source.indexOf('return () => fetchAbortRef.current?.abort();', begin));
    const request = source.slice(begin, end === -1 ? undefined : end);
    const guard = request.indexOf('if (ac.signal.aborted || fetchAbortRef.current !== ac) return;');
    const status = request.indexOf('if (!res.ok) throw new Error(');
    const cache = request.indexOf('cacheSet');
    assert.ok(guard >= 0 && status > guard && cache > status);
    assert.match(request, /fetch\(key, \{ signal: ac\.signal \}\)/);
    assert.match(request, /return \(\) => fetchAbortRef\.current\?\.abort\(\)/);
    assert.match(request, /if \(!ac\.signal\.aborted && fetchAbortRef\.current === ac\) setLoading\(false\)/);
    if (component !== 'source-data') {
      assert.match(source, /active=\{!listPending\}/);
      const table = readFileSync(new URL(`../../components/${component}-traditional.tsx`, import.meta.url), 'utf8');
      assert.match(table, /active = true/);
      assert.match(table, /stats=\{active \? \w+ : null\}/);
      assert.match(table, /if \(active\) return;\s*setDragging\(false\);\s*clearSelection\(\);/);
    }
  });
}

test('產銷週期 fallback 的 effect 擁有取消訊號與 terminal guard', () => {
  const source = readFileSync(new URL('../../components/sales-meeting-traditional.tsx', import.meta.url), 'utf8');
  assert.match(source, /loadSalesMeetingPeriods<PeriodDetail>\(items, \{ signal: controller.signal \}\)/);
  assert.match(source, /if \(controller.signal.aborted\) return;\s*setPeriodsMap\(periods\)/);
  assert.match(source, /if \(!controller.signal.aborted\) setLoading\(false\)/);
  assert.match(source, /fetchPeriods\(\);\s*return \(\) => controller.abort\(\)/);
});

test('原始資料用查詢 context 在 fetch 前把新條件重設到第一頁', () => {
  const source = readFileSync(new URL('../../components/source-data.tsx', import.meta.url), 'utf8');
  assert.match(source, /useReportPage\('mrp_page_source', JSON\.stringify\(\[/);
  assert.match(source, /const fetchData = useCallback\(async \(\) => \{\s*if \(!queryReady\) return;/);
  assert.doesNotMatch(source, /Reset page when filters change/);
});
