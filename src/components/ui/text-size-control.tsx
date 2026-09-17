'use client';

export const TEXT_ZOOM_LEVELS = [1, 1.15, 1.3, 1.5, 1.75];

export function TextSizeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (level: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border border-slate-300 rounded-md p-0.5">
      {TEXT_ZOOM_LEVELS.map((_, level) => (
        <button
          key={level}
          onClick={() => onChange(level)}
          className={`flex items-center justify-center rounded transition-colors ${
            value === level
              ? 'bg-blue-500 text-white'
              : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          }`}
          style={{ fontSize: 10 + level * 2, width: 22, height: 22 }}
          title={`文字大小 ${level + 1}`}
        >
          A
        </button>
      ))}
    </div>
  );
}
