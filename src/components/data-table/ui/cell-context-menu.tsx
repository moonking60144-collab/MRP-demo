'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { ColumnFilter, MrpColumnDef, SortField } from '../types';

/**
 * Cell 右鍵自訂 menu — 快速以該 cell 的值對該欄做篩選 / 複製 / 清除。
 *
 * 設計重點（效能）：
 * - 事件委派：呼叫端在 <table> 上掛單一 onContextMenu，從 closest('td[data-col]')
 *   找 cell。不是每 cell 掛 listener（7 個共用 mrp-table 的頁面 cell 數量大）。
 * - cell DOM 需提供 `data-col`（欄位 id）、`data-value`（原值，無則 fallback 用
 *   textContent）。
 * - 單一 menu instance；無 visible 時不掛 click-outside listener。
 *
 * 框選表格可用 getSelectionCopy 把目前範圍轉成 TSV；範圍複製只取代 copy
 * action，不把多值誤套成單欄篩選。
 */

export interface CellContextMenuTarget {
  col: MrpColumnDef;
  value: unknown;
  formattedValue: string;
  copyText?: string;
  copyLabel?: string;
  copySource?: HTMLTableElement;
  /** 該 cell 所屬的 row id（從 tr[data-row-id] 讀出）— 給「釘選整列」用 */
  rowId?: number;
  /** 該 cell 是不是「虛擬欄」(例如期推移格沒對應 MrpColumnDef)。
      virtual 時不顯示篩選/排序/隱藏 menu，只顯示「複製此值」+「釘選整列」。 */
  isVirtual?: boolean;
}
export interface CellContextMenuProps {
  position: { x: number; y: number } | null;
  target: CellContextMenuTarget | null;
  columnFilters: ColumnFilter[];
  onSetFilter: (filter: ColumnFilter) => void;
  onRemoveFilter: (columnId: string) => void;
  onClose: () => void;
  sortFields?: SortField[];
  onAddSort?: (field: SortField) => void;
  onRemoveSort?: (fieldId: string) => void;
  onToggleColumn?: (columnId: string) => void;
  onFreezeToColumn?: (columnId: string) => void;
  canFreezeColumn?: (columnId: string) => boolean;
  onPinRow?: (rowId: number) => void;
}

