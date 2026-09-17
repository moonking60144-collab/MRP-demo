'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, LockKeyhole } from 'lucide-react';
import { Loader } from './ui/loader';
import { control, Pager, Failure } from './archive-controls';
import { useArchiveResource } from '@/lib/archive/use-archive-resource';
import { useArchiveMode } from '@/lib/archive-mode-context';
import type { ArchiveRunItem, ArchiveRunPage } from '@/lib/archive/browser-contract';
import { archiveRunListUrl, prefetchArchiveRunPage } from '@/lib/archive/run-list-cache';

export function ArchiveBrowser() {
  const router = useRouter();
  const { run: selected, selectRun } = useArchiveMode();
  const [runQuery, setRunQuery] = useState('');
  const [runSearch, setRunSearch] = useState('');
  const [runPage, setRunPage] = useState(1);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('mrp_archive_browser') ?? 'null');
      if (saved && typeof saved.search === 'string' && saved.search.length <= 100
        && Number.isSafeInteger(saved.page) && saved.page > 0 && saved.page <= 99999) {
        setRunQuery(saved.search); setRunSearch(saved.search); setRunPage(saved.page);
      }
    } catch { /* optional storage */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { sessionStorage.setItem('mrp_archive_browser', JSON.stringify({ search: runSearch, page: runPage })); } catch { /* optional storage */ }
  }, [restored, runSearch, runPage]);
  const [knownTotal, setKnownTotal] = useState({ search: '', total: 0 });
  const [listHeight, setListHeight] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const runs = useArchiveResource<ArchiveRunPage>(restored ? archiveRunListUrl(runSearch, runPage) : null);
  const select = (run: ArchiveRunItem) => { selectRun(run); router.push('/fg-monthly'); };
  const submitRuns = (event: FormEvent) => {
    event.preventDefault();
    if (runSearch === runQuery.trim() && runPage === 1) runs.retry();
    setRunSearch(runQuery.trim()); setRunPage(1);
  };
  const total = runs.data?.total ?? (knownTotal.search === runSearch ? knownTotal.total : 0);

  useEffect(() => {
    if (!runs.data || runs.data.page * runs.data.pageSize >= runs.data.total) return;
    const controller = new AbortController();
    void prefetchArchiveRunPage(archiveRunListUrl(runSearch, runs.data.page + 1), controller.signal);
    return () => controller.abort();
  }, [runSearch, runs.data]);

  useEffect(() => {
    if (runs.data) {
      setKnownTotal({ search: runSearch, total: runs.data.total });
      setRunPage(page => Math.min(page, Math.max(1, Math.ceil(runs.data!.total / 50))));
    }
  }, [runSearch, runs.data]);

  useLayoutEffect(() => {
    if (!runs.data?.runs.length || !listRef.current) return;
    setListHeight(listRef.current.clientHeight);
    listRef.current.scrollTop = 0;
  }, [runs.data]);

  return <section className="h-full min-h-0 overflow-auto p-4 md:p-6" aria-label="歷史資料庫">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Archive size={22} />歷史資料庫</h2>
        <p className="mt-1 text-sm text-slate-600">選擇一個已封存版本，再從左側選單檢視當時的成品月推、元件週推與原始資料。</p></div>
      <span className="inline-flex items-center gap-1.5 text-sm text-slate-600"><LockKeyhole size={15} />唯讀歷史快照</span>
    </div>

    <div className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
        <form onSubmit={submitRuns} className="flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor="archive-run-search" className="text-sm font-medium text-slate-700">歷史版本</label>
          <input id="archive-run-search" className={`${control} w-48 max-w-full`} placeholder="版本名稱或 Run 編號" value={runQuery} maxLength={100} onChange={event => setRunQuery(event.target.value)} />
          <button type="submit" className={control}>查版本</button>
        </form>
        <Pager label="版本清單" page={runPage} total={total} pageSize={50} disabled={!restored || runs.loading || Boolean(runs.error)} onChange={setRunPage} />
      </div>
      <div ref={listRef} className="max-h-[65vh] overflow-auto" role="group" aria-label="選擇歷史版本"
        style={runs.loading && listHeight ? { height: listHeight } : undefined}>
        {!restored || runs.loading ? <div role="status"><Loader label="載入歷史版本" className="h-full py-6" /></div>
          : runs.error ? <Failure message={runs.error} retry={runs.retry} />
            : !runs.data?.runs.length ? <p className="p-6 text-center text-sm text-slate-500">{runSearch ? '沒有符合的歷史版本，請調整搜尋條件。' : '目前沒有已完成驗證的封存版本。'}</p>
              : runs.data.runs.map(run => <button type="button" key={run.id} aria-pressed={selected?.id === run.id}
                onClick={() => select(run)} className={`flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${selected?.id === run.id ? 'bg-blue-50 text-blue-800' : 'text-slate-700 hover:bg-slate-50'}`}>
                <span className="w-24 shrink-0 tabular-nums">{run.runDate}</span><span className="font-medium">{run.versionCode}</span>
                <span className="text-xs">Run {run.sourceRunId}・{run.sourceStatus === 'completed' ? '計算完成' : run.sourceStatus === 'stopped' ? '計算已停止' : run.sourceStatus}</span>
                <span className="ml-auto text-xs">{selected?.id === run.id ? '正在檢視' : '檢視'}</span>
              </button>)}
      </div>
    </div>

  </section>;
}
