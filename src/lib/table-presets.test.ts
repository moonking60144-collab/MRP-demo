import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalTablePreset,
  presetConfigEquals,
  readLocalTablePresets,
  sanitizePresetConfig,
  setDefaultLocalTablePreset,
  tablePresetStorageKey,
  writeLocalTablePresets,
} from '../components/data-table/preset-storage';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const baseInput = {
  tableId: 'fg_monthly_traditional',
  presetName: 'SY 會審',
  sorting: { fields: [{ id: 'customerCode', direction: 'asc' as const, label: '客戶代碼' }] },
  filtering: {
    globalSearch: '',
    columnFilters: [{ columnId: 'customerCode', operator: 'equals' as const, value: 'SY' }],
  },
  columnVisibility: { customerCode: true, erpPartNo: true, surfaceTreatment: false },
};

test('個人表格預設只寫入該瀏覽器與 tableId 對應的儲存區', () => {
  const storage = createStorage();
  const preset = createLocalTablePreset(baseInput, 101, '2026-07-23T00:00:00.000Z');
  writeLocalTablePresets(storage, baseInput.tableId, [preset]);

  assert.equal(storage.getItem(tablePresetStorageKey('another_table')), null);
  assert.deepEqual(readLocalTablePresets(storage, baseInput.tableId), [preset]);
});

test('個人預設損壞時安全回到沒有個人預設', () => {
  const storage = createStorage({
    [tablePresetStorageKey(baseInput.tableId)]: '{broken-json',
  });

  assert.deepEqual(readLocalTablePresets(storage, baseInput.tableId), []);
});

test('每張表最多只有一個開啟時自動套用的個人預設', () => {
  const first = createLocalTablePreset({ ...baseInput, presetName: '第一個' }, 1);
  const second = createLocalTablePreset({ ...baseInput, presetName: '第二個' }, 2);

  const result = setDefaultLocalTablePreset([first, second], 2);

  assert.equal(result[0].isDefault, false);
  assert.equal(result[1].isDefault, true);
});

test('載入舊預設時忽略已移除欄位，新欄位交由新版系統預設補齊', () => {
  const preset = createLocalTablePreset(baseInput, 1);
  const config = sanitizePresetConfig(preset, ['customerCode', 'erpPartNo', 'newColumn']);

  assert.deepEqual(config.sorting.fields.map((field) => field.id), ['customerCode']);
  assert.deepEqual(config.filtering.columnFilters.map((filter) => filter.columnId), ['customerCode']);
  assert.deepEqual(config.columnVisibility, { customerCode: true, erpPartNo: true });
  assert.equal('newColumn' in config.columnVisibility, false);
});

test('檢視比對將省略與明寫 true 的欄位視為相同', () => {
  assert.equal(presetConfigEquals(
    baseInput.sorting,
    baseInput.filtering,
    { customerCode: true, erpPartNo: true },
    baseInput.sorting,
    baseInput.filtering,
    { customerCode: true },
  ), true);
  assert.equal(presetConfigEquals(
    baseInput.sorting,
    baseInput.filtering,
    { customerCode: false },
    baseInput.sorting,
    baseInput.filtering,
    { customerCode: true },
  ), false);
});

test('個人預設可保存並還原同欄位多選條件', () => {
  const storage = createStorage();
  const multiSelectInput = {
    ...baseInput,
    filtering: {
      globalSearch: '',
      columnFilters: [{
        columnId: 'customerCode',
        operator: 'oneOf' as const,
        value: ['SY', 'SM'],
        valueType: 'enum' as const,
      }],
    },
  };
  writeLocalTablePresets(storage, baseInput.tableId, [
    createLocalTablePreset(multiSelectInput, 202),
  ]);

  assert.deepEqual(
    readLocalTablePresets(storage, baseInput.tableId)[0]?.filtering.columnFilters,
    multiSelectInput.filtering.columnFilters,
  );
});
