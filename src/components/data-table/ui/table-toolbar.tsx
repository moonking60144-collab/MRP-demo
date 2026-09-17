'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { SortPanel } from './sort-panel';
import { FilterModal } from './filter-modal';
import {
  useFilterModalController,
  type FilterModalController,
} from './use-filter-modal-controller';
import { FilterChipsBar } from './filter-chips-bar';
import { ColumnSelector } from './column-selector';
import { PresetManager } from './preset-manager';
import type {
  SortField, SortState, FilterState, ColumnFilter, PresetCreateInput,
  ColumnVisibilityState, MrpColumnDef, TablePreset,
} from '../types';
import { sanitizePresetConfig } from '../preset-storage';
import type {
  ColumnFilterOptionBaseContext,
  LoadColumnFilterOptions,
} from '../column-header-contract';

const GLOBAL_SEARCH_DEBOUNCE_MS = 500;

interface TableToolbarProps {
  tableId: string;
  columns: MrpColumnDef[];
  // Sort
  sortFields: SortField[];
  onAddSort: (field: SortField) => void;
  onRemoveSort: (fieldId: string) => void;
  onToggleSortDirection: (fieldId: string) => void;
  onReorderSort: (fromIndex: number, toIndex: number) => void;
  onClearSort: () => void;
  onSetSort: (fields: SortField[]) => void;
  onResetSort?: () => void;
  // Filter
  globalSearch: string;
  onGlobalSearchChange: (search: string) => void;
  onSearchDraftChange?: (search: string) => void;
  searchStateReady?: boolean;
  restoredSession?: boolean;
  columnFilters: ColumnFilter[];
  onSetColumnFilter: (filter: ColumnFilter) => void;
  onRemoveColumnFilter: (columnId: string) => void;
  onClearAllFilters: () => void;
  onSetFilters: (state: FilterState) => void;
  // Column visibility
  visibility: ColumnVisibilityState;
  onToggleColumn: (columnId: string) => void;
  onShowAllColumns: () => void;
  onResetColumns: () => void;
  visibleCount: number;
  totalColumnCount: number;
  onSetColumnVisibility: (state: ColumnVisibilityState) => void;
  systemSorting: SortState;
  systemFiltering: FilterState;
  systemVisibility: ColumnVisibilityState;
  // Presets
  presets: TablePreset[];
  activePresetId: number | null;
  presetsLoading: boolean;
  onLoadPreset: (preset: TablePreset) => void;
  onSavePreset: (name: string, isDefault: boolean) => void;
  onUpdatePreset: (id: number, updates: Partial<PresetCreateInput>) => void;
  onDeletePreset: (id: number) => void;
  onSetDefaultPreset: (id: number) => void;
  onUnsetDefaultPreset: (id: number) => void;
  onUseSystemDefault: () => void;
  // Extra controls (e.g. view mode toggles, shortage filter)
  extraControls?: React.ReactNode;
  filterModalController?: FilterModalController;
  filterOptionContext?: ColumnFilterOptionBaseContext;
  loadFilterOptions?: LoadColumnFilterOptions;
  filterOptionRows?: readonly Record<string, unknown>[];
}

