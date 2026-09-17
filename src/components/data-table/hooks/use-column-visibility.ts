'use client';

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import type { ColumnVisibilityState, MrpColumnDef } from '../types';

interface ColumnVisibilityOptions {
  defaultAllVisible?: boolean;
  persistHiddenOnly?: boolean;
}

function parseStoredVisibility(raw: string | null): ColumnVisibilityState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'boolean'),
    );
  } catch {
    return {};
  }
}

export function readStoredColumnVisibility(
  storage: Pick<Storage, 'getItem'>,
  storageKey: string,
): ColumnVisibilityState {
  try {
    return parseStoredVisibility(storage.getItem(storageKey));
  } catch {
    return {};
  }
}

export function mergeColumnVisibility(
  defaults: ColumnVisibilityState,
  saved: ColumnVisibilityState,
): ColumnVisibilityState {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(saved)) {
    if (key in merged) merged[key] = value;
  }
  return merged;
}

export function buildHiddenColumnPreference(
  currentIds: string[],
  visibility: ColumnVisibilityState,
  previous: ColumnVisibilityState,
): ColumnVisibilityState {
  const currentIdSet = new Set(currentIds);
  const hidden: ColumnVisibilityState = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!currentIdSet.has(key) && value === false) hidden[key] = false;
  }
  for (const id of currentIds) {
    if (visibility[id] === false) hidden[id] = false;
  }
  return hidden;
}

export function useColumnVisibility(
  columns: MrpColumnDef[],
  storageKey?: string,
  options: ColumnVisibilityOptions = {},
) {
  const { defaultAllVisible = false, persistHiddenOnly = false } = options;
  const defaultVisibility = useMemo(
    () => Object.fromEntries(columns.map((col) => [
      col.id,
      defaultAllVisible ? true : col.defaultVisible !== false,
    ])),
    [columns, defaultAllVisible],
  );
  const columnIds = useMemo(() => columns.map((column) => column.id), [columns]);
  const columnSignature = columnIds.join('\u001f');

  const [visibility, setVisibility] = useState<ColumnVisibilityState>(defaultVisibility);
  const [hydrated, setHydrated] = useState(!storageKey);
  const skipPersistSignatureRef = useRef<string | null>(null);

  // Paint 前套用目前 view 的偏好；未出現在舊資料的新欄一律採新預設。
  useLayoutEffect(() => {
    if (!storageKey) {
      setVisibility(defaultVisibility);
      setHydrated(true);
      return;
    }
    const saved = readStoredColumnVisibility(localStorage, storageKey);
    const merged = mergeColumnVisibility(defaultVisibility, saved);
    skipPersistSignatureRef.current = columnSignature;
    setVisibility(merged);
    setHydrated(true);
  }, [storageKey, defaultVisibility, columnSignature]);

  // Persist to localStorage on change (after hydration)
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    if (skipPersistSignatureRef.current === columnSignature) {
      skipPersistSignatureRef.current = null;
      return;
    }
    try {
      if (!persistHiddenOnly) {
        localStorage.setItem(storageKey, JSON.stringify(visibility));
        return;
      }
      const previous = parseStoredVisibility(localStorage.getItem(storageKey));
      const hidden = buildHiddenColumnPreference(columnIds, visibility, previous);
      localStorage.setItem(storageKey, JSON.stringify(hidden));
    } catch {
      // ignore
    }
  }, [storageKey, visibility, hydrated, persistHiddenOnly, columnIds, columnSignature]);

  const toggleColumn = useCallback((columnId: string) => {
    setVisibility((prev) => ({ ...prev, [columnId]: !prev[columnId] }));
  }, []);

  const showAll = useCallback(() => {
    setVisibility(Object.fromEntries(columns.map((col) => [col.id, true])));
  }, [columns]);

  const resetToDefault = useCallback(() => {
    setVisibility(defaultVisibility);
  }, [defaultVisibility]);

  const setColumnVisibility = useCallback((state: ColumnVisibilityState) => {
    setVisibility({ ...defaultVisibility, ...state });
  }, [defaultVisibility]);

  const isVisible = useCallback(
    (columnId: string) => visibility[columnId] !== false,
    [visibility],
  );

  const visibleCount = useMemo(
    () => columns.filter((column) => visibility[column.id] !== false).length,
    [columns, visibility],
  );

  return {
    visibility,
    defaultVisibility,
    toggleColumn,
    showAll,
    resetToDefault,
    setColumnVisibility,
    isVisible,
    visibleCount,
    totalCount: columns.length,
  };
}
