import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../components/sales-meeting-traditional.tsx', import.meta.url),
  'utf8',
);

test('產銷會議傳統檢視顯示已勾選的客料版本欄', () => {
  const frozenStart = source.indexOf('const FROZEN_COLS = [');
  const frozenEnd = source.indexOf('];', frozenStart);
  const frozenColumns = source.slice(frozenStart, frozenEnd);

  assert.ok(frozenStart >= 0 && frozenEnd > frozenStart);
  assert.match(frozenColumns, /customerPartNo[\s\S]*partVersion/);
  assert.match(source, /key === 'partVersion'[\s\S]*item\.memberPartVersions\.join\('、'\)/);
  assert.match(source, /getPrePeriodValue:[\s\S]*itemColumnValue\(item, key\)/);
  assert.match(source, /for \(const col of FROZEN_COLS\) row\.push\(itemColumnValue\(item, col\.key\)/);
  assert.match(source, /const val = itemColumnValue\(item, col\.key\)/);
});

test('客料版本欄預設隱藏時不會多凍結下一個可見欄', () => {
  assert.match(source, /export const SM_DEFAULT_FROZEN = 2;/);
});
