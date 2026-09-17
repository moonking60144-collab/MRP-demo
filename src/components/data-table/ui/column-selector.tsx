'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Columns3, Eye, EyeOff, RotateCcw, Search, X } from 'lucide-react';
import type { ColumnVisibilityState, MrpColumnDef } from '../types';

interface ColumnSelectorProps {
  columns: MrpColumnDef[];
  visibility: ColumnVisibilityState;
  onToggle: (columnId: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  visibleCount: number;
  totalCount: number;
}

export function ColumnSelector({
  columns,
  visibility,
  onToggle,
  onShowAll,
  onReset,
  visibleCount,
  totalCount,
}: ColumnSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

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

  const isVisible = (id: string) => visibility[id] !== false;

  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query
      ? columns.filter((column) => (
        column.header.toLocaleLowerCase().includes(query)
        || column.id.toLocaleLowerCase().includes(query)
      ))
      : columns;
    const result: { name: string; columns: MrpColumnDef[] }[] = [];
    for (const column of filtered) {
      const name = column.group || '其他';
      let group = result.find((item) => item.name === name);
      if (!group) {
        group = { name, columns: [] };
        result.push(group);
      }
      group.columns.push(column);
    }
    return result;
  }, [columns, search]);

  const toggleGroup = (groupColumns: MrpColumnDef[]) => {
    const allVisible = groupColumns.every((column) => isVisible(column.id));
    groupColumns.forEach((column) => {
      if (allVisible ? isVisible(column.id) : !isVisible(column.id)) onToggle(column.id);
    });
  };

  const allColumnsVisible = visibleCount === totalCount;
  const toggleAllColumns = () => {
    if (!allColumnsVisible) {
      onShowAll();
      return;
    }
    columns.forEach((column) => {
      if (isVisible(column.id)) onToggle(column.id);
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-8 px-2.5 border rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors duration-150 ${
          visibleCount < totalCount
            ? 'border-violet-300 bg-violet-50 text-violet-800'
            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        }`}
        title={`目前顯示 ${visibleCount} / ${totalCount} 欄`}
      >
        <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>欄位</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums ${visibleCount < totalCount ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500'}`}>
          {visibleCount}/{totalCount}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="顯示欄位"
          className="fixed inset-x-3 top-16 z-[70] flex max-h-[calc(100dvh-5rem)] flex-col overflow-clip rounded-md border border-slate-300 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[22rem] sm:max-h-[min(38rem,calc(100vh-8rem))]"
        >
          <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">顯示欄位</div>
              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">已顯示 {visibleCount} / {totalCount}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="關閉欄位選單"
              title="關閉"
              className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="border-b border-slate-200 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜尋欄位名稱"
                className="h-9 w-full rounded border border-slate-300 bg-white pl-8 pr-8 text-sm text-slate-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="清除欄位搜尋"
                  title="清除搜尋"
                  className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {groups.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-400">找不到符合的欄位</div>
            ) : groups.map((group) => {
              const visibleInGroup = group.columns.filter((column) => isVisible(column.id)).length;
              const allVisible = visibleInGroup === group.columns.length;
              return (
                <section key={group.name} className="border-b border-slate-100 last:border-b-0">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-50 px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[11px] font-semibold text-slate-600">{group.name}</span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
                        {visibleInGroup}/{group.columns.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.columns)}
                      aria-label={allVisible ? `隱藏${group.name}全部欄位` : `顯示${group.name}全部欄位`}
                      title={allVisible ? '隱藏整組' : '顯示整組'}
                      className="flex h-7 items-center gap-1 rounded px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-100"
                    >
                      {allVisible ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : <Eye className="h-3 w-3" aria-hidden="true" />}
                      {allVisible ? '清空' : '全選'}
                    </button>
                  </div>
                  <div className="py-0.5">
                    {group.columns.map((column) => {
                      const visible = isVisible(column.id);
                      return (
                        <label
                          key={column.id}
                          title={column.id}
                          className="flex min-h-8 cursor-pointer items-center gap-2.5 px-3 py-1 text-xs hover:bg-violet-50"
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${visible ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-300 bg-white'}`}>
                            {visible && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
                          </span>
                          <input
                            type="checkbox"
                            checked={visible}
                            onChange={() => onToggle(column.id)}
                            className="sr-only"
                          />
                          <span className={`min-w-0 flex-1 truncate ${visible ? 'font-medium text-slate-800' : 'text-slate-500'}`}>{column.header}</span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="mr-auto text-[11px] tabular-nums text-slate-500">{visibleCount} 欄顯示中</span>
            <button
              type="button"
              onClick={onReset}
              className="flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              系統預設
            </button>
            <button
              type="button"
              onClick={toggleAllColumns}
              className="flex h-8 items-center gap-1.5 rounded bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-700"
            >
              {allColumnsVisible
                ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
              {allColumnsVisible ? '取消全選' : '全部顯示'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
