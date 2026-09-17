'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, RefreshCw, X } from 'lucide-react';
import { Loader } from './ui/loader';
import {
  matchesWarehouseStockFilter,
  WAREHOUSE_STOCK_GROUPS,
  type WarehouseStockFilter,
  type WarehouseStockGroup,
} from '@/lib/mrp/warehouse-stock';

interface WarehouseStockLot {
  ragicRecordId: string;
  lotNo: string | null;
  erpPartNo: string;
  warehouseCode: string | null;
  stockStatus: string | null;
  qualityStatus: string | null;
  stockPc: number;
  stockKg: number;
  unitWeightG: number | null;
  expectedStockPc: number | null;
  stockPcDiff: number | null;
  stockPcDiffPct: number | null;
  quantityAnomaly: boolean;
  includedInMrp: boolean;
  sourceWorkOrderNo: string | null;
  sourceWorkOrderType: string | null;
  sourceWorkOrderRagicUrl: string | null;
  ragicUrl: string;
}

interface WarehouseQualitySummary {
  qualityStatus: string;
  lotCount: number;
  stockPc: number;
  stockKg: number;
  includedInMrp: boolean;
}

interface WarehouseStockResponse {
  warehouse: { code: WarehouseStockGroup; name: string };
  erpPartNos: string[];
  totalPc: number;
  totalKg: number;
  availablePc: number;
  availableKg: number;
  excludedPc: number;
  excludedKg: number;
  inventoryValidationAvailable: boolean;
  inventoryAnomalyCount: number;
  qualitySummaries: WarehouseQualitySummary[];
  lots: WarehouseStockLot[];
  error?: string;
}

interface WarehouseStockRecheckResult {
  recordId: string;
  ragicUrl: string;
  snapshot: {
    stockPc: number;
    stockKg: number;
    unitWeightG: number | null;
    expectedStockPc: number | null;
    stockPcDiff: number | null;
    quantityAnomaly: boolean;
  };
  live: {
    stockPc: number;
    stockKg: number;
    unitWeightG: number | null;
    expectedStockPc: number | null;
    stockPcDiff: number | null;
    stockPcDiffPct: number | null;
    quantityAnomaly: boolean;
  };
  ragicCorrected: boolean;
  mrpRunNeedsRefresh: boolean;
}

interface WarehouseStockRecheckState {
  loading: boolean;
  error: string | null;
  result: WarehouseStockRecheckResult | null;
}

export interface WarehouseStockRequest {
  runId: number;
  partVersion: string;
  aggregated: boolean;
  warehouseGroup: WarehouseStockGroup;
  initialFilter?: WarehouseStockFilter;
  dbSource?: 'local' | 'docker' | 'remote';
}

export function WarehouseStockValue({
  value,
  warehouseGroup,
  onOpen,
  hasInventoryAnomaly = false,
  inventoryAnomalyCount = 0,
}: {
  value: number | null;
  warehouseGroup: WarehouseStockGroup;
  onOpen: () => void;
  hasInventoryAnomaly?: boolean;
  inventoryAnomalyCount?: number;
}) {
  if (value === null) {
    return (
      <span className="text-slate-300" title="此 MRP Run 尚無倉別庫存快照">
        —
      </span>
    );
  }
  const title = hasInventoryAnomaly
    ? `此數字包含 ${inventoryAnomalyCount} 筆可能未同步的 Ragic 庫存批號，點擊查看`
    : `查看 ${WAREHOUSE_STOCK_GROUPS[warehouseGroup].name}在庫批號明細`;
  return (
    <button
      type="button"
      data-no-selection
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`inline-flex items-center gap-1 rounded-[3px] px-1 ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 ${
        hasInventoryAnomaly
          ? 'bg-amber-50 text-amber-800 ring-amber-400 hover:bg-amber-100'
          : 'text-sky-700 ring-sky-400 hover:bg-sky-100 hover:text-sky-900'
      }`}
      title={title}
      aria-label={title}
    >
      {hasInventoryAnomaly && <AlertTriangle size={11} aria-hidden="true" />}
      {value.toLocaleString()}
    </button>
  );
}

