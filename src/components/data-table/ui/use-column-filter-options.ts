'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnFilterOptionsFingerprint,
  type ColumnFilterOption,
  type ColumnFilterOptionBaseContext,
  type LoadColumnFilterOptions,
} from '../column-header-contract';
import type { MrpColumnDef } from '../types';
import { applyColumnFilter } from '../utils/filter-fns';
import { collectColumnFacetOptions } from '@/lib/data-table-server-filters';

interface UseColumnFilterOptionsOptions {
  active: boolean;
  column: MrpColumnDef | null | undefined;
  selectedValues: string[];
  query: string;
  optionContext?: ColumnFilterOptionBaseContext;
  loadOptions?: LoadColumnFilterOptions;
  optionRows?: readonly Record<string, unknown>[];
}

export function mergeColumnFilterOptions(
  options: ColumnFilterOption[],
  selectedValues: string[],
): ColumnFilterOption[] {
  const merged = new Map(options.map((option) => [option.value, option]));
  for (const value of selectedValues) {
    if (!merged.has(value)) merged.set(value, { value, label: value });
  }
  return [...merged.values()];
}

export function filterStaticColumnOptions(
  options: ColumnFilterOption[],
  query: string,
): ColumnFilterOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery))
    : options;
}

export function meetsColumnOptionSearchThreshold(
  query: string,
  minSearchLength: number,
): boolean {
  return query.trim().length >= minSearchLength;
}

export function useColumnFilterOptions({
  active,
  column,
  selectedValues,
  query,
  optionContext,
  loadOptions,
  optionRows,
}: UseColumnFilterOptionsOptions) {
  const [loadedOptions, setLoadedOptions] = useState<ColumnFilterOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const optionContextRef = useRef(optionContext);
  optionContextRef.current = optionContext;

  const serverOptionSource = column?.optionSource?.type === 'server'
    ? column.optionSource
    : null;
  const serverBacked = serverOptionSource !== null;
  const minSearchLength = serverOptionSource?.minSearchLength || 0;
  const searchRequired = serverBacked
    && !meetsColumnOptionSearchThreshold(query, minSearchLength);
  const fingerprint = useMemo(() => {
    if (!active || !serverBacked || !column || !optionContext) return null;
    return createColumnFilterOptionsFingerprint({
      ...optionContext,
      columnId: column.id,
      valueType: column.filterType,
      query,
      limit: column.optionSource?.type === 'server' ? column.optionSource.limit : undefined,
    });
  }, [active, column, optionContext, query, serverBacked]);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!active || !serverBacked || !column) {
      setLoadedOptions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const requestContext = optionContextRef.current;
    if (!loadOptions || !requestContext || !fingerprint) {
      setLoadedOptions([]);
      setLoading(false);
      setError('此欄位的選項來源尚未設定');
      return;
    }

    const normalizedQuery = query.trim();
    if (!meetsColumnOptionSearchThreshold(normalizedQuery, minSearchLength)) {
      setLoadedOptions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      loadOptions({
        ...requestContext,
        columnId: column.id,
        valueType: column.filterType,
        query: normalizedQuery,
        limit: column.optionSource?.type === 'server' ? column.optionSource.limit : undefined,
      }, abortController.signal).then((nextOptions) => {
        if (cancelled || requestIdRef.current !== requestId) return;
        setLoadedOptions(nextOptions);
        setLoading(false);
      }).catch((loadError: unknown) => {
        if (cancelled || requestIdRef.current !== requestId) return;
        if (loadError instanceof Error && loadError.name === 'AbortError') return;
        setLoadedOptions([]);
        setLoading(false);
        setError('選項讀取失敗，請稍後再試');
      });
    }, normalizedQuery ? 150 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      abortController.abort();
    };
  }, [active, column, fingerprint, loadOptions, minSearchLength, query, serverBacked]);

  const options = useMemo(() => {
    const otherFilters = optionContext?.columnFilters.filter(
      (filter) => filter.columnId !== column?.id,
    ) || [];
    const globalSearch = optionContext?.globalSearch?.trim().toLocaleLowerCase() || '';
    const facetedRows = (optionRows || []).filter((row) => (
      (!globalSearch || Object.values(row).some((value) => (
        String(value ?? '').toLocaleLowerCase().includes(globalSearch)
      )))
      && otherFilters.every((filter) => applyColumnFilter(row[filter.columnId], filter))
    ));
    const collectedOptions = column?.filterType
      ? collectColumnFacetOptions(
          facetedRows,
          column.id,
          column.filterType,
          query,
          column.optionSource?.type === 'server' ? column.optionSource.limit : 200,
        )
      : [];
    const booleanOptions = column?.filterType === 'boolean'
      ? [
          { value: 'false', label: '否' },
          { value: 'true', label: '是' },
        ]
      : [];
    const staticOptions = [
      ...booleanOptions,
      ...[...new Set(column?.enumValues || [])].map((value) => ({ value, label: value })),
      ...collectedOptions,
    ];
    const baseOptions = serverBacked
      ? searchRequired ? [] : loadedOptions
      : mergeColumnFilterOptions(staticOptions, []);
    const mergedOptions = mergeColumnFilterOptions(baseOptions, selectedValues);
    return serverBacked ? mergedOptions : filterStaticColumnOptions(mergedOptions, query);
  }, [column, loadedOptions, optionContext, optionRows, query, searchRequired, selectedValues, serverBacked]);

  return { options, loading, error, searchRequired, minSearchLength };
}
