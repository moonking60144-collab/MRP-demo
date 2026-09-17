'use client';

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  EyeOff,
  Filter,
  ListFilter,
  LockKeyhole,
  Search,
  X,
} from 'lucide-react';
import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  buildColumnFilterFromDraft,
  createFilterEditorDraft,
  filterOperatorNeedsValue,
  getFilterOperators,
  type FilterEditorDraft,
} from '../filter-editor-model';
import {
  getColumnHeaderCapabilities,
  hasColumnHeaderMenu,
  type ColumnFilterOptionBaseContext,
  type LoadColumnFilterOptions,
} from '../column-header-contract';
import type { ColumnFilter, MrpColumnDef, SortField } from '../types';
import { useColumnFilterOptions } from './use-column-filter-options';
import {
  useFilterModalController,
  type FilterModalController,
} from './use-filter-modal-controller';

export interface UseColumnHeaderMenuOptions {
  columnFilters: ColumnFilter[];
  sortFields: SortField[];
  onSetFilter: (filter: ColumnFilter) => void;
  onRemoveFilter: (columnId: string) => void;
  onPrioritizeSort: (field: SortField) => void;
  onRemoveSort: (columnId: string) => void;
  onToggleColumn?: (columnId: string) => void;
  onFreezeToColumn?: (columnId: string) => void;
  canFreezeColumn?: (columnId: string) => boolean;
  filterModalController: FilterModalController;
  optionContext?: ColumnFilterOptionBaseContext;
  loadOptions?: LoadColumnFilterOptions;
  optionRows?: readonly Record<string, unknown>[];
}

