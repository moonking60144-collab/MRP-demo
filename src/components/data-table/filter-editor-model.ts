import type {
  ColumnFilter,
  ColumnFilterType,
  FilterOperator,
  MrpColumnDef,
} from './types';

export interface FilterOperatorOption {
  value: FilterOperator;
  label: string;
}

export interface FilterEditorDraft {
  operator: FilterOperator;
  value: string;
  betweenMax: string;
  selectedValues: string[];
  optionSearch: string;
}

const TEXT_OPERATORS: FilterOperatorOption[] = [
  { value: 'oneOf', label: '任一符合' },
  { value: 'contains', label: '包含' },
  { value: 'equals', label: '等於' },
  { value: 'startsWith', label: '開頭為' },
  { value: 'endsWith', label: '結尾為' },
  { value: 'isEmpty', label: '為空' },
  { value: 'isNotEmpty', label: '非空' },
];

const NUMERIC_OPERATORS: FilterOperatorOption[] = [
  { value: 'oneOf', label: '任一符合' },
  { value: 'equals', label: '=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'between', label: '介於' },
  { value: 'isEmpty', label: '為空' },
  { value: 'isNotEmpty', label: '非空' },
];

const DATE_OPERATORS: FilterOperatorOption[] = [
  { value: 'oneOf', label: '任一符合' },
  { value: 'equals', label: '等於' },
  { value: 'gt', label: '晚於' },
  { value: 'gte', label: '不早於' },
  { value: 'lt', label: '早於' },
  { value: 'lte', label: '不晚於' },
  { value: 'isEmpty', label: '為空' },
  { value: 'isNotEmpty', label: '非空' },
];

const BOOLEAN_OPERATORS: FilterOperatorOption[] = [
  { value: 'oneOf', label: '任一符合' },
  { value: 'equals', label: '等於' },
  { value: 'isEmpty', label: '為空' },
  { value: 'isNotEmpty', label: '非空' },
];

const ENUM_OPERATORS: FilterOperatorOption[] = [
  { value: 'oneOf', label: '任一符合' },
];

export function getFilterOperators(filterType: ColumnFilterType): FilterOperatorOption[] {
  if (filterType === 'numeric') return NUMERIC_OPERATORS;
  if (filterType === 'date') return DATE_OPERATORS;
  if (filterType === 'boolean') return BOOLEAN_OPERATORS;
  if (filterType === 'enum') return ENUM_OPERATORS;
  return TEXT_OPERATORS;
}

export function filterOperatorNeedsValue(operator: FilterOperator): boolean {
  return operator !== 'isEmpty' && operator !== 'isNotEmpty';
}

export function createFilterEditorDraft(
  filterType: ColumnFilterType,
  filter?: ColumnFilter,
): FilterEditorDraft {
  const defaultOperator = getFilterOperators(filterType)[0].value;
  if (!filter) {
    return {
      operator: defaultOperator,
      value: '',
      betweenMax: '',
      selectedValues: [],
      optionSearch: '',
    };
  }

  if (filter.operator === 'oneOf') {
    return {
      operator: 'oneOf',
      value: '',
      betweenMax: '',
      selectedValues: Array.isArray(filter.value)
        ? filter.value.filter((entry): entry is string => typeof entry === 'string')
        : [String(filter.value)],
      optionSearch: '',
    };
  }

  if (filter.operator === 'between' && Array.isArray(filter.value)) {
    return {
      operator: filter.operator,
      value: String(filter.value[0]),
      betweenMax: String(filter.value[1]),
      selectedValues: [],
      optionSearch: '',
    };
  }

  return {
    operator: filter.operator,
    value: filter.value == null ? '' : String(filter.value),
    betweenMax: '',
    selectedValues: [],
    optionSearch: '',
  };
}

function parseFiniteNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildColumnFilterFromDraft(
  column: MrpColumnDef,
  draft: FilterEditorDraft,
): ColumnFilter | null {
  const valueType = column.filterType;
  if (!valueType || column.filterable === false) return null;

  if (draft.operator === 'oneOf') {
    const selectedValues = [...new Set(draft.selectedValues.filter(Boolean))];
    if (selectedValues.length === 0) return null;
    return {
      columnId: column.id,
      operator: 'oneOf',
      value: selectedValues,
      valueType,
    };
  }

  if (!filterOperatorNeedsValue(draft.operator)) {
    return {
      columnId: column.id,
      operator: draft.operator,
      value: '',
      valueType,
    };
  }

  if (valueType === 'numeric') {
    const min = parseFiniteNumber(draft.value);
    if (min === null) return null;
    if (draft.operator === 'between') {
      const max = parseFiniteNumber(draft.betweenMax);
      if (max === null) return null;
      return {
        columnId: column.id,
        operator: draft.operator,
        value: [min, max],
        valueType,
      };
    }
    return {
      columnId: column.id,
      operator: draft.operator,
      value: min,
      valueType,
    };
  }

  if (draft.value === '') return null;
  if (valueType === 'boolean' && draft.value !== 'true' && draft.value !== 'false') return null;
  return {
    columnId: column.id,
    operator: draft.operator,
    value: draft.value,
    valueType,
  };
}
