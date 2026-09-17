import type {
  ColumnFilter,
  ColumnFilterType,
  ColumnOptionSource,
  MrpColumnDef,
} from './types';

export interface ColumnHeaderCapabilities {
  filterable: boolean;
  sortable: boolean;
  hideable: boolean;
  freezeable: boolean;
}

export interface ColumnFilterOptionsContext {
  tableId: string;
  columnId: string;
  valueType?: ColumnFilterType;
  runId: number | null;
  dbSource?: string | null;
  mergeDb?: boolean;
  globalSearch?: string;
  columnFilters: ColumnFilter[];
  fixedScope?: Record<string, string | number | boolean | null | undefined>;
  query?: string;
  limit?: number;
}

export type ColumnFilterOptionBaseContext = Omit<
  ColumnFilterOptionsContext,
  'columnId' | 'query' | 'limit'
>;

export interface ColumnFilterOption {
  value: string;
  label: string;
  count?: number;
}

export type LoadColumnFilterOptions = (
  context: ColumnFilterOptionsContext,
  signal?: AbortSignal,
) => Promise<ColumnFilterOption[]>;

export function getColumnHeaderCapabilities(
  column: MrpColumnDef,
): ColumnHeaderCapabilities {
  if (column.headerMenu === false) {
    return { filterable: false, sortable: false, hideable: false, freezeable: false };
  }
  return {
    filterable: column.filterable !== false && column.filterType !== undefined,
    sortable: column.sortable !== false,
    hideable: column.hideable !== false,
    freezeable: column.freezeable !== false,
  };
}

export function hasColumnHeaderMenu(column: MrpColumnDef): boolean {
  return Object.values(getColumnHeaderCapabilities(column)).some(Boolean);
}

export function cloneColumnFilter(filter: ColumnFilter): ColumnFilter {
  return {
    ...filter,
    value: Array.isArray(filter.value) ? [...filter.value] : filter.value,
  } as ColumnFilter;
}

function canonicalizeFilterValue(filter: ColumnFilter): ColumnFilter['value'] {
  if (filter.operator === 'oneOf' && Array.isArray(filter.value)) {
    return [...new Set(filter.value
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
  }
  return Array.isArray(filter.value) ? [...filter.value] : filter.value;
}

function canonicalizeFilters(
  filters: ColumnFilter[],
  excludedColumnId: string,
): Array<{
  columnId: string;
  operator: ColumnFilter['operator'];
  value: ColumnFilter['value'];
  valueType: ColumnFilterType | null;
}> {
  return filters
    .filter((filter) => filter.columnId !== excludedColumnId)
    .map((filter) => ({
      columnId: filter.columnId,
      operator: filter.operator,
      value: canonicalizeFilterValue(filter),
      valueType: filter.valueType ?? null,
    }))
    .sort((left, right) => left.columnId.localeCompare(right.columnId));
}

function canonicalizeFixedScope(
  fixedScope: ColumnFilterOptionsContext['fixedScope'],
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(fixedScope || {})
      .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createColumnFilterOptionsFingerprint(
  context: ColumnFilterOptionsContext,
): string {
  return JSON.stringify({
    tableId: context.tableId,
    columnId: context.columnId,
    valueType: context.valueType ?? null,
    runId: context.runId,
    dbSource: context.dbSource ?? null,
    mergeDb: context.mergeDb === true,
    globalSearch: context.globalSearch ?? '',
    columnFilters: canonicalizeFilters(context.columnFilters, context.columnId),
    fixedScope: canonicalizeFixedScope(context.fixedScope),
    query: context.query ?? '',
    limit: context.limit ?? null,
  });
}

const IMMEDIATE_SERVER_FACET_COLUMNS = new Set([
  'dbSource',
  'unit',
  'forgingMachine',
  'firstProcess',
  'productStatus',
  'fgStatus04',
  'subtypeCode',
  'versionStatus',
  'shipmentStatus',
  'salesStatus',
  'subProcessCode',
  'status',
  'sourceType',
  'processCode',
  'alreadyPicked',
  'issuedQtyState',
  'movementState',
  'warehouseCode',
  'stockStatus',
  'qualityStatus',
  'sourceWorkOrderType',
  'basisType',
  'movementType',
  'inputUnit',
  'category',
]);

export function createServerFacetedOptionSource(
  column: MrpColumnDef,
): Extract<ColumnOptionSource, { type: 'server' }> {
  const immediate = column.filterType === 'enum'
    || column.filterType === 'boolean'
    || IMMEDIATE_SERVER_FACET_COLUMNS.has(column.id);
  if (immediate) return { type: 'server', mode: 'faceted', limit: 100 };
  return {
    type: 'server',
    mode: 'faceted',
    minSearchLength: column.filterType === 'numeric' ? 1 : 2,
    limit: 50,
  };
}

export function withServerFacetedColumnOptions(
  columns: MrpColumnDef[],
): MrpColumnDef[] {
  return columns.map((column) => (
    column.filterable !== false && column.filterType
      ? {
          ...column,
          optionSource: column.optionSource?.type === 'server'
            ? column.optionSource
            : createServerFacetedOptionSource(column),
        }
      : column
  ));
}
