'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LockKeyhole } from 'lucide-react';
import { useArchiveMode } from '@/lib/archive-mode-context';
import { ARCHIVE_PAGES } from '@/lib/archive/navigation';
import { ArchiveDataPanel } from './archive-data-panel';
import { ArchiveFgMonthly } from './archive-fg-monthly';
import { ArchiveWeeklyReportView } from './archive-weekly-report';
import { control, Failure } from './archive-controls';
import { FullLoader } from './ui/loader';

export function ArchiveWorkspace({ children }: { children: ReactNode }) {
  const { run, restoring, error, retry, exitArchive } = useArchiveMode();
  const pathname = usePathname();
  // A material link owns its explicit snapshot identity, independent of the sidebar's current selection.
  if (pathname === '/components/linked') return children;
  if (restoring) return <FullLoader label="確認資料版本" />;
  if (error) return <div className="p-4 text-center"><Failure message={error} retry={retry} /><p className="mb-3 text-sm text-slate-600">歷史版本尚未載入，未切換至目前資料。</p><button className={control} onClick={exitArchive}>返回目前資料</button></div>;
  if (!run) return children;
  const page = ARCHIVE_PAGES[pathname];
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div role="status" aria-label="目前歷史版本" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <LockKeyhole size={16} /><span className="min-w-0 break-all">歷史唯讀・{run.versionCode}・Run {run.sourceRunId}・{run.runDate}</span>
      <Link href="/" className={`${control} ml-auto inline-flex items-center`}>更換歷史版本</Link>
      <button type="button" className={control} onClick={exitArchive}>返回目前資料</button>
    </div>
    <div className="min-h-0 min-w-0 flex-1">
      {pathname === '/' ? children : pathname === '/fg-monthly' ? <ArchiveFgMonthly key={run.id} run={run} /> : pathname === '/components' || pathname === '/sales-meeting' ? <ArchiveWeeklyReportView key={`${pathname}:${run.id}`} run={run} kind={pathname === '/components' ? 'component' : 'sales'} /> : page ? <ArchiveDataPanel key={`${pathname}:${run.id}`} run={run} views={page.views} title={page.title} />
        : <div className="p-8 text-sm text-slate-600">此功能沒有歷史快照。請從左側選擇其他檢視，或返回目前資料；歷史模式不提供編輯、開單或重新計算。</div>}
    </div>
  </div>;
}
