'use client';

import { useMemo, useState, useCallback, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { ComponentWeeklyTraditionalView, COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS } from './component-weekly-traditional';
import { SalesMeetingTraditionalView, SALES_MEETING_FREEZABLE_COLUMN_IDS } from './sales-meeting-traditional';
import { COMPONENT_WEEKLY_COLUMNS } from './data-table/column-defs/component-weekly-columns';
import { SALES_MEETING_COLUMNS, SALES_MEETING_PERIOD_COLUMNS } from './data-table/column-defs/sales-meeting-columns';
import { useColumnVisibility } from './data-table/hooks/use-column-visibility';
import { ColumnSelector } from './data-table/ui/column-selector';
import { ColumnHeaderMenu, useTableColumnHeaderMenu } from './data-table/ui/column-header-menu';
import { TextSizeControl } from './ui/text-size-control';
import { Loader } from './ui/loader';
import { Pager, Failure } from './archive-controls';
import { ArchiveSourceDrawer } from './archive-source-drawer';
import type { ArchiveSourceTarget } from '@/lib/archive/source-query';
import { useArchiveResource } from '@/lib/archive/use-archive-resource';
import { ARCHIVE_WEEKLY_SORTS, type ArchiveWeeklyKind, type ArchiveWeeklyReport } from '@/lib/archive/weekly-report-contract';
import { adaptArchiveWeeklyReport } from '@/lib/archive/weekly-report-adapter';
import type { ArchiveRunItem } from '@/lib/archive/browser-contract';

const columnsByKind = {
  component: COMPONENT_WEEKLY_COLUMNS.map(column => ({ ...column, filterable: false, sortable: Object.hasOwn(ARCHIVE_WEEKLY_SORTS.component, column.id) })),
  sales: [...SALES_MEETING_PERIOD_COLUMNS, ...SALES_MEETING_COLUMNS.map(column => ({ ...column, description: column.description?.replace(/(?:；|，)點數字[^。]*。/g, '。'), filterable: false, sortable: Object.hasOwn(ARCHIVE_WEEKLY_SORTS.sales, column.id) }))],
};
const control = 'min-h-8 rounded border border-slate-300 bg-white px-2 text-xs text-slate-700';

export function ArchiveWeeklyReportView({ run, kind }: { run: ArchiveRunItem; kind: ArchiveWeeklyKind }) {
  const component = kind === 'component';
  const columns = columnsByKind[kind];
  const freezable = component ? COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS : SALES_MEETING_FREEZABLE_COLUMN_IDS;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [mrpType, setMrpType] = useState('W');
  const [shortage, setShortage] = useState(false);
  const [sort, setSort] = useState(component ? 'materialPartNo' : 'partVersion');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [frozen, setFrozen] = useState(2);
  const [textSize, setTextSize] = useState(0);
  const [sourceQuery, setSourceQuery] = useState<ArchiveSourceTarget | null>(null);
  const closeSource = useCallback(() => setSourceQuery(null), []);
  const colVis = useColumnVisibility(columns, `mrp_archive_${kind}_columns`, { defaultAllVisible: true, persistHiddenOnly: true });
  const resource = useArchiveResource<ArchiveWeeklyReport>(`/api/archive/runs/${run.id}/weekly-report?${new URLSearchParams({ kind, mrpType, page: String(page), q: search, shortage: String(shortage), sort, direction })}`);
  const adapted = useMemo(() => {
    if (!resource.data) return {};
    try {
      if (resource.data.run.id !== run.id || resource.data.kind !== kind || resource.data.mrpType !== mrpType) throw new Error('歷史版本回應不一致');
      return { data: adaptArchiveWeeklyReport(resource.data) };
    } catch (error) { return { error: error instanceof Error ? error.message : '歷史資料格式無效' }; }
  }, [resource.data, run.id, kind, mrpType]);
  const header = useTableColumnHeaderMenu({
    columnFilters: [], sortFields: [{ id: sort, direction, label: columns.find(column => column.id === sort)!.header }],
    onSetFilter: () => {}, onRemoveFilter: () => {},
    onPrioritizeSort: field => { setSort(field.id); setDirection(field.direction); setPage(1); },
    onRemoveSort: () => { setSort(component ? 'materialPartNo' : 'partVersion'); setDirection('asc'); setPage(1); },
    onToggleColumn: colVis.toggleColumn,
    onFreezeToColumn: id => setFrozen(freezable.filter(key => colVis.visibility[key] !== false).indexOf(id) + 1),
    canFreezeColumn: id => freezable.includes(id),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setPage(1); };
  const error = resource.error ?? adapted.error;
  const title = component ? '元件週推移 (Component Weekly)' : '產銷會議表 (Sales Meeting)';

  return <section aria-label={title} className="flex h-full min-h-0 min-w-0 flex-col gap-3 px-4 pt-4 md:px-6 md:pt-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-2xl font-bold text-slate-800">{title}</h2><Pager label="歷史資料" page={page} total={resource.data?.total ?? 0} pageSize={50} disabled={resource.loading || Boolean(error)} onChange={setPage} /></div>
    {component && <div role="tablist" aria-label="元件類型" className="flex gap-2 border-b border-slate-200">{[['W', 'W線材'], ['B', 'B外購'], ['D', 'D內製組合']].map(([type, label]) => <button key={type} role="tab" aria-selected={mrpType === type} onClick={() => { setMrpType(type); setPage(1); }} className={`min-h-9 border-b-2 px-3 text-sm ${mrpType === type ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500'}`}>{label}</button>)}</div>}
    <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white p-3">
      <form onSubmit={submit} className="flex max-w-full items-center gap-2"><input aria-label="搜尋歷史料號" placeholder="搜尋料號…" value={query} onChange={event => setQuery(event.target.value)} maxLength={100} className={`${control} min-w-0 w-64`} /><button className={`${control} flex shrink-0 items-center gap-1`}><Search size={14} />搜尋</button></form>
      <ColumnSelector columns={columns} visibility={colVis.visibility} onToggle={colVis.toggleColumn} onShowAll={colVis.showAll} onReset={colVis.resetToDefault} visibleCount={colVis.visibleCount} totalCount={colVis.totalCount} />
      <label className="text-xs text-slate-600">排序：<select aria-label="排序欄位" className={control} value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>{Object.keys(ARCHIVE_WEEKLY_SORTS[kind]).map(key => <option key={key} value={key}>{columns.find(column => column.id === key)!.header}</option>)}</select></label>
      <button className={control} onClick={() => { setDirection(direction === 'asc' ? 'desc' : 'asc'); setPage(1); }}>{direction === 'asc' ? '升冪' : '降冪'}</button>
      <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={shortage} onChange={event => { setShortage(event.target.checked); setPage(1); }} />僅顯示缺料</label>
      <label className="text-xs text-slate-600">固定：<input aria-label="固定欄數" type="number" min={0} max={freezable.length} value={frozen} onChange={event => setFrozen(Math.max(0, Math.min(freezable.length, Number(event.target.value))))} className={`${control} w-14`} /></label>
      <TextSizeControl value={textSize} onChange={setTextSize} />
      <button className={control} onClick={() => setSourceQuery({ query: search })}>檢視封存來源</button>
      <ColumnHeaderMenu controller={header.menuController} />
    </div>
    <div className="text-xs text-slate-500">{component ? '歷史原始週推；舊版採購處置未提供時，只顯示當時保存的距下單週數。' : '依封存客料版本逐筆呈現，不套用現在的合併與計算規則。'} 未提供顯示「—」；唯讀，不查目前庫存。{run.sourceStatus !== 'completed' && '此版本計算未完成，結果可能不完整。'}</div>
    {resource.loading ? <div role="status"><Loader label="讀取歷史週推資料" /></div> : error ? <Failure message={error} retry={resource.retry} /> : adapted.data && resource.data?.rows.length ? (component
      ? <ComponentWeeklyTraditionalView items={adapted.data.componentItems} mrpType={mrpType} snapshot={adapted.data.snapshot} columnVisibility={colVis.visibility} frozenCount={frozen} textSize={textSize} columnHeaderColumns={columns} columnHeaderController={header.menuController} onToggleColumn={colVis.toggleColumn} onInspect={item => setSourceQuery({ query: item.materialPartNo, materialPartNo: item.materialPartNo })} />
      : <SalesMeetingTraditionalView items={adapted.data.salesItems} snapshot={adapted.data.snapshot} columnVisibility={colVis.visibility} frozenCount={frozen} textSize={textSize} columnHeaderColumns={columns} columnHeaderController={header.menuController} onToggleColumn={colVis.toggleColumn} onInspect={item => setSourceQuery({ query: item.partVersion, partVersion: item.partVersion, erpPartNo: item.erpPartNo })} onOpenSource={target => setSourceQuery({ query: target.item.partVersion, partVersion: target.item.partVersion, erpPartNo: target.item.erpPartNo })} onOpenWarehouse={item => setSourceQuery({ query: item.erpPartNo ?? item.partVersion, partVersion: item.partVersion, erpPartNo: item.erpPartNo })} />)
      : <p className="p-8 text-center text-sm text-slate-500">沒有符合條件的歷史資料。</p>}
    {sourceQuery !== null && <ArchiveSourceDrawer run={run} target={sourceQuery} onClose={closeSource} />}
  </section>;
}