export function WarehouseStockDrawer({
  request,
  onClose,
}: {
  request: WarehouseStockRequest;
  onClose: () => void;
}) {
  const [data, setData] = useState<WarehouseStockResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qualityFilter, setQualityFilter] = useState<WarehouseStockFilter>(
    request.initialFilter ?? 'MRP',
  );
  const [recheckByRecordId, setRecheckByRecordId] = useState<Record<string, WarehouseStockRecheckState>>({});
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setQualityFilter(request.initialFilter ?? 'MRP');
    setRecheckByRecordId({});
    closeRef.current?.focus();
    const controller = new AbortController();
    const params = new URLSearchParams({
      runId: String(request.runId),
      partVersion: request.partVersion,
      aggregated: String(request.aggregated),
      warehouse: request.warehouseGroup,
    });
    if (request.dbSource) params.set('dbSource', request.dbSource);
    fetch(`/api/fg-monthly/warehouse-stock?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as WarehouseStockResponse;
        if (!response.ok) throw new Error(body.error || '讀取倉庫明細失敗');
        setData(body);
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== 'AbortError') setError(reason.message);
      });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      controller.abort();
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, request]);

  const recheckLot = async (lot: WarehouseStockLot) => {
    setRecheckByRecordId((previous) => ({
      ...previous,
      [lot.ragicRecordId]: { loading: true, error: null, result: previous[lot.ragicRecordId]?.result ?? null },
    }));
    const params = new URLSearchParams({
      runId: String(request.runId),
      recordId: lot.ragicRecordId,
    });
    if (request.dbSource) params.set('dbSource', request.dbSource);
    try {
      const response = await fetch(`/api/fg-monthly/warehouse-stock/recheck?${params}`);
      const body = await response.json() as WarehouseStockRecheckResult & { error?: string };
      if (!response.ok) throw new Error(body.error || '重新檢查 Ragic 失敗');
      setRecheckByRecordId((previous) => ({
        ...previous,
        [lot.ragicRecordId]: { loading: false, error: null, result: body },
      }));
    } catch (reason) {
      setRecheckByRecordId((previous) => ({
        ...previous,
        [lot.ragicRecordId]: {
          loading: false,
          error: reason instanceof Error ? reason.message : '重新檢查 Ragic 失敗',
          result: previous[lot.ragicRecordId]?.result ?? null,
        },
      }));
    }
  };

  const visibleLots = data?.lots.filter((lot) => matchesWarehouseStockFilter(lot, qualityFilter)) ?? [];
  const visiblePc = visibleLots.reduce((sum, lot) => sum + lot.stockPc, 0);
  const visibleKg = visibleLots.reduce((sum, lot) => sum + lot.stockKg, 0);

  return (
    <div
      className="fixed inset-0 z-[110] bg-slate-950/25"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="warehouse-stock-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-4xl flex-col bg-white shadow-2xl"
        data-warehouse-stock-drawer
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-sky-700">MRP Run 庫存快照</div>
            <h3 id="warehouse-stock-title" className="mt-1 text-base font-bold text-slate-900">
              {data?.warehouse.name ?? WAREHOUSE_STOCK_GROUPS[request.warehouseGroup].name}在庫明細
            </h3>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">{request.partVersion}</span>
              {data?.erpPartNos.map((erp) => <span key={erp} className="font-mono">ERP {erp}</span>)}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-100"
            title="關閉"
            aria-label="關閉倉庫在庫明細"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-5">
          {!data && !error && <Loader label="讀取庫存快照" />}
          {error && <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {data && (
            <>
              {!data.inventoryValidationAvailable ? (
                <div className="mb-3 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  此歷史 Run 尚無庫存批號數量驗證資料；數字仍採用當時的 Ragic 快照。
                </div>
              ) : data.inventoryAnomalyCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setQualityFilter('ANOMALY')}
                  className="mb-3 flex w-full items-center gap-3 border border-amber-400 bg-amber-50 px-3 py-2.5 text-left text-xs text-amber-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  data-inventory-anomaly-summary
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center bg-amber-200 text-amber-900">
                    <AlertTriangle size={17} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block text-sm">{data.inventoryAnomalyCount} 筆庫存批號數量待確認</b>
                    <span className="mt-0.5 block text-amber-800">
                      MRP 保留 Ragic 原值計算；請逐筆核對後在 Ragic 修正，再重跑 MRP。
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-amber-900">
                    只看異常批號 <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </button>
              ) : null}
              <div className="mb-3 grid grid-cols-2 border-y border-slate-200 bg-slate-50 text-sm sm:grid-cols-4">
                <div className="border-r border-slate-200 px-4 py-3">
                  <div className="text-[11px] text-slate-500">MRP可用</div>
                  <b className="font-mono text-slate-900">{data.availablePc.toLocaleString()} pc</b>
                </div>
                <div className="border-r border-slate-200 px-4 py-3">
                  <div className="text-[11px] text-slate-500">全部在庫</div>
                  <b className="font-mono text-slate-900">{data.totalPc.toLocaleString()} pc</b>
                </div>
                <div className="border-r border-slate-200 px-4 py-3">
                  <div className="text-[11px] text-slate-500">排除MRP</div>
                  <b className={data.excludedPc > 0 ? 'font-mono text-red-700' : 'font-mono text-slate-900'}>
                    {data.excludedPc.toLocaleString()} pc
                  </b>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">批號</div>
                  <b className="font-mono text-slate-900">{data.lots.length}</b>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="品質狀態篩選">
                {([
                  ...(data.inventoryAnomalyCount > 0
                    ? [['ANOMALY', '數量異常', data.inventoryAnomalyCount] as const]
                    : []),
                  ['MRP', 'MRP可用', data.lots.filter((lot) => lot.includedInMrp).length],
                  ['ALL', '全部在庫', data.lots.length],
                  ['EXCLUDED', '不良／其他', data.lots.filter((lot) => !lot.includedInMrp).length],
                ] as const).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setQualityFilter(value)}
                    aria-pressed={qualityFilter === value}
                    className={`border px-2.5 py-1.5 text-xs font-medium ${
                      qualityFilter === value
                        ? value === 'ANOMALY'
                          ? 'border-amber-500 bg-amber-100 text-amber-950'
                          : 'border-sky-500 bg-sky-50 text-sky-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {value === 'ANOMALY' && <AlertTriangle size={11} className="mr-1 inline" aria-hidden="true" />}
                    {label} <span className="font-mono text-[10px] opacity-70">{count}</span>
                  </button>
                ))}
                {data.qualitySummaries.map((summary) => {
                  const value = `QUALITY:${summary.qualityStatus}` as const;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setQualityFilter(value)}
                      aria-pressed={qualityFilter === value}
                      className={`border px-2.5 py-1.5 text-xs font-medium ${
                        qualityFilter === value
                          ? 'border-sky-500 bg-sky-50 text-sky-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {summary.qualityStatus} <span className="font-mono text-[10px] opacity-70">{summary.lotCount}</span>
                    </button>
                  );
                })}
                <span className="ml-auto text-xs text-slate-500">
                  顯示 <b className="font-mono text-slate-800">{visibleLots.length}</b> 批・
                  <b className="font-mono text-slate-800">{visiblePc.toLocaleString()} pc</b>
                  <span className="ml-1 text-slate-400">
                    ({visibleKg.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg)
                  </span>
                </span>
              </div>

              {visibleLots.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">此 Run 沒有符合條件的在庫批號。</div>
              ) : (
                <div className="overflow-auto border border-slate-200">
                  <table className="min-w-full border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">庫存批號</th>
                        <th className="px-3 py-2 text-left">ERP料號</th>
                        <th className="px-3 py-2 text-left">倉庫</th>
                        <th className="px-3 py-2 text-left">品質／狀態</th>
                        <th className="px-3 py-2 text-left">MRP／帳實</th>
                        <th className="px-3 py-2 text-right">在庫pc</th>
                        <th className="px-3 py-2 text-right">在庫kg</th>
                        <th className="px-3 py-2 text-left">來源工令</th>
                        <th className="w-10 px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLots.map((lot) => (
                        <tr
                          key={lot.ragicRecordId}
                          className={lot.quantityAnomaly
                            ? 'bg-amber-50'
                            : 'border-t border-slate-100 odd:bg-white even:bg-slate-50/60'}
                          data-inventory-anomaly={lot.quantityAnomaly ? 'true' : undefined}
                        >
                          <td className={`px-3 py-2 font-mono ${lot.quantityAnomaly ? 'shadow-[inset_3px_0_0_#f59e0b]' : ''}`}>
                            <a
                              href={lot.ragicUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900 hover:decoration-blue-700"
                              title="開啟 Ragic 庫存批號"
                            >
                              {lot.lotNo || lot.ragicRecordId}
                              <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          </td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{lot.erpPartNo}</td>
                          <td className="px-3 py-2">{lot.warehouseCode || '—'}</td>
                          <td className="px-3 py-2">{lot.qualityStatus || '—'}／{lot.stockStatus || '—'}</td>
                          <td className="px-3 py-2">
                            <div className="flex min-w-[120px] flex-col items-start gap-1">
                              <span className={`inline-flex border px-1.5 py-0.5 text-[10px] font-semibold ${
                                lot.includedInMrp
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : 'border-red-200 bg-red-50 text-red-700'
                              }`}>
                                {lot.includedInMrp ? '納入' : '排除'}
                              </span>
                              {lot.quantityAnomaly && (
                                <span className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                  <AlertTriangle size={10} aria-hidden="true" />數量待確認
                                </span>
                              )}
                              {recheckByRecordId[lot.ragicRecordId]?.result?.ragicCorrected && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                                  <CheckCircle2 size={11} aria-hidden="true" />Ragic 已修正，請重跑 MRP
                                </span>
                              )}
                              {recheckByRecordId[lot.ragicRecordId]?.result && !recheckByRecordId[lot.ragicRecordId]?.result?.ragicCorrected && (
                                <span className="text-[10px] font-semibold text-amber-700">Ragic 目前仍有差異</span>
                              )}
                              {recheckByRecordId[lot.ragicRecordId]?.error && (
                                <span className="text-[10px] text-red-700">{recheckByRecordId[lot.ragicRecordId]?.error}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            <div className={lot.quantityAnomaly ? 'font-semibold text-amber-800' : undefined}>
                              {lot.stockPc.toLocaleString()}
                            </div>
                            {lot.quantityAnomaly && lot.expectedStockPc !== null && (
                              <div className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-amber-700">
                                kg換算 {lot.expectedStockPc.toLocaleString()}・差 {Number(lot.stockPcDiff).toLocaleString()}
                              </div>
                            )}
                            {recheckByRecordId[lot.ragicRecordId]?.result && (
                              <div className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-slate-500">
                                目前 Ragic {recheckByRecordId[lot.ragicRecordId]?.result?.live.stockPc.toLocaleString()} pc
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{lot.stockKg.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                          <td className="px-3 py-2">
                            {lot.sourceWorkOrderNo ? (
                              <div className="min-w-[128px]">
                                {lot.sourceWorkOrderRagicUrl ? (
                                  <a
                                    href={lot.sourceWorkOrderRagicUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 font-mono text-blue-700 hover:underline"
                                  >
                                    {lot.sourceWorkOrderNo}<ExternalLink size={11} />
                                  </a>
                                ) : (
                                  <span className="font-mono text-slate-800">{lot.sourceWorkOrderNo}</span>
                                )}
                                {lot.sourceWorkOrderType && (
                                  <div className="mt-0.5 text-[10px] text-slate-500">
                                    {lot.sourceWorkOrderType}
                                  </div>
                                )}
                              </div>
                            ) : '—'}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {lot.quantityAnomaly && (
                                <button
                                  type="button"
                                  onClick={() => void recheckLot(lot)}
                                  disabled={recheckByRecordId[lot.ragicRecordId]?.loading}
                                  className="inline-flex h-7 w-7 items-center justify-center text-amber-700 hover:bg-amber-50 disabled:cursor-wait disabled:opacity-50"
                                  title="唯讀重新檢查目前 Ragic 數值"
                                  aria-label={`重新檢查 Ragic 庫存批號 ${lot.lotNo || lot.ragicRecordId}`}
                                >
                                  <RefreshCw
                                    size={14}
                                    className={recheckByRecordId[lot.ragicRecordId]?.loading ? 'animate-spin' : undefined}
                                  />
                                </button>
                              )}
                              <a
                                href={lot.ragicUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-7 w-7 items-center justify-center text-blue-600 hover:bg-blue-50 hover:text-blue-800"
                                title="開啟 Ragic 庫存批號"
                                aria-label={`開啟 Ragic 庫存批號 ${lot.lotNo || lot.ragicRecordId}`}
                              >
                                <ExternalLink size={14} />
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
