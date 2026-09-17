'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SortField, SortDirection, MrpColumnDef } from '../types';

interface SortPanelProps {
  sortFields: SortField[];
  columns: MrpColumnDef[];
  onAdd: (field: SortField) => void;
  onRemove: (fieldId: string) => void;
  onToggleDirection: (fieldId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onClear: () => void;
  onReset?: () => void;
}

function SortableChip({
  field,
  onToggle,
  onRemove,
}: {
  field: SortField;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded text-xs cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <span className="text-blue-700 font-medium select-none">{field.label}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="text-blue-500 hover:text-blue-700 px-0.5"
        title={field.direction === 'asc' ? '升冪（點擊切換）' : '降冪（點擊切換）'}
      >
        {field.direction === 'asc' ? '↑' : '↓'}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-blue-400 hover:text-red-500 ml-0.5"
        title="移除排序"
      >
        ×
      </button>
    </div>
  );
}

export function SortPanel({
  sortFields,
  columns,
  onAdd,
  onRemove,
  onToggleDirection,
  onReorder,
  onClear,
  onReset,
}: SortPanelProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const availableColumns = columns.filter(
    (col) => (col.sortable !== false) && !sortFields.some((f) => f.id === col.id),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sortFields.findIndex((f) => f.id === active.id);
      const newIndex = sortFields.findIndex((f) => f.id === over.id);
      onReorder(oldIndex, newIndex);
    }
  };

  const handleAddField = (col: MrpColumnDef, direction: SortDirection = 'asc') => {
    onAdd({ id: col.id, direction, label: col.header });
    setShowDropdown(false);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    if (showDropdown) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-slate-50 border-b border-slate-200">
      <span className="text-xs text-slate-500 font-medium">排序：</span>

      {sortFields.length === 0 && (
        <span className="text-xs text-slate-400 italic">未設定排序</span>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortFields.map((f) => f.id)} strategy={horizontalListSortingStrategy}>
          {sortFields.map((field) => (
            <SortableChip
              key={field.id}
              field={field}
              onToggle={() => onToggleDirection(field.id)}
              onRemove={() => onRemove(field.id)}
            />
          ))}
        </SortableContext>
      </DndContext>

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={availableColumns.length === 0}
          className="text-xs px-2 py-1 border border-dashed border-slate-300 rounded text-slate-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + 新增
        </button>
        {showDropdown && availableColumns.length > 0 && (
          <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 min-w-[240px] max-h-[360px] overflow-y-auto">
            {availableColumns.map((col) => (
              <button
                key={col.id}
                onClick={() => handleAddField(col)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 flex justify-between items-center"
              >
                <span>{col.header}</span>
                <span className="text-slate-400 ml-2">{col.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {sortFields.length > 0 && (
        <button
          onClick={onClear}
          className="text-xs text-slate-400 hover:text-red-500 ml-1"
        >
          清除
        </button>
      )}
      {onReset && (
        <button
          onClick={onReset}
          className="text-xs text-slate-400 hover:text-blue-600"
          title="把排序還原成系統內建的預設排序"
        >
          預設排序
        </button>
      )}
      <span className="text-[10px] text-slate-400 ml-auto">
        提示：拖曳卡片排優先序、點 ↑/↓ 換升降冪；「清除」後可按「預設排序」還原
      </span>
    </div>
  );
}
