'use client';

interface MergeToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export function MergeToggle({ enabled, onChange }: MergeToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border transition-colors ${
        enabled
          ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
          : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
      }`}
      title={enabled ? '關閉合併模式' : '合併所有資料庫'}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
      {enabled ? '合併 DB' : '合併 DB'}
    </button>
  );
}
