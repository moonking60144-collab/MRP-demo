'use client';
import { useMaterialReminders } from './fg-material-reminder';

import { useMemo, useState, useCallback, type FormEvent } from 'react';
import { ArchiveSourceDrawer } from './archive-source-drawer';
import type { ArchiveSourceTarget } from '@/lib/archive/source-query';
import { Search } from 'lucide-react';
import { TraditionalView, FG_MAX_FROZEN } from './fg-monthly-traditional';
import { FG_MONTHLY_TRADITIONAL_ALL_COLUMNS } from './data-table/column-defs/fg-monthly-columns';
import { useColumnVisibility } from './data-table/hooks/use-column-visibility';
import { ColumnSelector } from './data-table/ui/column-selector';
import { ColumnHeaderMenu, useTableColumnHeaderMenu } from './data-table/ui/column-header-menu';
import { TextSizeControl } from './ui/text-size-control';
import { Loader } from './ui/loader';
import { Pager, Failure } from './archive-controls';
import { useArchiveResource } from '@/lib/archive/use-archive-resource';
import { ARCHIVE_FG_SORTS, type ArchiveFgReport } from '@/lib/archive/fg-report-contract';
import { adaptArchiveFgReport } from '@/lib/archive/fg-report-adapter';
import type { ArchiveRunItem } from '@/lib/archive/browser-contract';

const columns = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.map(column => ({ ...column, filterable: false, sortable: Object.hasOwn(ARCHIVE_FG_SORTS, column.id) }));
const control = 'min-h-8 rounded border border-slate-300 bg-white px-2 text-xs text-slate-700';

