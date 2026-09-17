'use client';

import { useEffect, useMemo, useState } from 'react';
import { createServerFacetedOptionSource } from '../column-header-contract';
import type { MrpColumnDef } from '../types';

const customerCodesByRun = new Map<number, string[]>();
const EMPTY_CUSTOMER_CODES: string[] = [];

export function useRunCustomerCodeColumns(
  columns: MrpColumnDef[],
  runId: number | null,
  providedCustomerCodes?: string[],
  serverFaceted = false,
): MrpColumnDef[] {
  const [customerCodes, setCustomerCodes] = useState<string[]>(
    () => runId == null ? [] : customerCodesByRun.get(runId) || [],
  );

  useEffect(() => {
    if (providedCustomerCodes !== undefined || serverFaceted) return;
    if (runId == null) {
      setCustomerCodes([]);
      return;
    }
    const cached = customerCodesByRun.get(runId);
    if (cached) {
      setCustomerCodes(cached);
      return;
    }
    setCustomerCodes([]);
    const controller = new AbortController();
    fetch(`/api/filter-options/customer-codes?runId=${runId}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { values?: unknown };
        if (!response.ok || !Array.isArray(body.values)) return;
        const values = body.values.filter((value): value is string => typeof value === 'string');
        customerCodesByRun.set(runId, values);
        setCustomerCodes(values);
      })
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setCustomerCodes([]);
    });
    return () => controller.abort();
  }, [providedCustomerCodes, runId, serverFaceted]);

  const values = providedCustomerCodes ?? (serverFaceted ? EMPTY_CUSTOMER_CODES : customerCodes);

  return useMemo(() => columns.map((column) => (
    column.id === 'customerCode'
      ? {
          ...column,
          filterType: 'enum',
          enumValues: values,
          optionSource: serverFaceted
            ? createServerFacetedOptionSource({ ...column, filterType: 'enum' })
            : { type: 'static' },
        }
      : serverFaceted && column.filterable !== false && column.filterType
        ? {
            ...column,
            optionSource: column.optionSource?.type === 'server'
              ? column.optionSource
              : createServerFacetedOptionSource(column),
          }
        : column
  )), [columns, serverFaceted, values]);
}
