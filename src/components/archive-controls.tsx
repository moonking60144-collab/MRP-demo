'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

export const control = 'min-h-11 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40';

export function Pager({ page, total, pageSize, disabled, onChange, label }: {
  page: number; total: number; pageSize: number; disabled: boolean; onChange: (page: number) => void; label: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const target = /^[1-9]\d*$/.test(draft) ? Number(draft) : NaN;
  const valid = Number.isSafeInteger(target) && target <= pages;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600" aria-label={label}>
    <span className="tabular-nums">{total.toLocaleString()} 筆・第 {page} / {pages} 頁</span>
    <form className="flex items-center gap-2" onSubmit={event => {
      event.preventDefault();
      if (!disabled && valid && target !== page) onChange(target);
    }}>
      <input className={`${control} w-20 tabular-nums`} aria-label={`${label}跳至頁碼`}
        type="number" min={1} max={pages} step={1} value={draft} disabled={disabled}
        onChange={event => setDraft(event.target.value)} />
      <button type="submit" className={control} disabled={disabled || !valid || target === page}>跳頁</button>
    </form>
    <button type="button" className={control} disabled={disabled || page <= 1} onClick={() => onChange(page - 1)} aria-label={`${label}上一頁`}>上一頁</button>
    <button type="button" className={control} disabled={disabled || page >= pages} onClick={() => onChange(page + 1)} aria-label={`${label}下一頁`}>下一頁</button>
  </div>;
}

export function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-center gap-3 p-8 text-sm text-slate-700">
    <p>{message}</p><button type="button" onClick={retry} className={`${control} inline-flex items-center gap-2`}><RefreshCw size={16} />重試</button>
  </div>;
}
