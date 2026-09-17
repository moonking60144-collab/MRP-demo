// Shared types for the data-table toolkit

export type SortDirection = 'asc' | 'desc';

export interface SortField {
  id: string;
  direction: SortDirection;
  label: string;
}

export interface SortState {
  fields: SortField[];
}

export type FilterOperator =
  | 'contains'
  | 'equals'
  | 'oneOf'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isEmpty'
  | 'isNotEmpty';

export interface ColumnFilter {
  columnId: string;
  operator: FilterOperator;
  value: string | number | [number, number] | string[];
  valueType?: ColumnFilterType;
}

export interface FilterState {
  globalSearch: string;
  columnFilters: ColumnFilter[];
}

export interface ColumnVisibilityState {
  [columnId: string]: boolean;
}

export interface TablePreset {
  id: number;
  tableId: string;
  presetName: string;
  isDefault: boolean;
  sorting: SortState;
  filtering: FilterState;
  columnVisibility: ColumnVisibilityState;
  createdAt: string;
  updatedAt: string;
}

export interface PresetCreateInput {
  tableId: string;
  presetName: string;
  isDefault?: boolean;
  sorting: SortState;
  filtering: FilterState;
  columnVisibility: ColumnVisibilityState;
}

export type ColumnFilterType = 'text' | 'numeric' | 'date' | 'enum' | 'boolean';

export type ColumnOptionSource =
  | { type: 'static' }
  | {
      type: 'server';
      mode: 'global' | 'faceted';
      minSearchLength?: number;
      limit?: number;
    };

export interface MrpColumnDef {
  id: string;
  header: string;
  description?: string;
  /** 欄位選單分組標題（沒設則歸入未分組區）。 */
  group?: string;
  filterType?: ColumnFilterType;
  enumValues?: string[];
  defaultVisible?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  hideable?: boolean;
  freezeable?: boolean;
  headerMenu?: boolean;
  optionSource?: ColumnOptionSource;
  width?: number;
  align?: 'left' | 'center' | 'right';
  mono?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface QuickFilterOption {
  label: string;
  value: string;
  matchFn?: (cellValue: string | null | undefined) => boolean;
}