export function ArchiveFgMonthly({ run }: { run: ArchiveRunItem }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [aggregated, setAggregated] = useState(false);
  const [shortage, setShortage] = useState(false);
  const [sort, setSort] = useState('forgingParent');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [months, setMonths] = useState(12);
  const [frozen, setFrozen] = useState(4);
  const [textSize, setTextSize] = useState(0);
  const [style, setStyle] = useState<'classic' | 'ragic'>('classic');
  const [showTree, setShowTree] = useState(false);
  const [sourceQuery, setSourceQuery] = useState<ArchiveSourceTarget | null>(null);
  const closeSource = useCallback(() => setSourceQuery(null), []);
  const colVis = useColumnVisibility(columns, 'mrp_archive_fg_columns', { defaultAllVisible: true, persistHiddenOnly: true });
  const resource = useArchiveResource<ArchiveFgReport>(`/api/archive/runs/${run.id}/fg-report?${new URLSearchParams({ page: String(page), q: search, aggregated: String(aggregated), shortage: String(shortage), sort, direction })}`);
  const adapted = useMemo(() => {
    if (!resource.data) return {};
    try {
      if (resource.data.run.id !== run.id || resource.data.aggregated !== aggregated) throw new Error('歷史版本回應不一致');
      return { data: adaptArchiveFgReport(resource.data) };
    } catch (error) { return { error: error instanceof Error ? error.message : '歷史資料格式無效' }; }
  }, [resource.data, run.id, aggregated]);
  const materialReminders = useMaterialReminders(adapted.data?.items ?? [], run.id);
  const header = useTableColumnHeaderMenu({
    columnFilters: [], sortFields: [{ id: sort, direction, label: columns.find(column => column.id === sort)!.header }],
    onSetFilter: () => {}, onRemoveFilter: () => {},
    onPrioritizeSort: field => { setSort(field.id); setDirection(field.direction); setPage(1); },
    onRemoveSort: () => { setSort('forgingParent'); setDirection('asc'); setPage(1); },
    onToggleColumn: colVis.toggleColumn,
    onFreezeToColumn: id => setFrozen(Math.min(FG_MAX_FROZEN, columns.filter(column => !column.id.startsWith('period.') && !['wfgStockPc', 'ye1StockPc'].includes(column.id) && colVis.visibility[column.id] !== false).findIndex(column => column.id === id) + 1)),
    canFreezeColumn: id => !id.startsWith('period.') && !['wfgStockPc', 'ye1StockPc'].includes(id),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setPage(1); };
  const error = resource.error ?? adapted.error;

  return <section aria-label="歷史成品月推" className="flex h-full min-h-0 min-w-0 flex-col gap-3 px-4 pt-4 md:px-6 md:pt-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-2xl font-bold text-slate-800">成品月推移 (FG Monthly)</h2>
      <Pager label="歷史資料" page={page} total={resource.data?.total ?? 0} pageSize={50} disabled={resource.loading || Boolean(error)} onChange={setPage} />
    </div>
    <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white p-3">
      <form onSubmit={submit} className="flex max-w-full items-center gap-2">
        <input aria-label="搜尋歷史料號" placeholder="搜尋料號…" value={query} onChange={event => setQuery(event.target.value)} maxLength={100} className={`${control} min-w-0 w-64`} />
        <button className={`${control} flex shrink-0 items-center gap-1`}><Search size={14} />搜尋</button>
      </form>
      <ColumnSelector columns={columns} visibility={colVis.visibility} onToggle={colVis.toggleColumn} onShowAll={colVis.showAll} onReset={colVis.resetToDefault} visibleCount={colVis.visibleCount} totalCount={colVis.totalCount} />
      <label className="text-xs text-slate-600">排序：<select aria-label="排序欄位" className={control} value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>{Object.keys(ARCHIVE_FG_SORTS).map(key => <option key={key} value={key}>{columns.find(column => column.id === key)!.header}</option>)}</select></label>
      <button className={control} onClick={() => { setDirection(direction === 'asc' ? 'desc' : 'asc'); setPage(1); }}>{direction === 'asc' ? '升冪' : '降冪'}</button>
      <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={shortage} onChange={event => { setShortage(event.target.checked); setPage(1); }} />僅顯示缺料</label>
      <label className="text-xs text-slate-600">視圖：<select aria-label="歷史視圖" className={control} value={String(aggregated)} onChange={event => { setAggregated(event.target.value === 'true'); setPage(1); }}><option value="false">按版本</option><option value="true">主件聚合</option></select></label>
      <label className="text-xs text-slate-600">月數：<select aria-label="月數" className={control} value={months} onChange={event => setMonths(Number(event.target.value))}>{[6, 12, 18, 24].map(count => <option key={count}>{count}</option>)}</select></label>
      <label className="text-xs text-slate-600">固定：<input aria-label="固定欄數" type="number" min={0} max={FG_MAX_FROZEN} value={frozen} onChange={event => setFrozen(Math.max(0, Math.min(FG_MAX_FROZEN, Number(event.target.value))))} className={`${control} w-14`} /></label>
      <TextSizeControl value={textSize} onChange={setTextSize} />
      <label className="text-xs text-slate-600">樣式：<select aria-label="表格樣式" value={style} onChange={event => setStyle(event.target.value as 'classic' | 'ragic')} className={control}><option value="classic">原本</option><option value="ragic">Ragic</option></select></label>
      <ColumnHeaderMenu controller={header.menuController} />
      <button className={control} aria-pressed={showTree} onClick={() => { setShowTree(!showTree); if (!showTree) { setSort('forgingParent'); setDirection('asc'); setPage(1); } }}>製程版本樹</button>
      <button className={control} onClick={() => setSourceQuery({ query: search })}>檢視封存來源</button>
    </div>
    <div className="text-xs text-slate-500">歷史快照唯讀；未提供的數值顯示「—」。庫存驗證、即時來源追查及編輯功能未啟用。{run.sourceStatus !== 'completed' && '此版本計算未完成，結果可能不完整。'}</div>
    {resource.loading ? <div role="status"><Loader label="讀取歷史成品月推資料" /></div> : error ? <Failure message={error} retry={resource.retry} />
      : adapted.data?.items.length ? <TraditionalView items={materialReminders.items} snapshot={adapted.data.snapshot} displayMonths={months} columnVisibility={colVis.visibility} frozenCount={frozen} textSize={textSize} tableStyle={style} aggregated={aggregated} showTree={showTree} sortFieldIds={[sort]} columnHeaderColumns={columns} columnHeaderController={header.menuController} onToggleColumn={colVis.toggleColumn} onShowDetail={(item, openMaterialReminder) => setSourceQuery({ query: item.partVersion, partVersion: item.partVersion, erpPartNo: item.erpPartNo, aggregated: item.isAggregated, openMaterialReminder })} />
        : <p className="p-8 text-center text-sm text-slate-500">沒有符合條件的歷史資料。</p>}
    {sourceQuery !== null && <ArchiveSourceDrawer run={run} target={sourceQuery} onClose={closeSource} />}
  </section>;
}
