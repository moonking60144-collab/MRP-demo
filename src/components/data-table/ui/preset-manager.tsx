'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  ChevronDown,
  MonitorCog,
  Plus,
  Save,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { ColumnVisibilityState, FilterState, SortState, TablePreset } from '../types';
import { presetConfigEquals, sanitizePresetConfig } from '../preset-storage';

interface PresetManagerProps {
  presets: TablePreset[];
  activePresetId: number | null;
  loading: boolean;
  columnIds: string[];
  currentSorting: SortState;
  currentFiltering: FilterState;
  currentVisibility: ColumnVisibilityState;
  systemSorting: SortState;
  systemFiltering: FilterState;
  systemVisibility: ColumnVisibilityState;
  onLoad: (preset: TablePreset) => void;
  onUseSystemDefault: () => void;
  onSave: (name: string, isDefault: boolean) => void;
  onUpdateCurrent: (id: number) => void;
  onDelete: (id: number) => void;
  onSetDefault: (id: number) => void;
  onUnsetDefault: (id: number) => void;
}

export function PresetManager({
  presets,
  activePresetId,
  loading,
  columnIds,
  currentSorting,
  currentFiltering,
  currentVisibility,
  systemSorting,
  systemFiltering,
  systemVisibility,
  onLoad,
  onUseSystemDefault,
  onSave,
  onUpdateCurrent,
  onDelete,
  onSetDefault,
  onUnsetDefault,
}: PresetManagerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [nameError, setNameError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const personalDefault = presets.find((preset) => preset.isDefault) ?? null;
  const selectedPreset = presets.find((preset) => preset.id === activePresetId) ?? null;
  const selectedConfig = selectedPreset ? sanitizePresetConfig(selectedPreset, columnIds) : null;
  const selectedPresetIsCurrent = selectedPreset !== null && selectedConfig !== null && presetConfigEquals(
    currentSorting,
    currentFiltering,
    currentVisibility,
    selectedConfig.sorting,
    selectedConfig.filtering,
    selectedConfig.columnVisibility,
  );
  const systemIsCurrent = presetConfigEquals(
    currentSorting,
    currentFiltering,
    currentVisibility,
    systemSorting,
    systemFiltering,
    systemVisibility,
  );
  const currentLabel = selectedPresetIsCurrent
    ? selectedPreset.presetName
    : systemIsCurrent
      ? '系統預設'
      : '自訂檢視';

  const presetSummaries = useMemo(() => presets.map((preset) => {
    const config = sanitizePresetConfig(preset, columnIds);
    const visibleColumns = columnIds.filter((id) => config.columnVisibility[id] !== false).length;
    return {
      preset,
      sortCount: config.sorting.fields.length,
      filterCount: config.filtering.columnFilters.length,
      visibleColumns,
    };
  }), [presets, columnIds]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    if (open) {
      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setSaving(false);
    setConfirmDeleteId(null);
    setNameError('');
  };

  const handleSave = () => {
    const name = newName.trim();
    if (!name) {
      setNameError('請輸入名稱');
      return;
    }
    if (presets.some((preset) => preset.presetName.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setNameError('已有相同名稱');
      return;
    }
    onSave(name, newIsDefault);
    setNewName('');
    setNewIsDefault(false);
    setNameError('');
    setSaving(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-8 max-w-[11rem] px-2.5 border rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors duration-150 ${
          selectedPresetIsCurrent
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
            : !systemIsCurrent
              ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        }`}
        title={`目前檢視：${currentLabel}`}
      >
        <Bookmark className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{loading ? '載入中' : currentLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="檢視預設"
          className="fixed inset-x-3 top-16 z-[70] flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-md border border-slate-300 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[23rem] sm:max-h-[min(34rem,calc(100vh-8rem))]"
        >
          <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">檢視預設</div>
              <div className="mt-0.5 text-[11px] text-slate-500">個人設定僅儲存在此瀏覽器</div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="關閉檢視預設"
              title="關閉"
              className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-[10px] font-semibold text-slate-500">一般</div>
              <div className={`flex items-center gap-2 rounded px-2 py-2 ${systemIsCurrent ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                <button
                  type="button"
                  onClick={() => { onUseSystemDefault(); close(); }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-600">
                    <MonitorCog className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-slate-800">系統預設</span>
                    <span className="block truncate text-[11px] text-slate-500">回復原始排序、篩選與欄位</span>
                  </span>
                  {systemIsCurrent && <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="目前使用中" />}
                </button>
                {personalDefault && (
                  <button
                    type="button"
                    onClick={() => onUnsetDefault(personalDefault.id)}
                    aria-label="改用系統預設作為開啟時檢視"
                    title="改用系統預設作為開啟時檢視"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-amber-500"
                  >
                    <Star className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            <div className="border-t border-slate-100 px-2 py-2">
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-[10px] font-semibold text-slate-500">我的預設</span>
                <span className="text-[10px] tabular-nums text-slate-400">{presets.length}</span>
              </div>

              {loading ? (
                <div className="space-y-2 px-2 py-3" aria-label="載入個人預設">
                  <div className="h-8 animate-pulse rounded bg-slate-100" />
                  <div className="h-8 animate-pulse rounded bg-slate-100" />
                </div>
              ) : presetSummaries.length === 0 ? (
                <div className="px-2 py-5 text-center text-xs text-slate-400">尚無個人預設</div>
              ) : (
                <div className="space-y-0.5">
                  {presetSummaries.map(({ preset, sortCount, filterCount, visibleColumns }) => {
                    const current = selectedPresetIsCurrent && preset.id === selectedPreset?.id;
                    const confirmingDelete = confirmDeleteId === preset.id;
                    return (
                      <div key={preset.id} className={`group flex items-center gap-1 rounded px-2 py-1.5 ${current ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
                        {confirmingDelete ? (
                          <>
                            <span className="min-w-0 flex-1 text-xs text-red-700">刪除「{preset.presetName}」？</span>
                            <button
                              type="button"
                              onClick={() => { onDelete(preset.id); setConfirmDeleteId(null); }}
                              className="h-7 rounded bg-red-600 px-2 text-[11px] font-medium text-white hover:bg-red-700"
                            >
                              刪除
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="h-7 rounded px-2 text-[11px] text-slate-600 hover:bg-white"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => { onLoad(preset); close(); }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <Bookmark className={`h-4 w-4 shrink-0 ${current ? 'text-emerald-600' : 'text-slate-400'}`} aria-hidden="true" />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate text-xs font-medium text-slate-800">{preset.presetName}</span>
                                  {preset.isDefault && (
                                    <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">開啟時</span>
                                  )}
                                </span>
                                <span className="block text-[10px] tabular-nums text-slate-400">
                                  排序 {sortCount} · 篩選 {filterCount} · 欄位 {visibleColumns}/{columnIds.length}
                                </span>
                              </span>
                              {current && <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="目前使用中" />}
                            </button>
                            <div className="flex shrink-0 items-center">
                              <button
                                type="button"
                                onClick={() => onUpdateCurrent(preset.id)}
                                aria-label={`以目前檢視更新 ${preset.presetName}`}
                                title="以目前檢視更新"
                                className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-blue-600"
                              >
                                <Save className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => preset.isDefault ? onUnsetDefault(preset.id) : onSetDefault(preset.id)}
                                aria-label={preset.isDefault ? `取消 ${preset.presetName} 的開啟時套用` : `開啟頁面時套用 ${preset.presetName}`}
                                title={preset.isDefault ? '取消開啟時套用' : '開啟頁面時套用'}
                                className={`flex h-7 w-7 items-center justify-center rounded hover:bg-white ${preset.isDefault ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'}`}
                              >
                                <Star className="h-3.5 w-3.5" fill={preset.isDefault ? 'currentColor' : 'none'} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(preset.id)}
                                aria-label={`刪除 ${preset.presetName}`}
                                title="刪除"
                                className="flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-white hover:text-red-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-slate-200 bg-slate-50 px-3 py-3">
            {saving ? (
              <div className="space-y-2">
                <label className="block text-[11px] font-medium text-slate-600" htmlFor="preset-name">預設名稱</label>
                <input
                  id="preset-name"
                  type="text"
                  value={newName}
                  onChange={(event) => { setNewName(event.target.value); setNameError(''); }}
                  placeholder="例如：SY 會審"
                  className={`h-9 w-full rounded border bg-white px-2.5 text-sm text-slate-800 outline-none focus:ring-2 ${nameError ? 'border-red-300 focus:ring-red-100' : 'border-slate-300 focus:border-blue-400 focus:ring-blue-100'}`}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleSave();
                    if (event.key === 'Escape') setSaving(false);
                  }}
                />
                {nameError && <div className="text-[11px] text-red-600">{nameError}</div>}
                <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={newIsDefault}
                    onChange={(event) => setNewIsDefault(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  開啟此頁時自動套用
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setSaving(false); setNameError(''); }}
                    className="h-8 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    className="h-8 rounded bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    儲存
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                儲存目前檢視
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
