import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(
  new URL('../../components/fg-monthly-traditional.tsx', import.meta.url),
  'utf8',
);

test('成品月推傳統表的 ERP 料號不得溢出固定欄寬', () => {
  assert.doesNotMatch(source, /isErp\s*\?\s*'whitespace-nowrap'/);

  const boundedFrozenCells = source.match(
    /className="truncate"\s+style=\{\{ maxWidth: col\.width - 12 \}\}/g,
  );
  assert.equal(boundedFrozenCells?.length, 2, '主列與聚合展開子列都必須限制 frozen cell 文字寬度');
});