export function TableToolbar({
  tableId,
  columns,
  sortFields,
  onAddSort,
  onRemoveSort,
  onToggleSortDirection,
  onReorderSort,
  onClearSort,
  onResetSort,
  globalSearch,
  onGlobalSearchChange,
  onSearchDraftChange,
  searchStateReady = true,
  restoredSession = false,
  columnFilters,
  onSetColumnFilter,
  onRemoveColumnFilter,
  onClearAllFilters,
  visibility,
  onToggleColumn,
  onShowAllColumns,
  onResetColumns,
  visibleCount,
  totalColumnCount,
  presets,
  activePresetId,
  presetsLoading,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
  onSetDefaultPreset,
  onUnsetDefaultPreset,
  onSetSort,
  onSetFilters,
  onSetColumnVisibility,
  systemSorting,
  systemFiltering,
  systemVisibility,
  onUpdatePreset,
  onUseSystemDefault,
  extraControls,
  filterModalController,
  filterOptionContext,
  loadFilterOptions,
  filterOptionRows,
}: TableToolbarProps) {
  const [showSort, setShowSort] = useState(false);
  const [globalSearchDraft, setGlobalSearchDraft] = useState(globalSearch);
  const internalFilterModalController = useFilterModalController();
  const modalController = filterModalController || internalFilterModalController;

  useEffect(() => {
    setGlobalSearchDraft(globalSearch);
  }, [globalSearch]);

  useEffect(() => {
    if (globalSearchDraft === globalSearch) return;
    const timer = window.setTimeout(() => {
      onGlobalSearchChange(globalSearchDraft);
    }, GLOBAL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [globalSearch, globalSearchDraft, onGlobalSearchChange]);

  const openFilterForNew = useCallback(() => {
    modalController.openNew();
    setShowSort(false);
  }, [modalController]);
  const openFilterForEdit = useCallback((columnId: string) => {
    modalController.openEdit(columnId);
    setShowSort(false);
  }, [modalController]);

  const currentSorting = useMemo<SortState>(() => ({ fields: sortFields }), [sortFields]);
  const currentFiltering = useMemo<FilterState>(
    () => ({ globalSearch, columnFilters }),
    [globalSearch, columnFilters],
  );

  const handleLoadPreset = useCallback((preset: TablePreset) => {
    const config = sanitizePresetConfig(preset, columns.map((column) => column.id));
    onSetSort(config.sorting.fields);
    onSetFilters(config.filtering);
    onSetColumnVisibility(config.columnVisibility);
    onLoadPreset(preset);
  }, [columns, onSetSort, onSetFilters, onSetColumnVisibility, onLoadPreset]);

  const handleSavePreset = useCallback((name: string, isDefault: boolean) => {
    onSavePreset(name, isDefault);
  }, [onSavePreset]);

  const defaultLoadedForTableRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchStateReady && !presetsLoading && defaultLoadedForTableRef.current !== tableId) {
      const defaultPreset = presets.find((p) => p.isDefault);
      if (defaultPreset && !restoredSession) handleLoadPreset(defaultPreset);
      defaultLoadedForTableRef.current = tableId;
    }
  }, [tableId, presetsLoading, presets, handleLoadPreset, searchStateReady, restoredSession]);

  const handleUseSystemDefault = useCallback(() => {
    onSetSort(systemSorting.fields);
    onSetFilters(systemFiltering);
    onSetColumnVisibility(systemVisibility);
    onUseSystemDefault();
  }, [
    systemSorting,
    systemFiltering,
    systemVisibility,
    onSetSort,
    onSetFilters,
    onSetColumnVisibility,
    onUseSystemDefault,
  ]);

  const handleUpdateCurrentPreset = useCallback((id: number) => {
    onUpdatePreset(id, {
      sorting: currentSorting,
      filtering: currentFiltering,
      columnVisibility: visibility,
    });
  }, [onUpdatePreset, currentSorting, currentFiltering, visibility]);

  return (
    <div className="relative border border-slate-200 rounded-t-lg">
      {/* Main toolbar row */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-white">
        {/* Search */}
        <div className="relative min-w-48 flex-[1_1_12rem] max-w-xs">
          <input
            type="text"
            value={globalSearchDraft}
            onChange={(e) => {
              setGlobalSearchDraft(e.target.value);
              onSearchDraftChange?.(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                onGlobalSearchChange(globalSearchDraft);
              }
            }}
            placeholder="搜尋..."
            className="w-full text-xs border border-slate-200 rounded pl-7 pr-7 py-1.5"
          />
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {globalSearchDraft && (
            <button
              type="button"
              onClick={() => {
                setGlobalSearchDraft('');
                onSearchDraftChange?.('');
                onGlobalSearchChange('');
              }}
              aria-label="清除搜尋"
              title="清除搜尋"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700 leading-none text-[12px] font-bold"
            >
              ×
            </button>
          )}
        </div>

        {/* Sort toggle */}
        <button
          onClick={() => { setShowSort(!showSort); modalController.close(); }}
          className={`text-xs px-2.5 py-1.5 border rounded flex items-center gap-1 ${
            sortFields.length > 0
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          排序
          {sortFields.length > 0 && (
            <span className="bg-blue-200 text-blue-700 px-1 rounded text-[10px]">{sortFields.length}</span>
          )}
        </button>

        {/* Filter — 改 modal：點按鈕直接彈窗（不再 inline toggle 兩段操作）。 */}
        <button
          onClick={openFilterForNew}
          className={`text-xs px-2.5 py-1.5 border rounded flex items-center gap-1 ${
            columnFilters.length > 0
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          篩選
          {columnFilters.length > 0 && (
            <span className="bg-amber-200 text-amber-700 px-1 rounded text-[10px]">{columnFilters.length}</span>
          )}
        </button>

        {/* Column selector */}
        <ColumnSelector
          columns={columns}
          visibility={visibility}
          onToggle={onToggleColumn}
          onShowAll={onShowAllColumns}
          onReset={onResetColumns}
          visibleCount={visibleCount}
          totalCount={totalColumnCount}
        />

        {/* Preset manager */}
        <PresetManager
          presets={presets}
          activePresetId={activePresetId}
          loading={presetsLoading}
          columnIds={columns.map((column) => column.id)}
          currentSorting={currentSorting}
          currentFiltering={currentFiltering}
          currentVisibility={visibility}
          systemSorting={systemSorting}
          systemFiltering={systemFiltering}
          systemVisibility={systemVisibility}
          onLoad={handleLoadPreset}
          onUseSystemDefault={handleUseSystemDefault}
          onSave={handleSavePreset}
          onUpdateCurrent={handleUpdateCurrentPreset}
          onDelete={onDeletePreset}
          onSetDefault={onSetDefaultPreset}
          onUnsetDefault={onUnsetDefaultPreset}
        />

        {/* Extra controls (view modes, etc.) */}
        {extraControls}
      </div>

      {/* Collapsible sort panel */}
      {showSort && (
        <SortPanel
          sortFields={sortFields}
          columns={columns}
          onAdd={onAddSort}
          onRemove={onRemoveSort}
          onToggleDirection={onToggleSortDirection}
          onReorder={onReorderSort}
          onClear={onClearSort}
          onReset={onResetSort}
        />
      )}

      {/* Filter chip 列：有條件時常駐顯示。點 chip body 開 modal 編輯該條，× 直接移除。 */}
      <FilterChipsBar
        columns={columns}
        columnFilters={columnFilters}
        onEditFilter={openFilterForEdit}
        onRemoveFilter={onRemoveColumnFilter}
        onAddFilter={openFilterForNew}
        onClearAll={onClearAllFilters}
      />

      {/* Filter modal — controlled */}
      <FilterModal
        open={modalController.open}
        onClose={modalController.close}
        columns={columns}
        columnFilters={columnFilters}
        onSetFilter={onSetColumnFilter}
        onRemoveFilter={onRemoveColumnFilter}
        onClearAll={onClearAllFilters}
        initialFocus={modalController.initialFocus}
        optionContext={filterOptionContext}
        loadOptions={loadFilterOptions}
        optionRows={filterOptionRows}
      />
    </div>
  );
}
