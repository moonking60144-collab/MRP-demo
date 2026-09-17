'use client';

export function FrozenColsControl({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (count: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border border-slate-300 rounded-md px-1.5 py-0.5">
      <span className="text-[10px] text-slate-400 mr-0.5">固定</span>
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="text-xs font-mono w-4 text-center text-slate-700">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
