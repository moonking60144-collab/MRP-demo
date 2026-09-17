'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Loader } from './ui/loader';
import type {
  SalesMeetingSourceTarget,
  SalesMeetingSourceType,
  SalesMeetingSourceScope,
} from '@/lib/mrp/sales-meeting-types';

interface SourceRecord {
  id: number;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  orderNo?: string | null;
  customerPartNo?: string | null;
  unshippedQty?: number;
  designatedShipDate?: string | null;
  shipmentStatus?: string | null;
  salesStatus?: string | null;
  planNo?: string | null;
  partVersion?: string | null;
  erpPartNo?: string | null;
  planQty?: number;
  completionDate?: string | null;
  reportedQty?: number;
  closedQty?: number;
  status?: string | null;
}

interface SourceResponse {
  type: SalesMeetingSourceType;
  runId: number;
  scope?: SalesMeetingSourceScope;
  partVersion: string;
  customerPartNo: string | null;
  memberPartVersions: string[];
  erpPartNo: string | null;
  weekLabel: string;
  sharedPool: {
    isShared: boolean;
    isDisplayOwner: boolean;
    members: Array<{ customerCode: string | null; partVersion: string }>;
  };
  summary: {
    goodStockPc: number;
    goodStockKg: number;
    mainStockPc: number | null;
    auxStockPc: number | null;
  };
  period: {
    demand: number;
    supply: number;
    remainingStock: number | null;
  } | null;
  previousRemainingStock: number | null;
  summaryBalance?: {
    demand: number;
    remainingStock: number;
    includesProductionPlans: false;
    members: Array<{ partVersion: string; demand: number; remainingStock: number }>;
  } | null;
  orders: SourceRecord[];
  productionPlans: SourceRecord[];
  error?: string;
}

const TYPE_LABEL: Record<SalesMeetingSourceType, string> = {
  orders: '訂單需求來源',
  production_plans: '生產計畫來源',
  balance: '剩餘庫存計算明細',
};

function number(value: unknown, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—';
}

