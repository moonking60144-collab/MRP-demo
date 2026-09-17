'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { SortField, SortState, SortDirection } from '../types';

export function prioritizeSortFields(fields: SortField[], field: SortField): SortField[] {
  return [field, ...fields.filter((existing) => existing.id !== field.id)];
}

export function sanitizeSortState(
  value: unknown,
  allowedColumnIds?: ReadonlySet<string>,
): SortState | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as SortState).fields)) {
    return null;
  }
  const fields = (value as SortState).fields.filter((field): field is SortField => (
    !!field
    && typeof field.id === 'string'
    && typeof field.label === 'string'
    && (field.direction === 'asc' || field.direction === 'desc')
    && (!allowedColumnIds || allowedColumnIds.has(field.id))
  ));
  return { fields };
}

export function useTableSorting(
  initialSort?: SortField[],
  storageKey?: string,
  allowedColumnIds?: ReadonlySet<string>,
) {
  const initialRef = useRef<SortField[]>(initialSort || []);
  const defaultSortState = useMemo<SortState>(() => ({
    fields: initialRef.current.map((field) => ({ ...field })),
  }), []);
  const [sortState, setSortState] = useState<SortState>({
    fields: initialRef.current,
  });
  const [hydrated, setHydrated] = useState(!storageKey);
  // 系統預設排序 —— 供「返回預設」還原（清除後也能拿回來）

  // Load from localStorage on mount
  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const sanitized = sanitizeSortState(JSON.parse(stored), allowedColumnIds);
        if (sanitized) setSortState(sanitized);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [storageKey, allowedColumnIds]);

  // Persist to localStorage on change (after hydration)
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(sortState));
    } catch {
      // ignore
    }
  }, [storageKey, sortState, hydrated]);

  const addSort = useCallback((field: SortField) => {
    if (allowedColumnIds && !allowedColumnIds.has(field.id)) return;
    setSortState((prev) => ({
      fields: [...prev.fields.filter((f) => f.id !== field.id), field],
    }));
  }, [allowedColumnIds]);

  const prioritizeSort = useCallback((field: SortField) => {
    if (allowedColumnIds && !allowedColumnIds.has(field.id)) return;
    setSortState((prev) => ({
      fields: prioritizeSortFields(prev.fields, field),
    }));
  }, [allowedColumnIds]);

  const removeSort = useCallback((fieldId: string) => {
    setSortState((prev) => ({
      fields: prev.fields.filter((f) => f.id !== fieldId),
    }));
  }, []);

  const toggleDirection = useCallback((fieldId: string) => {
    setSortState((prev) => ({
      fields: prev.fields.map((f) =>
        f.id === fieldId
          ? { ...f, direction: (f.direction === 'asc' ? 'desc' : 'asc') as SortDirection }
          : f,
      ),
    }));
  }, []);

  const reorderSort = useCallback((fromIndex: number, toIndex: number) => {
    setSortState((prev) => {
      const fields = [...prev.fields];
      const [removed] = fields.splice(fromIndex, 1);
      fields.splice(toIndex, 0, removed);
      return { fields };
    });
  }, []);

  const clearSort = useCallback(() => {
    setSortState({ fields: [] });
  }, []);

  const resetSort = useCallback(() => {
    setSortState({ fields: [...initialRef.current] });
  }, []);

  const setSort = useCallback((fields: SortField[]) => {
    setSortState({
      fields: allowedColumnIds
        ? fields.filter((field) => allowedColumnIds.has(field.id))
        : fields,
    });
  }, [allowedColumnIds]);

  // Serialize to query param format: "field1:asc,field2:desc"
  const sortQueryParam = useMemo(
    () => sortState.fields
      .filter((field) => !allowedColumnIds || allowedColumnIds.has(field.id))
      .map((f) => `${f.id}:${f.direction}`)
      .join(','),
    [allowedColumnIds, sortState.fields],
  );

  return {
    hydrated,
    sortState,
    defaultSortState,
    addSort,
    prioritizeSort,
    removeSort,
    toggleDirection,
    reorderSort,
    clearSort,
    resetSort,
    setSort,
    sortQueryParam,
  };
}