function CellContextMenuImpl({
  position,
  target,
  columnFilters,
  onSetFilter,
  onRemoveFilter,
  onClose,
  sortFields,
  onAddSort,
  onRemoveSort,
  onToggleColumn,
  onFreezeToColumn,
  canFreezeColumn,
  onPinRow,
}: CellContextMenuProps) {
  useEffect(() => {
    if (!position) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClickOutside = (e: MouseEvent) => {
      const menu = document.getElementById('cell-context-menu');
      if (menu && !menu.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [position, onClose]);

  if (!position || !target) return null;

  const { col, value, formattedValue } = target;
  const filterType = col.filterType || 'text';
  const isNumeric = filterType === 'numeric';
  const isComparable = isNumeric || filterType === 'date';
  const isInventoryAnomalyColumn = col.id === 'inventoryAnomalyCount';
  const existingFilter = columnFilters.find((f) => f.columnId === col.id);

  const filterValue: string | number = isNumeric
    ? Number(value)
    : ((value as string | number) ?? '');

  const apply = (operator: 'equals' | 'gte' | 'lte') => {
    onSetFilter({
      columnId: col.id,
      operator: filterType === 'enum' ? 'oneOf' : operator,
      value: filterType === 'enum' ? [String(filterValue)] : filterValue,
      valueType: filterType,
    });
    onClose();
  };
  const addEnumValue = () => {
    const currentValues: string[] = existingFilter?.operator === 'oneOf' && Array.isArray(existingFilter.value)
      ? existingFilter.value.filter((entry): entry is string => typeof entry === 'string')
      : existingFilter?.operator === 'equals'
        ? [String(existingFilter.value)]
        : [];
    onSetFilter({
      columnId: col.id,
      operator: 'oneOf',
      value: [...new Set([...currentValues, String(filterValue)])],
      valueType: 'enum',
    });
    onClose();
  };

  const copy = () => {
    const text = target.copyText ?? formattedValue;
    let copied = false;
    if (typeof document !== 'undefined') {
      if (target.copySource) {
        target.copySource.focus({ preventScroll: true });
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        } finally {
          textarea.remove();
        }
      }
    }
    if (!copied && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    onClose();
  };

  const clear = () => {
    onRemoveFilter(col.id);
    onClose();
  };

  const existingSort = sortFields?.find((f) => f.id === col.id);
  const canSort = onAddSort && col.sortable !== false;
  const applyInventoryAnomalyFilter = () => {
    onSetFilter({
      columnId: col.id,
      operator: 'gt',
      value: 0,
      valueType: 'numeric',
    });
    onClose();
  };
  const addSort = (direction: 'asc' | 'desc') => {
    if (!onAddSort) return;
    onAddSort({ id: col.id, label: col.header, direction });
    onClose();
  };
  const removeSort = () => {
    if (!onRemoveSort) return;
    onRemoveSort(col.id);
    onClose();
  };
  const hideColumn = () => {
    if (!onToggleColumn) return;
    onToggleColumn(col.id);
    onClose();
  };
  const freezeTo = () => {
    if (!onFreezeToColumn) return;
    onFreezeToColumn(col.id);
    onClose();
  };
  const pinRow = () => {
    if (!onPinRow || target.rowId === undefined) return;
    onPinRow(target.rowId);
    onClose();
  };
  const isVirtual = target.isVirtual === true;
  const canFilter = !isVirtual && col.filterable !== false;

  // 位置 clamp 到 viewport，避免 menu 跑出畫面
  const menuW = 220;
  const menuH = 200;
  const x = Math.min(position.x, window.innerWidth - menuW - 8);
  const y = Math.min(position.y, window.innerHeight - menuH - 8);

  return (
    <div
      id="cell-context-menu"
      className="fixed z-[100] min-w-[200px] bg-white border border-slate-200 rounded-md shadow-lg text-xs py-1"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1 text-[10px] text-slate-400 border-b border-slate-100 truncate">
        {col.header}: {formattedValue || '(空)'}
      </div>
      {canFilter && isInventoryAnomalyColumn ? (
        <button
          onClick={applyInventoryAnomalyFilter}
          className="block w-full text-left px-3 py-1.5 hover:bg-amber-50 text-amber-700 font-medium"
        >
          只看庫存資料異常
        </button>
      ) : canFilter ? (
        <>
          <button
            onClick={() => apply('equals')}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            {filterType === 'enum' ? `只篩選「${formattedValue}」` : `以此值篩選「${col.header}」`}
          </button>
          {filterType === 'enum' && existingFilter && !(
            existingFilter.operator === 'oneOf'
            && Array.isArray(existingFilter.value)
            && existingFilter.value.some((entry) => entry === String(filterValue))
          ) && (
            <button
              onClick={addEnumValue}
              className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-blue-700"
            >
              加入目前「{col.header}」篩選
            </button>
          )}
        </>
      ) : null}
      {canFilter && isComparable && !isInventoryAnomalyColumn && (
        <>
          <button
            onClick={() => apply('gte')}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            此欄 ≥ {formattedValue}
          </button>
          <button
            onClick={() => apply('lte')}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            此欄 ≤ {formattedValue}
          </button>
        </>
      )}
      {!isVirtual && canSort && (
        <>
          <div className="border-t border-slate-100 my-1" />
          <button
            onClick={() => addSort('asc')}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            此欄升冪排序{existingSort?.direction === 'asc' ? '（當前）' : ''}
          </button>
          <button
            onClick={() => addSort('desc')}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            此欄降冪排序{existingSort?.direction === 'desc' ? '（當前）' : ''}
          </button>
          {existingSort && onRemoveSort && (
            <button
              onClick={removeSort}
              className="block w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-500"
            >
              取消此欄排序
            </button>
          )}
        </>
      )}
      {!isVirtual && onToggleColumn && (
        <>
          <div className="border-t border-slate-100 my-1" />
          <button
            onClick={hideColumn}
            className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
          >
            隱藏此欄
          </button>
        </>
      )}
      {!isVirtual && onFreezeToColumn && (canFreezeColumn?.(col.id) ?? true) && (
        <button
          onClick={freezeTo}
          className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
        >
          凍結到此欄
        </button>
      )}
      {onPinRow && target.rowId !== undefined && (
        <>
          <div className="border-t border-slate-100 my-1" />
          <button
            onClick={pinRow}
            className="block w-full text-left px-3 py-1.5 hover:bg-indigo-50 text-indigo-700 font-medium"
          >
            釘選此列到頂端
          </button>
        </>
      )}
      <div className="border-t border-slate-100 my-1" />
      <button
        onClick={copy}
        className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-slate-700"
      >
        {target.copyLabel ?? '複製此值'}
      </button>
      {!isVirtual && existingFilter && (
        <button
          onClick={clear}
          className="block w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
        >
          清除此欄篩選
        </button>
      )}
    </div>
  );
}

/**
 * React.memo 包一層，避免 parent re-render（例如 hook setState 觸發整個
 * traditional 重 render）連帶它也 reconcile。menu 自己的 props 只在
 * position/target 變動時才有改動，其他 props（onSetFilter 等）若上層
 * 用 useCallback 穩定 ref 就完全跳過。
 */
export const CellContextMenu = React.memo(CellContextMenuImpl);

// =============================================================
// Hook
// =============================================================

export interface UseCellContextMenuOptions {
  columns: MrpColumnDef[];
  columnFilters: ColumnFilter[];
  onSetFilter: (filter: ColumnFilter) => void;
  onRemoveFilter: (columnId: string) => void;
  getSelectionCopy?: (cell: HTMLTableCellElement) => {
    text: string;
    summary?: string;
  } | null;
  selectionCopyText?: string | null;
  sortFields?: SortField[];
  onAddSort?: (field: SortField) => void;
  onRemoveSort?: (fieldId: string) => void;
  onToggleColumn?: (columnId: string) => void;
  onFreezeToColumn?: (columnId: string) => void;
  canFreezeColumn?: (columnId: string) => boolean;
  onPinRow?: (rowId: number) => void;
}

export function useCellContextMenu({
  columns,
  columnFilters,
  onSetFilter,
  onRemoveFilter,
  sortFields,
  onAddSort,
  onRemoveSort,
  onToggleColumn,
  onFreezeToColumn,
  canFreezeColumn,
  onPinRow,
  getSelectionCopy,
  selectionCopyText,
}: UseCellContextMenuOptions) {
  const [state, setState] = useState<{
    position: { x: number; y: number };
    target: CellContextMenuTarget;
  } | null>(null);

  const colById = useMemo(() => {
    const m = new Map<string, MrpColumnDef>();
    columns.forEach((c) => m.set(c.id, c));
    return m;
  }, [columns]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 兩種 cell：data-col (有對應 MrpColumnDef) / data-period-key (期推移虛擬欄)
      const td = (e.target as HTMLElement).closest(
        'td[data-col], td[data-period-key], td[data-selc]',
      ) as HTMLTableCellElement | null;
      if (!td) return; // 不在 cell 上 → 走瀏覽器原生右鍵

      // 從 tr 取 rowId 給 pin row 用（沒有 tr[data-row-id] 就不支援 pin）
      const tr = td.closest('tr[data-row-id]') as HTMLTableRowElement | null;
      const rowIdRaw = tr?.dataset.rowId;
      const rowId = rowIdRaw ? Number(rowIdRaw) : undefined;

      const rawVal = td.dataset.value;
      const formattedValue = (td.textContent || '').trim();
      const value = rawVal != null ? rawVal : formattedValue;

      let target: CellContextMenuTarget;
      const selectionCopy = getSelectionCopy?.(td);
      if (selectionCopy) {
        target = {
          col: {
            id: 'virtual:selection',
            header: '框選範圍',
            filterType: 'text',
          },
          value: selectionCopy.text,
          formattedValue: selectionCopy.summary ?? '已選取',
          copyText: selectionCopy.text,
          copyLabel: '複製框選值',
          copySource: td.closest('table') ?? undefined,
          isVirtual: true,
        };
      } else if (td.dataset.col) {
        const col = colById.get(td.dataset.col);
        if (!col) return;
        target = { col, value, formattedValue, rowId };
      } else if (td.dataset.periodKey) {
        // 虛擬欄：合成 MrpColumnDef，header 用 data-period-label
        const periodKey = td.dataset.periodKey;
        const monthIdx = td.dataset.periodMonthIdx ?? '0';
        const label = td.dataset.periodLabel || '期推移';
        const virtualCol: MrpColumnDef = {
          id: `virtual:period:${periodKey}:${monthIdx}`,
          header: label,
          filterType: 'numeric',
        };
        target = { col: virtualCol, value, formattedValue, rowId, isVirtual: true };
      } else {
        return;
      }

      e.preventDefault();
      setState({
        position: { x: e.clientX, y: e.clientY },
        target,
      });
    },
    [colById, getSelectionCopy],
  );

  const close = useCallback(() => setState(null), []);
  const handleCopy = useCallback((event: React.ClipboardEvent) => {
    if (selectionCopyText == null) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', selectionCopyText);
  }, [selectionCopyText]);

  return {
    /** 攤平給 <CellContextMenu {...props} /> 用 */
    contextMenuProps: {
      position: state?.position ?? null,
      target: state?.target ?? null,
      columnFilters,
      onSetFilter,
      onRemoveFilter,
      onClose: close,
      sortFields,
      onAddSort,
      onRemoveSort,
      onToggleColumn,
      onFreezeToColumn,
      canFreezeColumn,
      onPinRow,
    },
    /** 掛在 <table onContextMenu={handleContextMenu}> */
    handleContextMenu,
    /** 掛在可框選的 <table onCopy={handleCopy}> */
    handleCopy,
  };
}