function SourceLink({ record }: { record: SourceRecord }) {
  if (!record.sourceUrl) return null;
  return (
    <a
      href={record.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-7 w-7 items-center justify-center text-blue-600 hover:bg-blue-50"
      title="在 Source 開啟"
      aria-label="在 Source 開啟"
    >
      <ExternalLink size={14} />
    </a>
  );
}

function OrdersTable({
  records,
  showPartVersion = false,
  scope = 'week',
}: {
  records: SourceRecord[];
  showPartVersion?: boolean;
  scope?: SalesMeetingSourceScope;
}) {
  if (records.length === 0) {
    return <div className="py-6 text-center text-xs text-slate-500">此範圍無未出貨訂單來源</div>;
  }
  return (
    <div className="overflow-auto border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            <th className="px-2 py-2 text-left">訂單編號</th>
            {showPartVersion && <th className="px-2 py-2 text-left">客料版本</th>}
            <th className="px-2 py-2 text-left">客戶料號</th>
            <th className="px-2 py-2 text-right">未出貨pc</th>
            <th className="px-2 py-2 text-left">指定出貨日{scope === 'all' && '（含遠期）'}</th>
            <th className="px-2 py-2 text-center">狀態</th>
            <th className="w-9" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="border-t border-slate-100 hover:bg-blue-50/40">
              <td className="px-2 py-2 font-mono">{record.orderNo || '—'}</td>
              {showPartVersion && <td className="px-2 py-2 font-mono">{record.partVersion || '—'}</td>}
              <td className="px-2 py-2 font-mono">{record.customerPartNo || '—'}</td>
              <td className="px-2 py-2 text-right font-mono">{number(record.unshippedQty, 2)}</td>
              <td className="px-2 py-2 whitespace-nowrap">{record.designatedShipDate?.slice(0, 10) || '—'}</td>
              <td className="px-2 py-2 text-center whitespace-nowrap">
                {record.shipmentStatus || '—'} / {record.salesStatus || '—'}
              </td>
              <td><SourceLink record={record} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlansTable({ records }: { records: SourceRecord[] }) {
  if (records.length === 0) {
    return <div className="py-6 text-center text-xs text-slate-400">此週無生產計畫來源</div>;
  }
  return (
    <div className="overflow-auto border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            <th className="px-2 py-2 text-left">生產計畫編號</th>
            <th className="px-2 py-2 text-left">客料版本</th>
            <th className="px-2 py-2 text-right">計畫量pc</th>
            <th className="px-2 py-2 text-left">完成日</th>
            <th className="px-2 py-2 text-right">報工 / 結案</th>
            <th className="w-9" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="border-t border-slate-100 hover:bg-blue-50/40">
              <td className="px-2 py-2 font-mono">{record.planNo || '—'}</td>
              <td className="px-2 py-2 font-mono">{record.partVersion || '—'}</td>
              <td className="px-2 py-2 text-right font-mono">{number(record.planQty, 2)}</td>
              <td className="px-2 py-2 whitespace-nowrap">{record.completionDate?.slice(0, 10) || '—'}</td>
              <td className="px-2 py-2 text-right font-mono whitespace-nowrap">
                {number(record.reportedQty, 2)} / {number(record.closedQty, 2)}
              </td>
              <td><SourceLink record={record} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SalesMeetingSourceDrawer({
  target,
  onClose,
}: {
  target: SalesMeetingSourceTarget;
  onClose: () => void;
}) {
  const [data, setData] = useState<SourceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const requestSeq = ++requestSeqRef.current;
    setData(null);
    setError(null);
    closeRef.current?.focus();
    const controller = new AbortController();
    const params = new URLSearchParams({
      runId: String(target.item.mrpRunId),
      type: target.type,
      weekIndex: String(target.weekIndex),
      memberPartVersions: JSON.stringify(target.item.memberPartVersions),
      scope: target.scope || 'week',
    });
    if (target.item.dbSource) params.set('dbSource', target.item.dbSource);
    fetch(
      `/api/sales-meeting/${encodeURIComponent(target.item.partVersion)}/source-records?${params}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json() as SourceResponse;
        if (!response.ok) throw new Error(body.error || '讀取來源明細失敗');
        if (requestSeq !== requestSeqRef.current) return;
        setData(body);
      })
      .catch((reason) => {
        if (
          requestSeq === requestSeqRef.current
          && reason instanceof Error
          && reason.name !== 'AbortError'
        ) {
          setError(reason.message);
        }
      });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]');
        const first = focusable?.[0];
        const last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      controller.abort();
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, target]);

  return (
    <div
      className="fixed inset-0 z-[110] bg-slate-950/25"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sales-meeting-source-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-4xl flex-col bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-blue-700">產銷週推來源追溯</div>
            <h3 id="sales-meeting-source-title" className="mt-1 text-base font-bold text-slate-900">
              {target.type === 'balance' && target.scope && target.scope !== 'week' ? '成品餘缺計算依據（不含生產計畫）' : TYPE_LABEL[target.type]}
            </h3>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">
                {target.item.customerPartNo || target.item.partVersion}
              </span>
              {target.item.memberPartVersions.length > 1 && (
                <span>{target.item.memberPartVersions.length} 個客料版本</span>
              )}
              <span className="font-mono">ERP {target.item.erpPartNo || '—'}</span>
              <span>{target.weekLabel}</span>
              <span>Run {target.item.mrpRunId} · 唯讀快照</span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-100"
            title="關閉"
            aria-label="關閉來源明細"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto px-5 py-4">
          {!data && !error && <Loader />}
          {error && (
            <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          {data && (
            <div className="space-y-4">
              {data.summaryBalance && (
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                  {data.scope === 'recent'
                    ? '近期包含前期未出貨訂單＋前4週；前期指 Run 起始週之前。'
                    : '全部包含此 Run 已納入的前期、12週內與12週以外的遠期未出貨訂單。'}
                  {' '}資料固定於此 Run，不是目前即時訂單。
                </div>
              )}
              {target.type === 'balance' && data.summaryBalance && (
                <>
                  <div className="grid grid-cols-3 gap-px border border-slate-200 bg-slate-200">
                    {[
                      ['良品庫存pc', data.summary.goodStockPc],
                      ['本列訂單量', data.summaryBalance.demand],
                      ['成品餘缺（不含計畫）', data.summaryBalance.remainingStock],
                    ].map(([label, value]) => <div key={String(label)} className="bg-white px-3 py-3">
                      <div className="text-[11px] text-slate-500">{label}</div>
                      <div className={`mt-1 font-mono text-base font-bold ${Number(value) < 0 ? 'text-red-700' : 'text-slate-900'}`}>{number(value, 2)}</div>
                    </div>)}
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                    {data.sharedPool.isShared
                      ? '同 ERP 庫存只計一次，訂單依指定出貨日、客戶代碼與客料版本順序扣用。此列餘缺取所含版本已保存結果的較小值，不等於單獨用本列庫存減本列訂單量。下方包含共享 ERP 的訂單來源。'
                      : '成品餘缺使用此 Run 已保存的庫存扣訂單結果，不加生產計畫；負數表示缺口。'}
                    {' '}右側各週的「剩餘庫存」另有納入生產計畫，兩者不可混用。
                  </div>
                  {data.summaryBalance.members.length > 1 && <div className="overflow-auto border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100"><tr><th className="px-2 py-2 text-left">客料版本</th><th className="px-2 py-2 text-right">訂單量</th><th className="px-2 py-2 text-right">已保存成品餘缺</th></tr></thead>
                      <tbody>{data.summaryBalance.members.map(member => <tr key={member.partVersion} className="border-t border-slate-100"><td className="px-2 py-2 font-mono">{member.partVersion}</td><td className="px-2 py-2 text-right font-mono">{number(member.demand, 2)}</td><td className="px-2 py-2 text-right font-mono">{number(member.remainingStock, 2)}</td></tr>)}</tbody>
                    </table>
                  </div>}
                </>
              )}
              {target.type === 'balance' && !data.summaryBalance && (
                <>
                  <div className="grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-4">
                    {[
                      ['本期需求', data.period?.demand],
                      ['本期供給', data.period?.supply],
                      ['本期剩餘', data.period?.remainingStock],
                      ['前期剩餘', data.previousRemainingStock],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="bg-white px-3 py-3">
                        <div className="text-[11px] text-slate-500">{label}</div>
                        <div className={`mt-1 font-mono text-base font-bold ${
                          Number(value) < 0 ? 'text-red-700' : 'text-slate-900'
                        }`}>
                          {number(value, 2)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                    {data.sharedPool.isShared
                      ? `此列使用同 ERP 共享池。生產供給先加入共用池，再依指定出貨日、客戶代碼與客料版本順序扣用；此數字是「${target.item.customerPartNo || target.item.partVersion}」所含版本完成扣用後的較小共享池餘額，不等於單獨以本列庫存減本列需求。`
                      : '此列未與其他客料版本共用 ERP；剩餘庫存由 Run 庫存、當週生產計畫與訂單需求依序推算。'}
                  </div>
                  {data.memberPartVersions.length > 1 && (
                    <div className="text-xs text-slate-600">
                      <span className="font-semibold">包含版本：</span>
                      {data.memberPartVersions.join('、')}
                    </div>
                  )}
                  {data.sharedPool.isShared && (
                    <div className="text-xs text-slate-600">
                      <span className="font-semibold">共享池順序：</span>
                      {data.sharedPool.members.map((member) =>
                        `${member.customerCode || '—'} ${member.partVersion}`).join(' → ')}
                    </div>
                  )}
                </>
              )}

              {(target.type === 'orders' || target.type === 'balance') && (
                <section>
                  {target.type === 'balance' && (
                    <h4 className="mb-2 text-xs font-bold text-slate-700">{data.summaryBalance ? '此範圍訂單來源' : '本期訂單需求來源'}</h4>
                  )}
                  <div className="mb-2 text-xs text-slate-500">{data.orders.length} 筆訂單{target.type === 'orders' && data.summaryBalance && ` · 合計 ${number(data.summaryBalance.demand, 2)} pc`}</div>
                  <OrdersTable records={data.orders} showPartVersion={target.type === 'balance' || data.memberPartVersions.length > 1} scope={data.scope} />
                </section>
              )}
              {(target.type === 'production_plans' || (target.type === 'balance' && !data.summaryBalance)) && (
                <section>
                  {target.type === 'balance' && (
                    <h4 className="mb-2 text-xs font-bold text-slate-700">本期生產計畫來源</h4>
                  )}
                  <PlansTable records={data.productionPlans} />
                </section>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
