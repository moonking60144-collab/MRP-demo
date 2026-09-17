'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type {
  ColumnFilterOptionBaseContext,
  LoadColumnFilterOptions,
} from '../column-header-contract';
import type { ColumnFilter, FilterOperator, MrpColumnDef } from '../types';
import {
  buildColumnFilterFromDraft,
  createFilterEditorDraft,
  filterOperatorNeedsValue,
  getFilterOperators,
} from '../filter-editor-model';
import { useColumnFilterOptions } from './use-column-filter-options';

function renderDisplayVal(filter: ColumnFilter): string {
  if (filter.columnId === 'inventoryAnomalyCount' && filter.operator === 'gt' && filter.value === 0) {
    return '異常';
  }
  if (filter.operator === 'isEmpty') return '為空';
  if (filter.operator === 'isNotEmpty') return '非空';
  if (filter.operator === 'between' && Array.isArray(filter.value)) {
    return `${filter.value[0]}-${filter.value[1]}`;
  }
  if (filter.operator === 'oneOf' && Array.isArray(filter.value)) {
    const visible = filter.value.slice(0, 3).join('、');
    return filter.value.length > 3 ? `任一符合：${visible} 等 ${filter.value.length} 項` : `任一符合：${visible}`;
  }
  return `${filter.operator} ${filter.value}`;
}

export type FilterModalInitialFocus =
  | { type: 'edit'; columnId: string }
  | { type: 'new'; columnId?: string }
  | null;

interface FilterModalProps {
  open: boolean;
  onClose: () => void;
  columns: MrpColumnDef[];
  columnFilters: ColumnFilter[];
  onSetFilter: (filter: ColumnFilter) => void;
  onRemoveFilter: (columnId: string) => void;
  onClearAll: () => void;
  /** 'edit' 帶 columnId 預填表單；'new' 預設空白。 */
  initialFocus?: FilterModalInitialFocus;
  optionContext?: ColumnFilterOptionBaseContext;
  loadOptions?: LoadColumnFilterOptions;
  optionRows?: readonly Record<string, unknown>[];
}

