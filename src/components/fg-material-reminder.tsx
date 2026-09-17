'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, Ellipsis, Info, TriangleAlert } from 'lucide-react';
import { MATERIAL_REMINDER_LABELS, materialWeeklyHref, type MaterialReminder, type MaterialReminderScope } from '@/lib/mrp/material-reminder';

interface Target { partVersion: string; mrpRunId: number; dbSource?: string; materialReminderDbSource?: string; isAggregated?: boolean }
export function useMaterialReminders<T extends Target>(items: T[], archiveId?: string) {
  const key = JSON.stringify(items.map(item => [item.partVersion, item.mrpRunId, item.materialReminderDbSource ?? item.dbSource ?? null, Boolean(item.isAggregated)]));
  const [result, setResult] = useState<{ key: string; archiveId?: string; values: Record<string, MaterialReminder>; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const targets = JSON.parse(key) as Array<[string, number, string | null, boolean]>;
    if (!targets.length) return;
    const controller = new AbortController();
    let active = true;
    const groups = new Map<string, typeof targets>();
    for (const target of targets) {
      const scope = JSON.stringify([target[1], target[2]]);
      const group = groups.get(scope) ?? []; group.push(target); groups.set(scope, group);
    }
    void (async () => {
      const values: Record<string, MaterialReminder> = Object.create(null);
      for (const group of groups.values()) {
        for (let start = 0; start < group.length; start += 50) {
          const batch = group.slice(start, start + 50);
          const params = new URLSearchParams({ runId: String(batch[0][1]), targets: JSON.stringify(batch.map(t => ({ partVersion: t[0], aggregated: t[3] }))) });
          if (archiveId) params.set('archiveId', archiveId);
          else if (batch[0][2]) params.set('dbSource', batch[0][2]);
          const response = await fetch(`/api/fg-material-reminders?${params}`, { signal: controller.signal });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || '關聯材料讀取失敗');
          if (body.runId !== batch[0][1] || body.archiveId !== (archiveId ?? null) || body.dbSource !== (archiveId ? null : batch[0][2])) throw new Error('關聯材料版本或來源不一致');
          for (const target of batch) {
            const row = body.items.find((r: { partVersion: string; aggregated: boolean }) => r.partVersion === target[0] && r.aggregated === target[3]);
            if (!row) throw new Error('關聯材料回應缺少查詢項目');
            values[JSON.stringify(target)] = row.reminder;
          }
        }
      }
      if (active) setResult({ key, archiveId, values });
    })().catch(error => { if (active) setResult({ key, archiveId, values: {}, error: error instanceof Error ? error.message : '關聯材料讀取失敗' }); });
    return () => { active = false; controller.abort(); };
  }, [key, archiveId, attempt]);
  const current = result?.key === key && result.archiveId === archiveId ? result : null;
  const enriched = useMemo(() => items.map(item => ({ ...item, materialReminder: current?.values[JSON.stringify([item.partVersion, item.mrpRunId, item.materialReminderDbSource ?? item.dbSource ?? null, Boolean(item.isAggregated)])], materialReminderError: current?.error })), [items, current]);
  return { items: enriched,
    loading: !current, error: current?.error, retry: () => { setResult(null); setAttempt(value => value + 1); } };
}

