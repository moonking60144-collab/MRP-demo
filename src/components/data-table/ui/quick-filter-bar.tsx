'use client';

import React, { useMemo } from 'react';
import type { QuickFilterOption } from '../types';

interface QuickFilterBarProps {
  label: string;
  options: QuickFilterOption[];
  activeValue: string;
  onChange: (value: string) => void;
  /** Individual machine values for per-machine chip filtering */
  machineOptions?: string[];
  /** Currently selected specific machine (null = using category filter) */
  activeMachine?: string | null;
  /** Called when a specific machine chip is clicked (null to clear) */
  onMachineChange?: (machine: string | null) => void;
}

const isSupplier = (m: string) => m.includes('[');

export function QuickFilterBar({
  label,
  options,
  activeValue,
  onChange,
  machineOptions,
  activeMachine,
  onMachineChange,
}: QuickFilterBarProps) {
  // Filter machine options by active category
  const filteredMachines = useMemo(() => {
    if (!machineOptions) return [];
    if (activeValue === 'internal') return machineOptions.filter((m) => !isSupplier(m));
    if (activeValue === 'supplier') return machineOptions.filter((m) => isSupplier(m));
    return machineOptions; // 'all'
  }, [machineOptions, activeValue]);

  const handleCategoryChange = (value: string) => {
    onMachineChange?.(null); // Clear specific machine when switching category
    onChange(value);
  };

  const handleMachineClick = (machine: string) => {
    if (activeMachine === machine) {
      // Toggle off — revert to category
      onMachineChange?.(null);
    } else {
      onMachineChange?.(machine);
    }
  };

  return (
    <div className="bg-slate-50 border-b border-slate-200">
      {/* Row 1: Category filters */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs text-slate-500 font-medium shrink-0">{label}:</span>
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleCategoryChange(opt.value)}
            className={`text-xs px-2.5 py-1 rounded border ${
              activeValue === opt.value && !activeMachine
                ? 'bg-blue-500 text-white border-blue-500'
                : activeValue === opt.value && activeMachine
                ? 'bg-blue-100 text-blue-700 border-blue-300'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Row 2: Individual machine chips (scrollable) */}
      {filteredMachines.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1 overflow-x-auto">
          <span className="text-[10px] text-slate-400 shrink-0 mr-1">
            ({filteredMachines.length})
          </span>
          {filteredMachines.map((machine) => (
            <button
              key={machine}
              onClick={() => handleMachineClick(machine)}
              className={`text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                activeMachine === machine
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              {machine}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
