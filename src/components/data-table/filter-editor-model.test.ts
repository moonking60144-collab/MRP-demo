import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildColumnFilterFromDraft,
  createFilterEditorDraft,
  filterOperatorNeedsValue,
  getFilterOperators,
} from './filter-editor-model';
import type { ColumnFilter, MrpColumnDef } from './types';

test('FilterModal 與欄頭選單共用相同 operator contract', () => {
  assert.equal(getFilterOperators('text')[0].value, 'oneOf');
  assert.equal(getFilterOperators('numeric')[0].value, 'oneOf');
  assert.equal(getFilterOperators('date')[0].value, 'oneOf');
  assert.equal(getFilterOperators('boolean')[0].value, 'oneOf');
  assert.deepEqual(getFilterOperators('enum'), [{ value: 'oneOf', label: '任一符合' }]);
  assert.equal(filterOperatorNeedsValue('isEmpty'), false);
  assert.equal(filterOperatorNeedsValue('contains'), true);
});

test('所有可篩選型別都能建立 oneOf 多選條件', () => {
  for (const filterType of ['text', 'numeric', 'date', 'boolean'] as const) {
    const column: MrpColumnDef = { id: filterType, header: filterType, filterType };
    assert.deepEqual(buildColumnFilterFromDraft(column, {
      ...createFilterEditorDraft(filterType),
      selectedValues: ['A', 'B'],
    }), {
      columnId: filterType,
      operator: 'oneOf',
      value: ['A', 'B'],
      valueType: filterType,
    });
  }
});

test('existing oneOf filter 只複製到 draft，不共享 canonical array', () => {
  const filter: ColumnFilter = {
    columnId: 'customerCode',
    operator: 'oneOf',
    value: ['SY', 'SM'],
    valueType: 'enum',
  };
  const draft = createFilterEditorDraft('enum', filter);
  draft.selectedValues.push('SA');
  assert.deepEqual(filter.value, ['SY', 'SM']);
});

test('enum Apply 正規化重複值，空 draft 不會產生正式 filter', () => {
  const column: MrpColumnDef = {
    id: 'customerCode',
    header: '客戶代碼',
    filterType: 'enum',
  };
  assert.deepEqual(buildColumnFilterFromDraft(column, {
    operator: 'oneOf',
    value: '',
    betweenMax: '',
    selectedValues: ['SY', 'SM', 'SY'],
    optionSearch: '',
  }), {
    columnId: 'customerCode',
    operator: 'oneOf',
    value: ['SY', 'SM'],
    valueType: 'enum',
  });
  assert.equal(buildColumnFilterFromDraft(column, createFilterEditorDraft('enum')), null);
});

test('numeric between 保留 tuple contract 並拒絕不完整數值', () => {
  const column: MrpColumnDef = {
    id: 'stockWeeks',
    header: '庫存週數',
    filterType: 'numeric',
  };
  const draft = {
    operator: 'between' as const,
    value: '1.5',
    betweenMax: '3',
    selectedValues: [],
    optionSearch: '',
  };
  assert.deepEqual(buildColumnFilterFromDraft(column, draft), {
    columnId: 'stockWeeks',
    operator: 'between',
    value: [1.5, 3],
    valueType: 'numeric',
  });
  assert.equal(buildColumnFilterFromDraft(column, { ...draft, betweenMax: '' }), null);
});

test('boolean 與 no-value operator 不會產生假值', () => {
  const column: MrpColumnDef = {
    id: 'shouldPlanProduction',
    header: '應排產',
    filterType: 'boolean',
  };
  assert.equal(buildColumnFilterFromDraft(column, createFilterEditorDraft('boolean')), null);
  assert.deepEqual(buildColumnFilterFromDraft(column, {
    ...createFilterEditorDraft('boolean'),
    operator: 'isNotEmpty',
  }), {
    columnId: 'shouldPlanProduction',
    operator: 'isNotEmpty',
    value: '',
    valueType: 'boolean',
  });
});