export function MaterialReminderButton({ reminder, error, onClick }: { reminder?: MaterialReminder; error?: string; onClick: () => void }) {
  const labels = { risk: '材料缺口', clear: '未見缺口', unknown: '資料不足', none: '無待供需求' };
  const label = error ? '讀取失敗' : reminder ? `${labels[reminder.state]}${reminder.riskCount ? ` · ${reminder.riskCount}` : ''}` : '讀取中';
  const Icon = error ? CircleAlert : !reminder ? Ellipsis : reminder.state === 'risk' ? TriangleAlert : reminder.state === 'unknown' ? Info : ChevronRight;
  return <button type="button" data-no-selection onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onClick(); }}
    title={error ? '查看讀取失敗原因與重試' : `查看關聯材料依據；數字為關聯缺料材料數，不是欠產件數；未進行逐單配料${reminder?.incomplete ? '；資料不完整，未顯示缺口不代表備料完成' : ''}`}
    className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-sm text-[11px] underline-offset-2 hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${error ? 'text-red-700' : reminder?.state === 'risk' ? 'text-amber-800 font-semibold' : 'text-slate-600'}`}><Icon size={12} aria-hidden="true" /><span>{label}</span></button>;
}

export function FgMaterialReminderPanel({ item, archiveId, initiallyOpen = false }: { item: Target; archiveId?: string; initiallyOpen?: boolean }) {
  const result = useMaterialReminders([item], archiveId);
  const reminder = result.items[0].materialReminder;
  const scope: MaterialReminderScope = { runId: item.mrpRunId, archiveId, dbSource: archiveId ? undefined : item.materialReminderDbSource ?? item.dbSource };
  const summaryRef = useRef<HTMLElement>(null);
  const disclosureKey = JSON.stringify([item.partVersion, item.mrpRunId, scope.dbSource, archiveId, Boolean(item.isAggregated), initiallyOpen]);
  useEffect(() => {
    if (!initiallyOpen) return;
    const frame = requestAnimationFrame(() => {
      summaryRef.current?.focus({ preventScroll: true });
      summaryRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [disclosureKey, initiallyOpen]);
  return <section aria-label="關聯材料提醒" className="my-3 overflow-hidden rounded border border-slate-200 bg-white text-xs text-slate-700">
    <details key={disclosureKey} open={initiallyOpen}>
      <summary ref={summaryRef} className="cursor-pointer bg-slate-50 px-3 py-2 marker:text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
        <span className="inline-flex flex-wrap items-center gap-2 align-middle"><span className="font-semibold text-sm">關聯材料提醒</span><span>{reminder ? MATERIAL_REMINDER_LABELS[reminder.state] : result.error ? '讀取失敗' : '讀取中…'}</span><span className="text-slate-500">{archiveId ? '封存 ' : ''}Run {item.mrpRunId}</span></span>
      </summary>
      <div className="px-3 pb-3 pt-2">
    <p className="mt-1 text-slate-600">依同一 Run 工令 BOM 與元件週推提醒本次推算期間的材料缺口，可能影響生產；未進行逐單配料，請依實際供料與排程確認。材料缺口不等於此成品欠產量。</p>
    {result.error && <p role="alert" className="mt-2 text-red-700">{result.error} <button type="button" className="underline" onClick={result.retry}>重試</button></p>}
    {reminder?.incomplete && <p className="mt-2 text-amber-800">部分工令／材料關聯、需求日期或領料資料不足；未顯示缺料不代表備料完成。</p>}
    {reminder && !reminder.rows.length && <p className="mt-2">{reminder.state === 'none' ? '查得的工令材料已無待供料需求；不代表未開工令的生產計畫已備齊材料。' : '沒有足夠資料建立關聯，請人工確認。'}</p>}
    {!!reminder?.rows.length && <div className="mt-3 overflow-auto"><table className="w-full whitespace-nowrap text-left"><thead className="bg-slate-100"><tr>{['客料版本', '來源工令', '關聯材料', '需求日期', '尚需用量', '材料首次缺料', '查詢'].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
      <tbody>{reminder.rows.map((row, index) => <tr key={index} className="border-b border-slate-100"><td className="p-2">{row.partVersion}</td><td className="p-2">{row.woNumber ?? '—'}</td><td className="p-2 font-mono">{row.materialPartNo ?? '—'}</td><td className="p-2">{row.demandDate ?? '待確認'}</td><td className="p-2">{row.issuedQtyState === 'unknown' || row.remainingUsage === null ? '待確認' : `${Number(row.remainingUsage).toLocaleString()} ${row.unit ?? ''}`}</td><td className="p-2">{!row.mrpType ? '未取得週推資料' : row.shortageStartWeek === null ? '未見缺料' : row.shortageStartWeek === 0 ? '前期未結' : `W${row.shortageStartWeek}${row.shortageStartDate ? ` · ${row.shortageStartDate}` : ''}`}</td><td className="p-2">{row.materialPartNo && row.mrpType && <Link className="text-blue-700 underline" href={materialWeeklyHref(scope, row.materialPartNo, row.mrpType)} target="_blank" rel="noopener noreferrer" title="在新分頁查看元件週推">查看元件週推<span className="sr-only">（新分頁）</span></Link>}</td></tr>)}</tbody></table></div>}
      </div>
    </details>
  </section>;
}
