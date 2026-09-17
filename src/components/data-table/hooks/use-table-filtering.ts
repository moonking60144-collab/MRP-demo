'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { ColumnFilter, FilterState } from '../types';

const FILTER_OPERATORS = new Set([
  'contains',
  'equals',
  'oneOf',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isEmpty',
  'isNotEmpty',
]);

function normalizeColumnFilter(filter: unknown): ColumnFilter | null {
  if (!filter || typeof filter !== 'object') return null;
  const candidate = filter as Partial<ColumnFilter>;
  if (
    typeof candidate.columnId !== 'string'
    || typeof candidate.operator !== 'string'
    || !FILTER_OPERATORS.has(candidate.operator)
    || !Object.prototype.hasOwnProperty.call(candidate, 'value')
  ) return null;

  if (candidate.operator === 'oneOf') {
    if (!Array.isArray(candidate.value)) return null;
    const values = [...new Set(candidate.value
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean))];
    if (values.length === 0) return null;
    return { ...candidate, value: values } as ColumnFilter;
  }

  if (
    typeof candidate.value !== 'string'
    && typeof candidate.value !== 'number'
    && !(
      candidate.operator === 'between'
      && Array.isArray(candidate.value)
      && candidate.value.length === 2
      && candidate.value.every((value) => typeof value === 'number')
    )
  ) return null;
  return candidate as ColumnFilter;
}

export function sanitizeColumnFilters(
  value: unknown,
  allowedColumnIds?: ReadonlySet<string>,
): ColumnFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((filter) => {
    const normalized = normalizeColumnFilter(filter);
    if (!normalized || (allowedColumnIds && !allowedColumnIds.has(normalized.columnId))) return [];
    return [normalized];
  });
}

export function serializeColumnFilter(filter: ColumnFilter): string {
  let operator = filter.operator as string;
  if (operator === 'oneOf') {
    if (filter.valueType === 'numeric') operator = 'oneOfNumber';
    else if (filter.valueType === 'date') operator = 'oneOfDate';
    else if (filter.valueType === 'boolean') operator = 'oneOfBoolean';
  } else if (filter.valueType === 'date' && ['equals', 'gt', 'gte', 'lt', 'lte'].includes(operator)) {
    operator = `${operator}Date`;
  } else if (filter.valueType === 'boolean' && operator === 'equals') {
    operator = 'equalsBoolean';
  } else if (
    operator === 'equals'
    && (filter.valueType === 'numeric' || typeof filter.value === 'number')
  ) {
    operator = 'equalsNumber';
  }

  if (filter.operator === 'between' && Array.isArray(filter.value)) {
    return `${operator}:${filter.value[0]},${filter.value[1]}`;
  }
  if (filter.operator === 'oneOf' && Array.isArray(filter.value)) {
    return `${operator}:${JSON.stringify(filter.value)}`;
  }
  return `${operator}:${filter.value}`;
}

export function useTableFiltering(
  initialSearch?: string,
  storageKey?: string,
  allowedColumnIds?: ReadonlySet<string>,
) {
  const defaultFilterState = useMemo<FilterState>(() => ({
    globalSearch: initialSearch || '',
    columnFilters: [],
  }), [initialSearch]);
  const [filterState, setFilterState] = useState<FilterState>({
    globalSearch: initialSearch || '',
    columnFilters: [],
  });
  const [hydrated, setHydrated] = useState(!storageKey);
  const [restoredSession, setRestoredSession] = useState(false);

  // Search belongs to this tab; saved column preferences remain in localStorage.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const search = sessionStorage.getItem(`${storageKey}:search`);
      setRestoredSession(search !== null);
      if (search !== null) setFilterState(prev => ({ ...prev, globalSearch: search }));
    } catch {
      // Storage may be unavailable in private or restricted browsers.
    }
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.columnFilters) {
          setFilterState((prev) => ({
            ...prev,
            columnFilters: sanitizeColumnFilters(parsed.columnFilters, allowedColumnIds),
          }));
        }
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [storageKey, allowedColumnIds]);

  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      sessionStorage.setItem(`${storageKey}:search`, filterState.globalSearch);
    } catch {
      // Keep search usable when storage is unavailable.
    }
  }, [storageKey, filterState.globalSearch, hydrated]);

  // Persist column filters to localStorage on change (after hydration)
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ columnFilters: filterState.columnFilters }));
    } catch {
      // ignore
    }
  }, [storageKey, filterState.columnFilters, hydrated]);

  const setGlobalSearch = useCallback((search: string) => {
    setFilterState((prev) => ({ ...prev, globalSearch: search }));
  }, []);

  const rememberSearchDraft = useCallback((search: string) => {
    if (!storageKey) return;
    try { sessionStorage.setItem(`${storageKey}:search`, search); } catch { /* optional storage */ }
  }, [storageKey]);

  const setColumnFilter = useCallback((filter: ColumnFilter) => {
    if (allowedColumnIds && !allowedColumnIds.has(filter.columnId)) return;
    setFilterState((prev) => ({
      ...prev,
      columnFilters: [
        ...prev.columnFilters.filter((f) => f.columnId !== filter.columnId),
        filter,
      ],
    }));
  }, [allowedColumnIds]);

  const removeColumnFilter = useCallback((columnId: string) => {
    setFilterState((prev) => ({
      ...prev,
      columnFilters: prev.columnFilters.filter((f) => f.columnId !== columnId),
    }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilterState({ globalSearch: '', columnFilters: [] });
  }, []);

  const setFilters = useCallback((state: FilterState) => {
    setFilterState({
      ...state,
      columnFilters: sanitizeColumnFilters(state.columnFilters, allowedColumnIds),
    });
  }, [allowedColumnIds]);

  // Serialize column filters to query params while preserving the value type.
  const filterQueryParams = useMemo(() => {
    const params: Record<string, string> = {};
    for (const filter of filterState.columnFilters) {
      if (allowedColumnIds && !allowedColumnIds.has(filter.columnId)) continue;
      params[`filter_${filter.columnId}`] = serializeColumnFilter(filter);
    }
    return params;
  }, [allowedColumnIds, filterState.columnFilters]);

  return {
    hydrated,
    restoredSession,
    rememberSearchDraft,
    filterState,
    queryGlobalSearch: filterState.globalSearch,
    defaultFilterState,
    setGlobalSearch,
    setColumnFilter,
    removeColumnFilter,
    clearAllFilters,
    setFilters,
    filterQueryParams,
  };
}
