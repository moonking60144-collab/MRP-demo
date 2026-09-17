import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../components/component-weekly.tsx', import.meta.url),
  'utf8',
);

test('元件週推 cold load 顯示 Loader 並保留傳統表格 owner', () => {
  assert.match(source, /const listPending = !queryReady \|\| loadedListKey !== buildListKey\(\)/);
  assert.match(source, /const fetchData = useCallback\(async \(\) => \{\s*if \(!queryReady\) return;/);
  assert.match(
    source,
    /loading && listPending && <Loader label="讀取元件週推資料"/,
  );
  assert.match(source, /<div className=\{listPending \? 'hidden' : 'contents'\}>\s*<ComponentWeeklyTraditionalView/);
  assert.doesNotMatch(source, /setItems\(\[\]\)/);
});

test('元件週推主列表失敗時保留可觀察錯誤與重試入口', () => {
  assert.match(source, /const \[listError, setListError\] = useState<string \| null>\(null\)/);
  assert.match(source, /if \(!res\.ok\) throw new Error\(/);
  assert.match(source, /setListError\(err instanceof Error/);
  assert.match(source, /onClick=\{fetchData\}/);
  assert.doesNotMatch(
    source,
    /if \(\(err as Error\)\?\.name === 'AbortError'\) return;\s*\/\/ ignore/,
  );
});
