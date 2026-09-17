import type {
  ColumnFilter,
  ColumnVisibilityState,
  FilterState,
  PresetCreateInput,
  SortField,
  SortState,
  TablePreset,
} from './types';

const STORAGE_PREFIX = 'mrp_table_presets:';
const STORAGE_VERSION = 1;

type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface StoredPresetEnvelope {
  version: number;
  presets: TablePreset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSortFields(value: unknown): SortField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: SortField[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== 'string' || (item.direction !== 'asc' && item.direction !== 'desc')) return null;
    fields.push({
      id: item.id,
      direction: item.direction,
      label: typeof item.label === 'string' ? item.label : item.id,
    });
  }
  return fields;
}

function parseColumnFilters(value: unknown): ColumnFilter[] | null {
  if (!Array.isArray(value)) return null;
  const filters: ColumnFilter[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.columnId !== 'string' || typeof item.operator !== 'string') return null;
    const filterValue = item.value;
    const validValue = typeof filterValue === 'string'
      || typeof filterValue === 'number'
      || (Array.isArray(filterValue)
        && (
          (item.operator === 'between'
            && filterValue.length === 2
            && filterValue.every((entry) => typeof entry === 'number'))
          || (item.operator === 'oneOf'
            && filterValue.length > 0
            && filterValue.every((entry) => typeof entry === 'string' && entry.trim()))
        ));
    if (!validValue) return null;
    filters.push(item as unknown as ColumnFilter);
  }
  return filters;
}

function parseVisibility(value: unknown): ColumnVisibilityState | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, visible]) => typeof visible !== 'boolean')) return null;
  return Object.fromEntries(entries) as ColumnVisibilityState;
}

function parsePreset(value: unknown, tableId: string): TablePreset | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) return null;
  if (typeof value.presetName !== 'string' || !value.presetName.trim()) return null;
  if (!isRecord(value.sorting) || !isRecord(value.filtering)) return null;

  const fields = parseSortFields(value.sorting.fields);
  const filters = parseColumnFilters(value.filtering.columnFilters);
  const visibility = parseVisibility(value.columnVisibility);
  if (!fields || !filters || !visibility) return null;

  return {
    id: value.id,
    tableId,
    presetName: value.presetName.trim(),
    isDefault: value.isDefault === true,
    sorting: { fields },
    filtering: {
      globalSearch: typeof value.filtering.globalSearch === 'string' ? value.filtering.globalSearch : '',
      columnFilters: filters,
    },
    columnVisibility: visibility,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function tablePresetStorageKey(tableId: string): string {
  return `${STORAGE_PREFIX}${tableId}`;
}

export function readLocalTablePresets(storage: Pick<PresetStorage, 'getItem'>, tableId: string): TablePreset[] {
  try {
    const raw = storage.getItem(tablePresetStorageKey(tableId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.presets)
        ? parsed.presets
        : [];
    const presets = values
      .map((value) => parsePreset(value, tableId))
      .filter((preset): preset is TablePreset => preset !== null);

    let foundDefault = false;
    return presets.map((preset) => {
      if (!preset.isDefault) return preset;
      if (foundDefault) return { ...preset, isDefault: false };
      foundDefault = true;
      return preset;
    });
  } catch {
    return [];
  }
}

export function writeLocalTablePresets(
  storage: Pick<PresetStorage, 'setItem'>,
  tableId: string,
  presets: TablePreset[],
): void {
  const payload: StoredPresetEnvelope = { version: STORAGE_VERSION, presets };
  storage.setItem(tablePresetStorageKey(tableId), JSON.stringify(payload));
}

export function createLocalTablePreset(
  input: PresetCreateInput,
  id: number,
  now = new Date().toISOString(),
): TablePreset {
  return {
    id,
    tableId: input.tableId,
    presetName: input.presetName.trim(),
    isDefault: input.isDefault === true,
    sorting: input.sorting,
    filtering: input.filtering,
    columnVisibility: input.columnVisibility,
    createdAt: now,
    updatedAt: now,
  };
}

export function setDefaultLocalTablePreset(presets: TablePreset[], id: number | null): TablePreset[] {
  return presets.map((preset) => ({ ...preset, isDefault: id !== null && preset.id === id }));
}

export function sanitizePresetConfig(preset: TablePreset, columnIds: string[]): {
  sorting: SortState;
  filtering: FilterState;
  columnVisibility: ColumnVisibilityState;
} {
  const validIds = new Set(columnIds);
  return {
    sorting: {
      fields: preset.sorting.fields.filter((field) => validIds.has(field.id)),
    },
    filtering: {
      globalSearch: preset.filtering.globalSearch,
      columnFilters: preset.filtering.columnFilters.filter((filter) => validIds.has(filter.columnId)),
    },
    columnVisibility: Object.fromEntries(
      Object.entries(preset.columnVisibility).filter(([columnId]) => validIds.has(columnId)),
    ),
  };
}

function filtersEqual(left: ColumnFilter[], right: ColumnFilter[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortingEqual(left: SortField[], right: SortField[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((field, index) => (
    field.id === right[index]?.id && field.direction === right[index]?.direction
  ));
}

function visibilityEqual(left: ColumnVisibilityState, right: ColumnVisibilityState): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => (left[key] !== false) === (right[key] !== false));
}

export function presetConfigEquals(
  sorting: SortState,
  filtering: FilterState,
  visibility: ColumnVisibilityState,
  targetSorting: SortState,
  targetFiltering: FilterState,
  targetVisibility: ColumnVisibilityState,
): boolean {
  return sortingEqual(sorting.fields, targetSorting.fields)
    && filtering.globalSearch === targetFiltering.globalSearch
    && filtersEqual(filtering.columnFilters, targetFiltering.columnFilters)
    && visibilityEqual(visibility, targetVisibility);
}