export function useColumnHeaderMenu(options: UseColumnHeaderMenuOptions) {
  const [open, setOpen] = useState(false);
  const [activeColumn, setActiveColumn] = useState<MrpColumnDef | null>(null);
  const openStateRef = useRef({ open, activeColumnId: activeColumn?.id ?? null });
  openStateRef.current = { open, activeColumnId: activeColumn?.id ?? null };

  const filteredColumnIds = useMemo(
    () => new Set(options.columnFilters.map((filter) => filter.columnId)),
    [options.columnFilters],
  );
  const sortByColumnId = useMemo(
    () => new Map(options.sortFields.map((field, index) => [field.id, { field, index }])),
    [options.sortFields],
  );

  const close = useCallback(() => {
    setOpen(false);
    setActiveColumn(null);
  }, []);

  const floating = useFloating({
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) close();
    },
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [
      offset(5),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.setProperty(
            '--column-header-menu-max-height',
            `${Math.max(0, availableHeight)}px`,
          );
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(floating.context, { outsidePress: true, escapeKey: true });
  const role = useRole(floating.context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const openColumnMenu = useCallback((column: MrpColumnDef, anchor: HTMLElement) => {
    if (!hasColumnHeaderMenu(column)) return;
    if (openStateRef.current.open && openStateRef.current.activeColumnId === column.id) {
      close();
      return;
    }
    floating.refs.setReference(anchor);
    setActiveColumn(column);
    setOpen(true);
  }, [close, floating.refs]);

  const removeFilter = useCallback(() => {
    if (!activeColumn) return;
    options.onRemoveFilter(activeColumn.id);
    close();
  }, [activeColumn, close, options]);

  const applySort = useCallback((direction: 'asc' | 'desc') => {
    if (!activeColumn) return;
    options.onPrioritizeSort({ id: activeColumn.id, label: activeColumn.header, direction });
    close();
  }, [activeColumn, close, options]);

  const removeSort = useCallback(() => {
    if (!activeColumn) return;
    options.onRemoveSort(activeColumn.id);
    close();
  }, [activeColumn, close, options]);

  const openAdvanced = useCallback(() => {
    if (!activeColumn) return;
    const columnId = activeColumn.id;
    const hasExistingFilter = options.columnFilters.some((filter) => filter.columnId === columnId);
    close();
    if (hasExistingFilter) options.filterModalController.openEdit(columnId);
    else options.filterModalController.openNew(columnId);
  }, [activeColumn, close, options]);

  return {
    ...options,
    open,
    activeColumn,
    openColumnMenu,
    close,
    filteredColumnIds,
    sortByColumnId,
    removeFilter,
    applySort,
    removeSort,
    openAdvanced,
    floating,
    getFloatingProps,
  };
}

export type ColumnHeaderMenuController = ReturnType<typeof useColumnHeaderMenu>;

export type UseTableColumnHeaderMenuOptions = Omit<
  UseColumnHeaderMenuOptions,
  'filterModalController'
>;

export function useTableColumnHeaderMenu(options: UseTableColumnHeaderMenuOptions) {
  const filterModalController = useFilterModalController();
  const menuController = useColumnHeaderMenu({ ...options, filterModalController });
  return { filterModalController, menuController };
}

interface ColumnHeaderButtonProps {
  column: MrpColumnDef;
  controller: ColumnHeaderMenuController;
  label?: React.ReactNode;
  className?: string;
  labelClassName?: string;
  labelMaxLines?: 2 | 3 | 4;
}

interface ColumnHeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  column: MrpColumnDef;
  controller: ColumnHeaderMenuController;
  buttonClassName?: string;
  labelMaxLines?: 2 | 3 | 4;
}

export function ColumnHeaderCell({
  column,
  controller,
  className = '',
  buttonClassName,
  labelMaxLines,
  ...thProps
}: ColumnHeaderCellProps) {
  const alignment = column.align === 'right'
    ? 'text-right'
    : column.align === 'center'
      ? 'text-center'
      : 'text-left';
  return (
    <th
      {...thProps}
      className={`${alignment} ${column.headerClassName || ''} ${className}`}
      style={{
        ...(column.width ? { width: column.width } : {}),
        ...thProps.style,
      }}
    >
      <ColumnHeaderButton
        column={column}
        controller={controller}
        className={buttonClassName}
        labelMaxLines={labelMaxLines}
        labelClassName={`${alignment === 'text-right' ? 'flex-1 text-right' : alignment === 'text-center' ? 'flex-1 text-center' : 'text-left'}`}
      />
    </th>
  );
}

function ColumnHeaderButtonComponent({
  column,
  controller,
  label,
  className = '',
  labelClassName = '',
  labelMaxLines = 2,
}: ColumnHeaderButtonProps) {
  const descriptionId = useId();
  const sortState = controller.sortByColumnId.get(column.id);
  const sortIndex = sortState?.index ?? -1;
  const sort = sortState?.field;
  const filtered = controller.filteredColumnIds.has(column.id);
  const active = controller.open && controller.activeColumn?.id === column.id;
  const enabled = hasColumnHeaderMenu(column);
  const hasPersistentStatus = filtered || !!sort;
  const statusMinWidth = filtered && sort
    ? 'min-w-[58px]'
    : hasPersistentStatus ? 'min-w-[44px]' : '';

  if (!enabled) return <span className={labelClassName} title={column.description}>{label ?? column.header}</span>;

  return (
    <button
      type="button"
      onClick={(event) => controller.openColumnMenu(column, event.currentTarget)}
      aria-haspopup="dialog"
      aria-expanded={active}
      title={`${column.header}：${column.description ? `${column.description}\n` : ''}篩選、排序與欄位操作`}
      aria-describedby={column.description ? descriptionId : undefined}
      className={`group/header relative flex h-full min-h-6 w-full items-center gap-0.5 rounded-sm px-0.5 py-0.5 text-inherit outline-none transition-colors hover:bg-slate-900/5 focus-visible:ring-2 focus-visible:ring-blue-500/40 ${statusMinWidth} ${active ? 'bg-blue-100/80 text-blue-900' : ''} ${className}`}
    >
      <span style={{ maxHeight: `${(labelMaxLines * 1.15 + 0.05).toFixed(2)}em` }} className={`block min-w-0 flex-1 overflow-hidden whitespace-pre-line break-words leading-[1.15] ${hasPersistentStatus ? '' : 'pr-3.5'} ${labelClassName}`}>
        {label ?? column.header}
      </span>
      {hasPersistentStatus && (
      <span className="pointer-events-none flex shrink-0 items-center gap-0.5 whitespace-nowrap">
        {filtered && <Filter className="h-3 w-3 text-amber-600" strokeWidth={2.4} aria-label="已篩選" />}
        {sort && (
          <span className="inline-flex items-center rounded-sm bg-blue-50 px-0.5 text-[9px] font-semibold leading-4 tabular-nums text-blue-700" aria-label={`排序第 ${sortIndex + 1} 順位`}>
            {sort.direction === 'asc' ? '↑' : '↓'}{sortIndex + 1}
          </span>
        )}
      </span>
      )}
      {!hasPersistentStatus && (
        <ChevronDown
          className={`pointer-events-none absolute right-0.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400 opacity-0 transition-[color,opacity,transform] group-hover/header:opacity-100 group-focus-visible/header:opacity-100 ${active ? 'rotate-180 text-blue-600 opacity-100' : 'group-hover/header:text-slate-600'}`}
          aria-hidden="true"
        />
      )}
      {column.description && <span id={descriptionId} className="sr-only">{column.description}</span>}
    </button>
  );
}

function areColumnHeaderButtonPropsEqual(
  previous: ColumnHeaderButtonProps,
  next: ColumnHeaderButtonProps,
): boolean {
  if (
    previous.column !== next.column
    || previous.label !== next.label
    || previous.className !== next.className
    || previous.labelClassName !== next.labelClassName
    || previous.labelMaxLines !== next.labelMaxLines
    || previous.controller.openColumnMenu !== next.controller.openColumnMenu
  ) return false;

  const columnId = next.column.id;
  const previousSort = previous.controller.sortByColumnId.get(columnId);
  const nextSort = next.controller.sortByColumnId.get(columnId);
  return previous.controller.filteredColumnIds.has(columnId) === next.controller.filteredColumnIds.has(columnId)
    && (previous.controller.open && previous.controller.activeColumn?.id === columnId)
      === (next.controller.open && next.controller.activeColumn?.id === columnId)
    && previousSort?.index === nextSort?.index
    && previousSort?.field.direction === nextSort?.field.direction;
}

export const ColumnHeaderButton = React.memo(
  ColumnHeaderButtonComponent,
  areColumnHeaderButtonPropsEqual,
);

interface ColumnHeaderMenuProps {
  controller: ColumnHeaderMenuController;
}

export function ColumnHeaderMenu({ controller }: ColumnHeaderMenuProps) {
  const column = controller.activeColumn;
  if (!controller.open || !column) return null;

  return (
    <ColumnHeaderMenuContent
      key={column.id}
      column={column}
      controller={controller}
    />
  );
}

interface ColumnHeaderMenuContentProps {
  column: MrpColumnDef;
  controller: ColumnHeaderMenuController;
}

function ColumnHeaderMenuContent({
  column,
  controller,
}: ColumnHeaderMenuContentProps) {
  const loadOptions = controller.loadOptions;
  const optionContext = controller.optionContext;
  const existingFilter = controller.columnFilters.find(
    (filter) => filter.columnId === column.id,
  );
  const existingSortState = controller.sortByColumnId.get(column.id);
  const existingSort = existingSortState?.field;
  const existingSortIndex = existingSortState?.index ?? -1;
  const [draft, setDraft] = useState<FilterEditorDraft>(() => (
    createFilterEditorDraft(column.filterType || 'text', existingFilter)
  ));
  const {
    options: filteredOptions,
    loading: optionsLoading,
    error: optionsError,
    searchRequired: optionSearchRequired,
    minSearchLength: optionMinSearchLength,
  } = useColumnFilterOptions({
    active: controller.open,
    column,
    selectedValues: draft.selectedValues,
    query: draft.optionSearch,
    optionContext,
    loadOptions,
    optionRows: controller.optionRows,
  });
  const pendingFilter = buildColumnFilterFromDraft(column, draft);

  const capabilities = getColumnHeaderCapabilities(column);
  const filterType = column.filterType || 'text';
  const operators = getFilterOperators(filterType);
  const needsValue = filterOperatorNeedsValue(draft.operator);
  const canFreeze = capabilities.freezeable
    && !!controller.onFreezeToColumn
    && (controller.canFreezeColumn?.(column.id) ?? true);

  const updateDraft = (changes: Partial<FilterEditorDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const toggleOptionValue = (value: string, checked: boolean) => {
    setDraft((current) => ({
      ...current,
      operator: 'oneOf',
      selectedValues: checked
        ? [...new Set([...current.selectedValues, value])]
        : current.selectedValues.filter((selected) => selected !== value),
    }));
  };
  const commitFilter = () => {
    if (!pendingFilter) return;
    controller.onSetFilter(pendingFilter);
    controller.close();
  };

  return (
    <FloatingPortal>
      <FloatingFocusManager
        context={controller.floating.context}
        modal={false}
        returnFocus
      >
        <div
          ref={controller.floating.refs.setFloating}
          style={controller.floating.floatingStyles}
          {...controller.getFloatingProps({
            className: 'z-[120] flex max-h-[var(--column-header-menu-max-height)] w-[20rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-left text-xs text-slate-700 shadow-[0_18px_48px_-14px_rgba(15,23,42,0.38)]',
            'aria-label': `${column.header}欄位選單`,
          })}
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-slate-900">{column.header}</div>
              <div className="mt-0.5 truncate font-mono text-[9px] text-slate-400">{column.id}</div>
            </div>
            <button
              type="button"
              onClick={controller.close}
              aria-label="關閉欄位選單"
              title="關閉"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {capabilities.sortable && (
              <section className="border-b border-slate-200 py-1.5">
                <div className="px-3 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">排序</div>
                <button
                  type="button"
                  onClick={() => controller.applySort('asc')}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-50 ${existingSort?.direction === 'asc' ? 'font-semibold text-blue-700' : ''}`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                  從小到大
                  {existingSort?.direction === 'asc' && <span className="ml-auto text-[10px]">第 {existingSortIndex + 1} 順位</span>}
                </button>
                <button
                  type="button"
                  onClick={() => controller.applySort('desc')}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-50 ${existingSort?.direction === 'desc' ? 'font-semibold text-blue-700' : ''}`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  從大到小
                  {existingSort?.direction === 'desc' && <span className="ml-auto text-[10px]">第 {existingSortIndex + 1} 順位</span>}
                </button>
                {existingSort && (
                  <button
                    type="button"
                    onClick={controller.removeSort}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                  >
                    <X className="h-3.5 w-3.5" />
                    清除此欄排序
                  </button>
                )}
              </section>
            )}

            {capabilities.filterable && (
              <section className="border-b border-slate-200 px-3 py-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-600">
                    <ListFilter className="h-3.5 w-3.5" />
                    欄位篩選
                  </div>
                  {existingFilter && (
                    <button
                      type="button"
                      onClick={controller.removeFilter}
                      className="text-[10px] font-medium text-red-500 hover:text-red-700"
                    >
                      移除此欄條件
                    </button>
                  )}
                </div>

                {draft.operator === 'oneOf' ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="search"
                        value={draft.optionSearch}
                        onChange={(event) => updateDraft({ optionSearch: event.target.value })}
                        placeholder={optionSearchRequired
                          ? `輸入至少 ${optionMinSearchLength} 個字搜尋`
                          : '搜尋選項'}
                        className="h-8 w-full rounded border border-slate-300 bg-white pl-7 pr-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-500">
                      <span>已選 {draft.selectedValues.length} 項</span>
                      <button
                        type="button"
                        onClick={() => updateDraft({ selectedValues: [] })}
                        disabled={draft.selectedValues.length === 0}
                        className="font-medium text-slate-500 hover:text-red-600 disabled:opacity-40"
                      >
                        清除草稿
                      </button>
                    </div>
                    <div className="max-h-52 overflow-y-auto rounded border border-slate-200 bg-white py-1">
                      {optionsLoading ? (
                        <div className="px-3 py-5 text-center text-slate-400">讀取選項中…</div>
                      ) : optionsError ? (
                        <div className="px-3 py-5 text-center text-red-500">{optionsError}</div>
                      ) : optionSearchRequired && filteredOptions.length === 0 ? (
                        <div className="px-3 py-5 text-center text-slate-400">
                          輸入至少 {optionMinSearchLength} 個字後顯示選項
                        </div>
                      ) : filteredOptions.length === 0 ? (
                        <div className="px-3 py-5 text-center text-slate-400">找不到符合的選項</div>
                      ) : filteredOptions.map((option) => {
                        const checked = draft.selectedValues.includes(option.value);
                        return (
                          <label key={option.value} className="flex min-h-7 cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-blue-50">
                            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'}`}>
                              {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                            </span>
                            <input
                              type="checkbox"
                              value={option.value}
                              aria-label={option.label}
                              checked={checked}
                              onChange={(event) => toggleOptionValue(option.value, event.target.checked)}
                              className="sr-only"
                            />
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.count !== undefined && <span className="tabular-nums text-[10px] text-slate-400">{option.count.toLocaleString()}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={draft.operator}
                      onChange={(event) => updateDraft({ operator: event.target.value as FilterEditorDraft['operator'] })}
                      className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {operators.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                    </select>
                    {needsValue && filterType === 'boolean' ? (
                      <select
                        value={draft.value}
                        onChange={(event) => updateDraft({ value: event.target.value })}
                        className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      >
                        <option value="">— 請選擇 —</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : needsValue ? (
                      <div className="flex gap-1.5">
                        <input
                          type={filterType === 'numeric' ? 'number' : filterType === 'date' ? 'date' : 'text'}
                          value={draft.value}
                          onChange={(event) => updateDraft({ value: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && pendingFilter) commitFilter();
                          }}
                          placeholder={filterType === 'text' ? '輸入篩選文字' : undefined}
                          className="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        />
                        {draft.operator === 'between' && (
                          <input
                            type="number"
                            value={draft.betweenMax}
                            onChange={(event) => updateDraft({ betweenMax: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && pendingFilter) commitFilter();
                            }}
                            placeholder="最大值"
                            className="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                        )}
                      </div>
                    ) : null}
                  </div>
                )}

                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDraft(createFilterEditorDraft(filterType))}
                    className="h-8 rounded border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                  >
                    清除草稿
                  </button>
                  <button
                    type="button"
                    onClick={commitFilter}
                    disabled={!pendingFilter}
                    className="ml-auto h-8 rounded bg-blue-600 px-3 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {existingFilter ? '更新篩選' : '套用篩選'}
                  </button>
                </div>
              </section>
            )}

            <section className="py-1.5">
              {capabilities.filterable && (
                <button
                  type="button"
                  onClick={controller.openAdvanced}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-blue-700 hover:bg-blue-50"
                >
                  <ListFilter className="h-3.5 w-3.5" />
                  進階篩選設定…
                </button>
              )}
              {capabilities.hideable && controller.onToggleColumn && (
                <button
                  type="button"
                  onClick={() => {
                    controller.onToggleColumn?.(column.id);
                    controller.close();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  隱藏此欄
                </button>
              )}
              {canFreeze && (
                <button
                  type="button"
                  onClick={() => {
                    controller.onFreezeToColumn?.(column.id);
                    controller.close();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                >
                  <LockKeyhole className="h-3.5 w-3.5" />
                  凍結到此欄
                </button>
              )}
            </section>
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
