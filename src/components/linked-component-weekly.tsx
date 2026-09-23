'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ComponentWeeklyTraditionalView, type ComponentWeeklyItem } from './component-weekly-traditional';
import { ArchiveSourceDrawer } from './archive-source-drawer';
import { COMPONENT_WEEKLY_COLUMNS } from './data-table/column-defs/component-weekly-columns';
import { useTableColumnHeaderMenu } from './data-table/ui/column-header-menu';
import { useArchiveResource } from '@/lib/archive/use-archive-resource';
import { adaptArchiveWeeklyReport } from '@/lib/archive/weekly-report-adapter';
import type { ArchiveWeeklyReport } from '@/lib/archive/weekly-report-contract';
import { componentWeeklyRowKey, normalizeComponentWeeklyPeriod, type ComponentWeeklyPeriodDetail } from '@/lib/mrp/component-weekly-periods';
import { Loader } from './ui/loader';
import { Failure } from './archive-controls';

interface ResponseData {
  runId: number; archiveId: string | null; dbSource: string | null; material: string; mrpType: string;
  versionCode?: string; items?: ComponentWeeklyItem[]; periods?: Array<ComponentWeeklyPeriodDetail & { mrpRunId: number; materialPartNo: string; mrpType: string }>; archive?: ArchiveWeeklyReport;
}
const columns = COMPONENT_WEEKLY_COLUMNS.map(column => ({ ...column, filterable: false, sortable: false }));
export function LinkedComponentWeekly({ query }: { query: string }) {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const resource = useArchiveResource<ResponseData>(`/api/fg-material-reminders/weekly?${query}`);
  const [inspect, setInspect] = useState<ComponentWeeklyItem | null>(null);
  const header = useTableColumnHeaderMenu({ columnFilters: [], sortFields: [], onSetFilter: () => {}, onRemoveFilter: () => {}, onPrioritizeSort: () => {}, onRemoveSort: () => {} });
  const adapted = useMemo(() => {
    const body = resource.data;
    if (!body) return {};
    try {
      if (body.runId !== Number(params.get('runId')) || body.archiveId !== params.get('archiveId') || body.dbSource !== params.get('dbSource') || body.material !== params.get('material') || body.mrpType !== params.get('mrpType')) throw new Error('元件週推回應與連結版本不一致');
      if (body.archive) {
        if (body.archive.run.id !== body.archiveId || body.archive.run.sourceRunId !== body.runId || body.archive.rows.some(row => row.material_part_no !== body.material)) throw new Error('封存材料身份不一致');
        const data = adaptArchiveWeeklyReport(body.archive);
        return { items: data.componentItems, snapshot: data.snapshot };
      }
      const items = body.items ?? [];
      if (items.some(item => item.mrpRunId !== body.runId || item.materialPartNo !== body.material || item.mrpType !== body.mrpType || (item.dbSource ?? null) !== body.dbSource)) throw new Error('材料身份不一致');
      if (body.periods?.some(period => period.mrpRunId !== body.runId || period.materialPartNo !== body.material || period.mrpType !== body.mrpType)) throw new Error('材料期間版本不一致');
      if (items.length && (!body.periods?.length || body.periods.some((period, index) => period.weekIndex !== index))) throw new Error('材料期間資料不完整');
      const periods = items.length ? { [componentWeeklyRowKey(items[0])]: (body.periods ?? []).map(normalizeComponentWeeklyPeriod) } : {};
      return { items, preloadedPeriods: periods };
    } catch (error) { return { error: error instanceof Error ? error.message : '週推資料格式錯誤' }; }
  }, [resource.data, params]);
  const body = resource.data;
  return <section className="flex h-full min-h-0 flex-col gap-3 p-4">
    <div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-bold">元件週推・關聯材料</h2><Link href="/fg-monthly" className="ml-auto text-sm text-blue-700 underline">返回成品月推</Link></div>
    <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700"><b>{params.get('material')}</b> · {params.get('mrpType')}<p className="mt-1 text-xs">固定查看{params.get('archiveId') ? '封存' : 'Demo 合成資料'} Run {params.get('runId')} · {body?.archive?.run.versionCode ?? body?.versionCode ?? '確認版本中'}{params.get('dbSource') ? ` · ${params.get('dbSource')}` : ''}。本頁不隨側欄版本變更，僅顯示此完整料號；未進行逐單配料。</p></div>
    {resource.loading ? <Loader label="讀取指定版本元件週推" /> : resource.error || adapted.error ? <Failure message={resource.error ?? adapted.error!} retry={resource.retry} />
      : adapted.items?.length ? <ComponentWeeklyTraditionalView items={adapted.items} mrpType={params.get('mrpType')!} snapshot={adapted.snapshot} preloadedPeriods={adapted.preloadedPeriods} columnHeaderColumns={columns} columnHeaderController={header.menuController} onInspect={setInspect} />
        : <p>此版本沒有對應材料的元件週推資料，未切換至其他版本。</p>}
    {inspect && body?.archive && <ArchiveSourceDrawer run={body.archive.run} target={{ query: inspect.materialPartNo, materialPartNo: inspect.materialPartNo }} onClose={() => setInspect(null)} />}
  </section>;
}
