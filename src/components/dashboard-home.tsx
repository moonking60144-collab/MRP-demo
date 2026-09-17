'use client';

import { useState } from 'react';
import { DashboardClient } from './dashboard';
import { ArchiveBrowser } from './archive-browser';
import { useArchiveMode } from '@/lib/archive-mode-context';
import Link from 'next/link';

export function DashboardHome() {
  const { run } = useArchiveMode();
  const [tab, setTab] = useState<'overview' | 'archive'>(run ? 'archive' : 'overview');
  return <div className="flex h-full min-w-0 flex-col">
    <div className="flex shrink-0 gap-2 border-b border-slate-200 bg-white px-4 pt-2" role="tablist" aria-label="儀表板檢視">
      {([['overview', '儀表板'], ['archive', '歷史資料庫']] as const).map(([key, label]) =>
        <button key={key} id={`dashboard-${key}`} type="button" role="tab" aria-selected={tab === key} aria-controls="dashboard-panel"
          className={`min-h-11 border-b-2 px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
          onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-${tab}`} className="min-h-0 min-w-0 flex-1">
      {tab === 'archive' ? <ArchiveBrowser /> : run ? <div className="space-y-4 p-6 text-slate-700">
        <h2 className="text-xl font-bold">歷史版本・Run {run.sourceRunId}</h2>
        <p>請從左側選單檢視此版本。歷史資料唯讀，不提供同步或重新計算。</p>
        <div className="flex flex-wrap gap-4"><Link href="/fg-monthly" className="text-blue-700 underline">成品月推移</Link><Link href="/components" className="text-blue-700 underline">元件週推移</Link><Link href="/source-data" className="text-blue-700 underline">原始資料</Link></div>
      </div> : <DashboardClient />}
    </div>
  </div>;
}
