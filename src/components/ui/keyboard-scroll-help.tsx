'use client';

import { useState, useRef, useEffect } from 'react';

interface KeyboardScrollHelpProps {
  /** 每按一下方向鍵捲動的距離（px） */
  step: number;
  onStepChange: (step: number) => void;
  /** 額外說明區塊，顯示在靈敏度下方（例如 fg-monthly 傳統 view 的分群規則）。 */
  extraSection?: React.ReactNode;
}

/** 「?」按鈕 — 說明鍵盤方向鍵捲動表格，並可調整靈敏度（捲動步長）。 */
export function KeyboardScrollHelp({ step, onStepChange, extraSection }: KeyboardScrollHelpProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-5 h-5 flex items-center justify-center rounded-full border border-slate-300 text-slate-400 text-xs hover:bg-slate-100 hover:text-slate-600"
        title="鍵盤捲動說明"
      >
        ?
      </button>
      {open && (
        <div className="absolute right-0 z-[60] mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-xl text-xs">
          <div className="font-semibold text-slate-700 mb-1">鍵盤捲動表格</div>
          <p className="leading-relaxed text-slate-500">
            焦點不在輸入框時，直接用 ↑ ↓ ← → 方向鍵捲動表格，不必先點表格。
          </p>
          <div className="mt-3 text-slate-600">
            <div className="flex justify-between mb-1">
              <span>靈敏度（每按一下捲動）</span>
              <span className="font-mono text-slate-700">{step}px</span>
            </div>
            <input
              type="range"
              min={40}
              max={400}
              step={20}
              value={step}
              onChange={(e) => onStepChange(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </div>
          {extraSection && (
            <div className="mt-3 pt-3 border-t border-slate-200">{extraSection}</div>
          )}
        </div>
      )}
    </div>
  );
}
