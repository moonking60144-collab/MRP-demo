'use client';

/**
 * 機台篩選 popover — replaces the old two-row horizontal-scrolling chip bar.
 * Toolbar shows one compact button; the panel holds category toggles +
 * a searchable machine grid. Single-select (one machine or one category).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickFilterOption } from './data-table/types';

const isSupplier = (m: string) => m.includes('[');

interface MachineFilterProps {
  options: QuickFilterOption[];
  activeCategory: string;
  onCategoryChange: (value: string) => void;
  machines: string[];
  activeMachine: string | null;
  onMachineChange: (machine: string | null) => void;
}

export function MachineFilter({
  options,
  activeCategory,
  onCategoryChange,
  machines,
  activeMachine,
  onMachineChange,
}: MachineFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const filteredMachines = useMemo(() => {
    let list = machines;
    if (activeCategory === 'internal') list = list.filter((m) => !isSupplier(m));
    else if (activeCategory === 'supplier') list = list.filter((m) => isSupplier(m));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((m) => m.toLowerCase().includes(q));
    return list;
  }, [machines, activeCategory, search]);

  const isFiltered = activeMachine != null || activeCategory !== 'all';
  const label =
    activeMachine ??
    options.find((o) => o.value === activeCategory)?.label ??
    '全部';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded border px-2.5 py-1 text-xs ${
          isFiltered
            ? 'border-blue-300 bg-blue-50 text-blue-700'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
        }`}
      >
        機台: {label}
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 z-[60] mt-1 w-80 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          {/* category toggles */}
          <div className="mb-2 flex gap-1">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onMachineChange(null);
                  onCategoryChange(opt.value);
                }}
                className={`flex-1 rounded border px-2 py-1 text-xs ${
                  activeCategory === opt.value && !activeMachine
                    ? 'border-blue-500 bg-blue-500 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* search */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋機台…"
            className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />

          {/* machine grid */}
          <div className="max-h-72 overflow-y-auto">
            <div className="flex flex-wrap gap-1">
              {filteredMachines.length === 0 ? (
                <span className="px-1 py-2 text-xs text-slate-400">無符合機台</span>
              ) : (
                filteredMachines.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onMachineChange(activeMachine === m ? null : m);
                      setOpen(false);
                    }}
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${
                      activeMachine === m
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                    }`}
                  >
                    {m}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="mt-1.5 text-[10px] text-slate-400">{filteredMachines.length} 台</div>
        </div>
      )}
    </div>
  );
}
