import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const traditionalTables = [
  '../../components/fg-monthly-traditional.tsx',
  '../../components/component-weekly-traditional.tsx',
  '../../components/sales-meeting-traditional.tsx',
];

test('三張傳統表共用每列範圍 selector 與 rAF 框選更新', () => {
  for (const relativePath of traditionalTables) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /buildSelectionRangeCss\(/, relativePath);
    assert.match(source, /useRafCellFocus\(/, relativePath);
    assert.doesNotMatch(
      source,
      /data-selc=\\?"\$\{c\}\\?"/,
      `${relativePath} 不得回退成逐格 selector`,
    );
  }
});

test('共用框選排程器每個 animation frame 最多提交一次最新格位', () => {
  const source = readFileSync(
    new URL('../../components/ui/use-raf-cell-focus.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /pendingRef\.current = next/);
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /cancelAnimationFrame\(/);
  assert.match(source, /const flush = useCallback/);
});

test('成品月推用完整欄位 contract 固定 table layout，不依當下虛擬列重算欄寬', () => {
  const source = readFileSync(
    new URL('../../components/fg-monthly-traditional.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const tableColumnWidths = useMemo/);
  assert.match(source, /tableLayout: 'fixed'/);
  assert.match(source, /<colgroup>/);
});

test('虛擬表捲動每個 animation frame 最多提交一次最新 viewport', () => {
  const source = readFileSync(
    new URL('../../components/ui/virtual-table-rows.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /pendingViewportRef\.current = \{/);
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /cancelAnimationFrame\(/);
  assert.match(source, /useState<VirtualTableWindow>/);
  assert.match(source, /resolveVirtualTableWindow\(current, \{/);
  assert.doesNotMatch(source, /useState<VirtualTableViewport>/);
});

test('三張傳統表的 period labels 不會在無關互動時建立新陣列', () => {
  for (const relativePath of traditionalTables) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /const (?:\{ labels, numWeeks \}|labels) = useMemo\(/, relativePath);
  }
});

test('成品月推排序欄位 id 維持穩定 reference，避免無關 parent render 清空列快取', () => {
  const source = readFileSync(
    new URL('../../components/fg-monthly.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const traditionalSortFieldIds = useMemo\(/);
  assert.match(source, /sortFieldIds=\{traditionalSortFieldIds\}/);
  assert.doesNotMatch(source, /sortFieldIds=\{sorting\.sortState\.fields\.map\(/);
});

test('元件週推與產銷會議將資料列重建隔離在明確 renderVersion 邊界', () => {
  const contracts = [
    ['../../components/component-weekly-traditional.tsx', 'MemoizedComponentWeeklyRows'],
    ['../../components/sales-meeting-traditional.tsx', 'MemoizedSalesMeetingRows'],
  ] as const;
  for (const [relativePath, componentName] of contracts) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`const ${componentName} = memo\\(`), relativePath);
    assert.match(source, /const rowRenderVersion = useMemo\(/, relativePath);
    assert.match(source, /previous\.renderVersion === next\.renderVersion/, relativePath);
    assert.match(source, /useVirtualTableRowNodes\(/, relativePath);
  }
});

test('成品月推傳統表明細入口不依賴 modal 展開狀態', () => {
  const source = readFileSync(
    new URL('../../components/fg-monthly.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const openDetail = useCallback\(async \(item: FgMonthlyItem, showMaterialReminder = false\) => \{/);
  assert.match(source, /const onShowDetailForTraditional = openDetail;/);
  assert.doesNotMatch(source, /onShowDetailForTraditional = useCallback[\s\S]*?\}, \[expandedPart\]\)/);
});
