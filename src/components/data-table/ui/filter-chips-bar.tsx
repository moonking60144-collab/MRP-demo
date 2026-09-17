'use client';

import React from 'react';
import type { ColumnFilter, MrpColumnDef } from '../types';

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
    return filter.value.length > 3 ? `${visible} 等 ${filter.value.length} 項` : visible;
  }
  return `${filter.operator} ${filter.value}`;
}

interface FilterChipsBarProps {
  columns: MrpColumnDef[];
  columnFilters: ColumnFilter[];
  onEditFilter: (columnId: string) => void;
  onRemoveFilter: (columnId: string) => void;
  onAddFilter: () => void;
  onClearAll: () => void;
}

export function FilterChipsBar({
  columns,
  columnFilters,
  onEditFilter,
  onRemoveFilter,
  onAddFilter,
  onClearAll,
}: FilterChipsBarProps) {
  if (columnFilters.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-slate-50 border-b border-slate-200">
      <span className="text-xs text-slate-500 font-medium">篩選：</span>

      {columnFilters.map((filter) => {
        const col = columns.find((c) => c.id === filter.columnId);
        return (
          <div
            key={filter.columnId}
            className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-xs"
          >
            <button
              onClick={() => onEditFilter(filter.columnId)}
              className="text-left flex items-center gap-1 hover:underline"
              title="點擊編輯此條件"
            >
              <span className="text-amber-700 font-medium">
                {col?.header || filter.columnId}
              </span>
              <span className="text-amber-500">{renderDisplayVal(filter)}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveFilter(filter.columnId);
              }}
              className="text-amber-400 hover:text-red-500 ml-0.5"
              title="移除此條件"
            >
              ×
            </button>
          </div>
        );
      })}

      <button
        onClick={onAddFilter}
        className="text-xs px-2 py-1 border border-dashed border-slate-300 rounded text-slate-500 hover:border-amber-400 hover:text-amber-600"
      >
        + 新增篩選
      </button>

      <button onClick={onClearAll} className="text-xs text-slate-400 hover:text-red-500 ml-1">
        全部清除
      </button>
    </div>
  );
}
