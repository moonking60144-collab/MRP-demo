import assert from 'node:assert/strict';
import test from 'node:test';
import { SALES_MEETING_COLUMNS, SALES_MEETING_PERIOD_COLUMNS } from '../../components/data-table/column-defs/sales-meeting-columns';
import { mergeColumnVisibility } from '../../components/data-table/hooks/use-column-visibility';
import { createLocalTablePreset, readLocalTablePresets, sanitizePresetConfig, writeLocalTablePresets } from '../../components/data-table/preset-storage';

const columns = [...SALES_MEETING_PERIOD_COLUMNS, ...SALES_MEETING_COLUMNS];
const defaults = Object.fromEntries(columns.map(column => [column.id, column.defaultVisible !== false]));

test('大列在選單最上方，有獨立穩定識別且不是篩選、排序或固定欄', () => {
  assert.deepEqual(SALES_MEETING_PERIOD_COLUMNS.map(column => [column.id, column.header]), [
    ['period.remainingStock', '剩餘庫存'], ['period.demand', '訂單需求'], ['period.supply', '生產計畫'],
  ], 'PERIOD_CHOICES_MATCH_USER_ROWS');
  for (const column of SALES_MEETING_PERIOD_COLUMNS) {
    assert.equal(column.group, '大列');
    assert.equal(column.filterable, false);
    assert.equal(column.sortable, false);
    assert.equal(column.freezeable, false);
    assert.equal(column.headerMenu, false);
    assert.ok(!SALES_MEETING_COLUMNS.some(base => base.id === column.id));
  }
});

test('舊欄位偏好保留隱藏欄，新大列預設顯示，重設會恢復大列', () => {
  const restored = mergeColumnVisibility(defaults, { erpPartNo: false });
  assert.equal(restored.erpPartNo, false);
  for (const column of SALES_MEETING_PERIOD_COLUMNS) assert.equal(restored[column.id], true);
  const hidden = mergeColumnVisibility(defaults, { 'period.demand': false, 'period.supply': false });
  assert.equal(hidden['period.demand'], false);
  assert.equal(hidden['period.supply'], false);
  assert.equal(hidden['period.remainingStock'], true);
  assert.equal(defaults['period.demand'], true);
});

test('自訂檢視儲存、讀回與套用保留大列隱藏設定', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const preset = createLocalTablePreset({ tableId: 'sales_meeting', presetName: '僅看庫存', sorting: { fields: [] }, filtering: { globalSearch: '', columnFilters: [] }, columnVisibility: { ...defaults, 'period.demand': false, 'period.supply': false } }, 1);
  writeLocalTablePresets(storage, 'sales_meeting', [preset]);
  const restored = sanitizePresetConfig(readLocalTablePresets(storage, 'sales_meeting')[0], columns.map(column => column.id));
  assert.equal(restored.columnVisibility['period.demand'], false);
  assert.equal(restored.columnVisibility['period.supply'], false);
  assert.equal(restored.columnVisibility['period.remainingStock'], true);
});
