import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComponentWeeklyInventorySources } from './component-weekly-inventory-source';

test('庫存來源不受查詢順序影響，固定選 staging id 最大的一筆', () => {
  const older = { id: 10, erpPartNo: 'ERP-B', subtypeCode: null, marker: 'older' };
  const newer = { id: 20, erpPartNo: 'ERP-B', subtypeCode: null, marker: 'newer' };

  for (const rows of [[older, newer], [newer, older]]) {
    const resolved = resolveComponentWeeklyInventorySources(rows, 'B');
    assert.equal(resolved.sourceByMaterialPartNo.get('ERP-B')?.marker, 'newer');
    assert.equal(resolved.sourceCountByMaterialPartNo.get('ERP-B'), 2);
  }
});

test('W 線材只在合法線材 subtype 中選取來源', () => {
  const resolved = resolveComponentWeeklyInventorySources([
    { id: 30, erpPartNo: 'WIRE-1', subtypeCode: 'OTHER', marker: 'not-wire' },
    { id: 10, erpPartNo: 'WIRE-1', subtypeCode: 'MTRL-WR', marker: 'wire' },
  ], 'W');

  assert.equal(resolved.sourceByMaterialPartNo.get('WIRE-1')?.marker, 'wire');
  assert.equal(resolved.sourceCountByMaterialPartNo.get('WIRE-1'), 1);
});
