'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, Activity } from 'lucide-react';
import { StorageCapacityPanel, useStorageCapacity } from './storage-capacity-panel';
import styles from './system-status-drawer.module.css';

export function SystemStatusDrawer({ children, loading, incomplete, issueCount, onRefresh, demo = false }: {
  children: ReactNode; loading: boolean; incomplete: boolean; issueCount: number; onRefresh: () => void; demo?: boolean;
}) {
  const storage = useStorageCapacity();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const capacityIssues = storage.data?.volumes.filter(volume => volume.warning || volume.critical).length ?? 0;
  const totalIssues = issueCount + capacityIssues;
  const unknown = incomplete || storage.error || !storage.data || storage.data.warnings.length > 0;
  const label = totalIssues ? `需留意 ${totalIssues}` : loading || storage.loading ? '檢查中' : unknown ? '資訊未完整取得' : demo ? 'Demo 模擬狀態' : '正常';
  const iconState = totalIssues ? 'warning' : loading || storage.loading || unknown ? 'unknown' : demo ? 'demo' : 'normal';
  useEffect(() => {
    if (!open) return;
    const modal = dialog.current;
    const opener = trigger.current;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal?.showModal();
    return () => {
      modal?.close();
      document.body.style.overflow = previous;
      opener?.focus();
    };
  }, [open]);
  return <>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); onRefresh(); storage.refresh(); }}
      className="inline-flex min-h-11 items-center gap-2 rounded border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
      <span className={styles.indicator} data-state={iconState} aria-hidden="true">
        <Activity size={14} />
      </span>系統狀態
      <span className={totalIssues ? 'text-amber-700' : 'text-slate-500'}>{label}</span>
    </button>
    <dialog ref={dialog} aria-labelledby="system-status-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        )).filter(element => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-[560px] border-0 border-l border-slate-200 bg-slate-50 p-0 text-left text-slate-800 shadow-xl backdrop:bg-slate-900/25">
      {open && <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <div><h2 id="system-status-title" className="text-base font-semibold">系統狀態</h2><p className="mt-1 text-xs text-slate-500">{demo ? '本機合成資料與維運展示，不影響歷史版本選擇。' : '目前伺服器的維運資訊，不影響歷史版本選擇。'}</p></div>
          <button type="button" aria-label="關閉系統狀態" autoFocus onClick={() => setOpen(false)}
            className="flex size-11 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          <StorageCapacityPanel state={storage} />
          {children}
        </div>
      </div>}
    </dialog>
  </>;
}
