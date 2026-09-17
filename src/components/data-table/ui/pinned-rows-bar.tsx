'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pin, X } from 'lucide-react';

export function usePinnedRows<T extends { id: number }>(items: T[]) {
  const [pinnedRowIds, setPinnedRowIds] = useState<Set<number>>(new Set());
  const pinRow = useCallback((id: number) => {
    setPinnedRowIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);
  const unpinRow = useCallback((id: number) => {
    setPinnedRowIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  const clearPins = useCallback(() => setPinnedRowIds(new Set()), []);
  const pinnedItems = useMemo(
    () => items.filter((item) => pinnedRowIds.has(item.id)),
    [items, pinnedRowIds],
  );

  return { pinnedItems, pinRow, unpinRow, clearPins };
}

export function PinnedRowsBar<T extends { id: number }>({
  items,
  renderItem,
  onUnpin,
  onClearAll,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  onUnpin: (id: number) => void;
  onClearAll: () => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 bg-indigo-50 border-x border-indigo-200 text-[11px]">
      <span className="inline-flex items-center gap-1 text-indigo-700 font-semibold">
        <Pin size={12} />
        釘選 ({items.length})
      </span>
      {items.map((item) => (
        <div
          key={item.id}
          className="inline-flex items-center gap-1.5 px-2 py-1 bg-white border border-indigo-300 rounded shadow-sm"
        >
          {renderItem(item)}
          <button
            type="button"
            onClick={() => onUnpin(item.id)}
            className="text-slate-400 hover:text-red-500 ml-1 leading-none"
            title="取消釘選"
            aria-label="取消釘選"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-slate-500 hover:text-red-600 ml-auto px-1.5 py-0.5 rounded border border-slate-300 hover:border-red-300"
      >
        全部清除
      </button>
    </div>
  );
}