export function FilterModal({
  open,
  onClose,
  columns,
  columnFilters,
  onSetFilter,
  onRemoveFilter,
  onClearAll,
  initialFocus,
  optionContext,
  loadOptions,
  optionRows,
}: FilterModalProps) {
  const filterableColumns = columns.filter(
    (col) => col.filterable !== false && col.filterType !== undefined,
  );

  const [selectedColumnId, setSelectedColumnId] = useState<string>('');
  const [operator, setOperator] = useState<FilterOperator>('contains');
  const [value, setValue] = useState<string>('');
  const [betweenMax, setBetweenMax] = useState<string>('');
  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  const [enumSearch, setEnumSearch] = useState('');
  const initializedFocusRef = React.useRef<FilterModalInitialFocus | undefined>(undefined);

  const loadDraftIntoForm = useCallback((draft: ReturnType<typeof createFilterEditorDraft>) => {
    setOperator(draft.operator);
    setValue(draft.value);
    setBetweenMax(draft.betweenMax);
    setSelectedValues(draft.selectedValues);
    setEnumSearch(draft.optionSearch);
  }, []);

  const loadFilterIntoForm = useCallback((f: ColumnFilter) => {
    setSelectedColumnId(f.columnId);
    const column = columns.find((candidate) => candidate.id === f.columnId);
    loadDraftIntoForm(createFilterEditorDraft(column?.filterType || 'text', f));
  }, [columns, loadDraftIntoForm]);

  const resetForm = useCallback(() => {
    setSelectedColumnId('');
    loadDraftIntoForm(createFilterEditorDraft('text'));
  }, [loadDraftIntoForm]);

  const selectEmptyColumn = useCallback((columnId: string) => {
    const column = columns.find((candidate) => candidate.id === columnId);
    if (!column) {
      resetForm();
      return;
    }
    setSelectedColumnId(columnId);
    loadDraftIntoForm(createFilterEditorDraft(column.filterType || 'text'));
  }, [columns, loadDraftIntoForm, resetForm]);

  // initialFocus 預填
  useEffect(() => {
    if (!open) {
      initializedFocusRef.current = undefined;
      return;
    }
    if (initializedFocusRef.current === initialFocus) return;
    initializedFocusRef.current = initialFocus ?? null;
    if (initialFocus?.type === 'edit') {
      const existing = columnFilters.find((f) => f.columnId === initialFocus.columnId);
      if (existing) loadFilterIntoForm(existing);
    } else if (initialFocus?.type === 'new') {
      if (initialFocus.columnId) selectEmptyColumn(initialFocus.columnId);
      else resetForm();
    } else {
      resetForm();
    }
  }, [columnFilters, initialFocus, loadFilterIntoForm, open, resetForm, selectEmptyColumn]);

  // ESC 關閉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const selectedColumn = columns.find((candidate) => candidate.id === selectedColumnId);
  const {
    options: enumOptions,
    loading: enumOptionsLoading,
    error: enumOptionsError,
    searchRequired: optionSearchRequired,
    minSearchLength: optionMinSearchLength,
  } = useColumnFilterOptions({
    active: open && !!selectedColumn,
    column: selectedColumn,
    selectedValues,
    query: enumSearch,
    optionContext,
    loadOptions,
    optionRows,
  });

  if (!open) return null;

  const filterType = selectedColumn?.filterType || 'text';
  const operators = getFilterOperators(filterType);
  const noValueNeeded = !filterOperatorNeedsValue(operator);
  const existingFilter = columnFilters.find((f) => f.columnId === selectedColumnId);
  const filterDraft = { operator, value, betweenMax, selectedValues, optionSearch: enumSearch };
  const pendingFilter = selectedColumn
    ? buildColumnFilterFromDraft(selectedColumn, filterDraft)
    : null;
  const canApply = pendingFilter !== null;
  const applyButtonLabel = existingFilter ? '更新條件' : '新增條件';

  const handleColumnSelect = (columnId: string) => {
    setSelectedColumnId(columnId);
    const existing = columnFilters.find((f) => f.columnId === columnId);
    if (existing) {
      loadFilterIntoForm(existing);
    } else {
      selectEmptyColumn(columnId);
    }
  };

  const handleApply = () => {
    if (!pendingFilter) return;
    onSetFilter(pendingFilter);
    resetForm();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-xl max-h-[85vh] bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">篩選設定</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
            title="關閉"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4 text-sm">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-2">
              已套用條件{columnFilters.length > 0 ? ` (${columnFilters.length})` : ''}
            </div>
            {columnFilters.length === 0 ? (
              <div className="text-xs text-slate-400 italic">尚未設定任何篩選條件</div>
            ) : (
              <div className="space-y-1.5">
                {columnFilters.map((f) => {
                  const col = columns.find((c) => c.id === f.columnId);
                  return (
                    <div
                      key={f.columnId}
                      className="flex items-center gap-2 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded"
                    >
                      <span className="text-xs text-amber-700 font-medium flex-1 truncate">
                        {col?.header || f.columnId}{' '}
                        <span className="text-amber-500 font-normal">{renderDisplayVal(f)}</span>
                      </span>
                      <button
                        onClick={() => loadFilterIntoForm(f)}
                        className="text-xs text-blue-600 hover:text-blue-800 px-1"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => onRemoveFilter(f.columnId)}
                        className="text-xs text-red-500 hover:text-red-700 px-1"
                      >
                        移除
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border border-slate-200 rounded p-3 space-y-2 bg-slate-50">
            <div className="text-xs font-medium text-slate-500">
              {existingFilter && selectedColumnId ? '編輯現有條件' : '新增條件'}
            </div>

            <div>
              <label className="block text-[11px] text-slate-500 mb-0.5">欄位</label>
              <select
                value={selectedColumnId}
                onChange={(e) => handleColumnSelect(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded px-2 py-1"
              >
                <option value="">— 請選擇欄位 —</option>
                {filterableColumns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.header}
                    {columnFilters.some((f) => f.columnId === col.id) ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedColumn && operator === 'oneOf' ? (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">條件</label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as FilterOperator)}
                    className="w-full text-xs border border-slate-200 rounded px-2 py-1 bg-white text-slate-700"
                  >
                    {operators.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-[11px] text-slate-500">勾選值</label>
                    <button
                      type="button"
                      onClick={() => setSelectedValues([])}
                      disabled={selectedValues.length === 0}
                      className="text-[11px] text-slate-400 hover:text-red-500 disabled:opacity-50"
                    >
                      清除全部
                    </button>
                  </div>
                  <input
                    type="search"
                    value={enumSearch}
                    onChange={(event) => setEnumSearch(event.target.value)}
                    placeholder={optionSearchRequired
                      ? `輸入至少 ${optionMinSearchLength} 個字搜尋`
                      : '搜尋選項...'}
                    className="mb-1.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                  />
                  <div className="space-y-1 max-h-[180px] overflow-y-auto border border-slate-200 rounded p-2 bg-white">
                  {enumOptionsLoading ? (
                    <div className="py-3 text-center text-xs text-slate-400">讀取選項中…</div>
                  ) : enumOptionsError ? (
                    <div className="py-3 text-center text-xs text-red-500">{enumOptionsError}</div>
                  ) : optionSearchRequired && enumOptions.length === 0 ? (
                    <div className="py-3 text-center text-xs text-slate-400">
                      輸入至少 {optionMinSearchLength} 個字後顯示選項
                    </div>
                  ) : enumOptions.map((option) => (
                    <label
                      key={option.value}
                      className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-slate-50 px-1 py-0.5 rounded"
                    >
                      <input
                        type="checkbox"
                        checked={selectedValues.includes(option.value)}
                        onChange={(e) => {
                          setSelectedValues((current) => e.target.checked
                            ? [...current, option.value]
                            : current.filter((selected) => selected !== option.value));
                        }}
                        className="rounded"
                      />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.count !== undefined && (
                        <span className="tabular-nums text-[10px] text-slate-400">
                          {option.count.toLocaleString()}
                        </span>
                      )}
                    </label>
                  ))}
                  {!enumOptionsLoading
                    && !enumOptionsError
                    && !optionSearchRequired
                    && enumOptions.length === 0 && (
                    <div className="py-3 text-center text-xs text-slate-400">
                      {enumSearch ? '找不到符合的選項' : '目前沒有可選值'}
                    </div>
                  )}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">已選 {selectedValues.length} 項</div>
                </div>
              </div>
            ) : selectedColumn && filterType === 'boolean' ? (
              <>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">條件</label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as FilterOperator)}
                    className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                  >
                    {operators.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                </div>
                {!noValueNeeded && (
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-0.5">值</label>
                    <select
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                    >
                      <option value="">— 請選擇 —</option>
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </select>
                  </div>
                )}
              </>
            ) : selectedColumn ? (
              <>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">條件</label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as FilterOperator)}
                    className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                  >
                    {operators.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                </div>

                {!noValueNeeded && (
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-0.5">值</label>
                    <input
                      type={filterType === 'numeric' ? 'number' : filterType === 'date' ? 'date' : 'text'}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={filterType === 'date' ? 'YYYY-MM-DD' : ''}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canApply) handleApply();
                      }}
                      className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                      autoFocus
                    />
                    {operator === 'between' && (
                      <input
                        type="number"
                        value={betweenMax}
                        onChange={(e) => setBetweenMax(e.target.value)}
                        placeholder="最大值"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && canApply) handleApply();
                        }}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1 mt-1"
                      />
                    )}
                  </div>
                )}
              </>
            ) : null}

            <button
              onClick={handleApply}
              disabled={!canApply}
              className="w-full text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {applyButtonLabel}
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between bg-slate-50">
          <button
            onClick={onClearAll}
            disabled={columnFilters.length === 0}
            className="text-xs text-slate-400 hover:text-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            全部清除
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded"
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
