// Client-side filter functions for different column types

import type { ColumnFilter } from '../types';
import { normalizeColumnFacetValue } from '@/lib/data-table-server-filters';

export function applyColumnFilter(
  value: unknown,
  filter: ColumnFilter,
): boolean {
  const { operator } = filter;

  if (operator === 'isEmpty') return value == null || String(value).trim() === '';
  if (operator === 'isNotEmpty') return value != null && String(value).trim() !== '';

  const filterVal = filter.value;
  const strVal = value == null ? '' : String(value).toLowerCase();

  if (
    operator === 'oneOf'
    && Array.isArray(filterVal)
    && filterVal.every((candidate): candidate is string => typeof candidate === 'string')
  ) {
    const normalized = normalizeColumnFacetValue(value, filter.valueType || 'text');
    return !!normalized && filterVal.some(
      (candidate) => normalized.value.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
    );
  }

  if (filter.valueType === 'boolean' && operator === 'equals') {
    return String(value) === String(filterVal);
  }

  if (filter.valueType === 'date') {
    const actualTime = new Date(String(value ?? '')).getTime();
    const expectedTime = new Date(String(filterVal)).getTime();
    if (Number.isNaN(actualTime) || Number.isNaN(expectedTime)) return false;
    switch (operator) {
      case 'equals': return actualTime === expectedTime;
      case 'gt': return actualTime > expectedTime;
      case 'gte': return actualTime >= expectedTime;
      case 'lt': return actualTime < expectedTime;
      case 'lte': return actualTime <= expectedTime;
      default: return true;
    }
  }

  switch (operator) {
    case 'contains':
      return strVal.includes(String(filterVal).toLowerCase());
    case 'equals':
      return strVal === String(filterVal).toLowerCase();
    case 'startsWith':
      return strVal.startsWith(String(filterVal).toLowerCase());
    case 'endsWith':
      return strVal.endsWith(String(filterVal).toLowerCase());
    case 'gt':
      return parseFloat(strVal) > Number(filterVal);
    case 'gte':
      return parseFloat(strVal) >= Number(filterVal);
    case 'lt':
      return parseFloat(strVal) < Number(filterVal);
    case 'lte':
      return parseFloat(strVal) <= Number(filterVal);
    case 'between': {
      const num = parseFloat(strVal);
      const [min, max] = filterVal as [number, number];
      return num >= min && num <= max;
    }
    default:
      return true;
  }
}

export function applyFiltersToRow<T extends Record<string, unknown>>(
  row: T,
  filters: ColumnFilter[],
  globalSearch: string,
  searchableFields: string[],
): boolean {
  // Global search
  if (globalSearch) {
    const q = globalSearch.toLowerCase();
    const match = searchableFields.some((field) => {
      const val = row[field];
      return val != null && String(val).toLowerCase().includes(q);
    });
    if (!match) return false;
  }

  // Column filters
  for (const filter of filters) {
    if (!applyColumnFilter(row[filter.columnId], filter)) return false;
  }

  return true;
}
