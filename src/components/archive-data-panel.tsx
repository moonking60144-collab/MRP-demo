'use client';

import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { Loader } from './ui/loader';
import { control, Pager, Failure } from './archive-controls';
import { useArchiveResource } from '@/lib/archive/use-archive-resource';
import { ARCHIVE_VIEWS, archiveCell, type ArchiveRunItem, type ArchiveRowsPage, type ArchiveView } from '@/lib/archive/browser-contract';

export function ArchiveDataPanel({ run: selected, views, title, initialQuery = '', initialQueryByView }: { run: ArchiveRunItem; views: readonly ArchiveView[]; title: string; initialQuery?: string; initialQueryByView?: Partial<Record<ArchiveView, string>> }) {
  const [view, setView] = useState<ArchiveView>(views[0]);
  const [query, setQuery] = useState(initialQueryByView?.[views[0]] ?? initialQuery);
  const [search, setSearch] = useState(initialQueryByView?.[views[0]] ?? initialQuery);
  const [page, setPage] = useState(1);
  const rows = useArchiveResource<ArchiveRowsPage>(`/api/archive/runs/${selected.id}/${view}?${new URLSearchParams({ q: search, page: String(page) })}`);
  const missing = rows.data?.columns.filter(column => column.missing).map(column => column.label) ?? [];
  const submitRows = (event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setPage(1); };

  return <section className="flex h-full min-h-0 min-w-0 flex-col p-4" aria-label={title}>
    <h2 className="mb-3 text-xl font-bold text-slate-800">{title}</h2>
    <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded border border-slate-200 bg-white">
        <div className="space-y-3 border-b border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-700">
            <h3 className="font-semibold">{selected.versionCode}・Run {selected.sourceRunId}</h3><span>{selected.runDate}</span>
            <span className="text-xs text-slate-500">已驗證封存</span>
            {selected.sourceStatus !== 'completed' && <span className="text-amber-700">此版本計算未完成，結果可能不完整。</span>}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-600">檢視資料
              <select aria-label="檢視資料" className={`${control} max-w-full`} value={view} onChange={event => { const next = event.target.value as ArchiveView; setView(next); setPage(1); if (initialQueryByView) { const value = initialQueryByView[next] ?? ''; setQuery(value); setSearch(value); } }}>
                {views.map(key => <option value={key} key={key}>{ARCHIVE_VIEWS[key].label}</option>)}
              </select>
            </label>
            <form onSubmit={submitRows} className="flex min-w-0 flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-600">料號／單號
                <input aria-label="料號或單號" className={`${control} w-64 max-w-full`} placeholder="輸入料號或單號後查詢" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} />
              </label>
              <button type="submit" className={`${control} inline-flex items-center gap-2`}><Search size={16} />查詢</button>
            </form>
            <div className="ml-auto"><Pager label="歷史資料" page={page} total={rows.data?.total ?? 0} pageSize={50} disabled={rows.loading || Boolean(rows.error)} onChange={setPage} /></div>
          </div>
          {initialQueryByView?.[view] === '' && !search && <p className="text-xs text-amber-700">此列沒有可直接對應此來源的搜尋鍵，目前顯示此版本全部資料；請自行輸入料號或單號查詢。</p>}
          <details className="text-xs text-slate-500"><summary className="w-fit cursor-pointer py-1">來源與驗證資訊</summary>
            <p className="mt-1 break-all">來源備份：{selected.seedFileName}・結構版本：{selected.generation}</p>
            <p className="mt-1">封存驗證時間：{new Date(selected.verifiedAt).toLocaleString('zh-TW')}</p>
          </details>
        </div>
        <div className="min-h-64" aria-busy={rows.loading}>
          {rows.loading ? <div role="status"><Loader label={`載入 Run ${selected.sourceRunId}・${ARCHIVE_VIEWS[view].label}`} /></div>
            : rows.error ? <Failure message={rows.error} retry={rows.retry} />
              : rows.data && <>
                {!rows.data.sourcePresent ? <p className="p-8 text-center text-sm text-slate-600">此歷史版本尚未保存這類資料；不代表當時筆數為 0。</p>
                  : <>
                    {missing.length > 0 && <p className="border-b border-slate-200 px-4 py-2 text-xs leading-5 text-slate-600">當時尚未提供：{missing.join('、')}。以「—」表示，不視為 0。</p>}
                    {!rows.data.rows.length ? <p className="p-8 text-center text-sm text-slate-500">{search ? '沒有符合此料號／單號的資料。' : '此版本在此類別沒有資料。'}</p>
                      : <div className="max-h-[55vh] overflow-auto" tabIndex={0} role="region" aria-label={`${ARCHIVE_VIEWS[view].label}歷史表格`}>
                        <table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
                          <thead className="sticky top-0 bg-slate-100 text-slate-600"><tr>{rows.data.columns.map(column => <th key={column.key} scope="col" title={column.missing ? '此歷史版本沒有此欄位' : undefined} className="border-b border-r border-slate-200 px-3 py-3 font-semibold">{column.label}{column.missing ? '（未提供）' : ''}</th>)}</tr></thead>
                          <tbody>{rows.data.rows.map(row => <tr key={row.id} className="even:bg-slate-50 hover:bg-blue-50">{rows.data!.columns.map(column => <td key={column.key} className={`border-b border-r border-slate-100 px-3 py-2 ${column.missing ? 'text-slate-400' : 'text-slate-700'}`}>{column.missing ? '—' : archiveCell(row[column.key], column.type, column.key)}</td>)}</tr>)}</tbody>
                        </table>
                      </div>}
                  </>}
              </>}
        </div>
      </div>
  </section>;
}
