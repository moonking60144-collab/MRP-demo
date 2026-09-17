'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { FgMaterialReminderPanel } from './fg-material-reminder';
import type { ArchiveRunItem, ArchiveView } from '@/lib/archive/browser-contract';
import { ArchiveDataPanel } from './archive-data-panel';
import { archiveSourceQueries, type ArchiveSourceTarget } from '@/lib/archive/source-query';

const views: ArchiveView[] = ['orders', 'forecasts', 'production-plans', 'work-orders', 'bom', 'purchases', 'inventory', 'movements'];

export function ArchiveSourceDrawer({ run, target, onClose }: { run: ArchiveRunItem; target: ArchiveSourceTarget; onClose: () => void }) {
  const sourceViews = target.materialPartNo ? views.filter(view => !['orders', 'forecasts'].includes(view)) : views;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 z-[100] flex justify-end bg-slate-950/25" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="歷史來源資料" className="flex h-full w-full max-w-6xl flex-col bg-slate-50 shadow-xl" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,summary,[tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2 text-sm text-slate-600"><span>Run {run.sourceRunId} 封存來源・以料號包含搜尋；不是該數字的計算歸屬明細。</span><button ref={closeRef} onClick={onClose} aria-label="關閉歷史來源" className="grid h-11 w-11 shrink-0 place-items-center"><X size={18} /></button></div>
      <div className="min-h-0 flex-1 overflow-auto">
        {target.partVersion && target.aggregated !== undefined && <div className="px-4"><FgMaterialReminderPanel item={{ partVersion: target.partVersion, mrpRunId: run.sourceRunId, isAggregated: target.aggregated }} archiveId={run.id} initiallyOpen={target.openMaterialReminder} /></div>}
        <ArchiveDataPanel key={`${run.id}:${target.query}`} run={run} initialQuery={target.query} initialQueryByView={archiveSourceQueries(target)} views={sourceViews} title="歷史來源資料" />
      </div>
    </section>
  </div>;
}
