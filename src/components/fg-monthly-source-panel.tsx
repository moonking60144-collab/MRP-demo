'use client';

import { useState, useEffect } from 'react';
import { subscribeWorkOrderStatus } from '@/lib/work-order-events-client';
import {
  WORK_ORDER_STATUS,
  type WorkOrderStatus,
  type WorkOrderStatusEvent,
} from '@/lib/work-order-state';
import { fetchFgMonthlySourcesByIdentity } from '@/lib/mrp/fg-monthly-period-client';
import { buildSourceRecordUrl, type SourceRecordType } from '@/lib/source-record-links';
import {
  FG_MONTHLY_ORDER_ATTRIBUTION_LABELS,
  type FgMonthlyOrderAttributionStatus,
} from '@/lib/mrp/fg-monthly-source-detail';
import {
  ORDER_DEMAND_ANOMALY_LABELS,
  ORDER_DEMAND_BASIS_LABELS,
  type OrderDemandAnomaly,
  type OrderDemandContributionBasis,
  type OrderDemandSummary,
} from '@/lib/mrp/order-demand-contract';

type Row = Record<string, unknown>;
type SourceKey =
  | 'partVersions' | 'inventory' | 'orders' | 'forecasts'
  | 'workOrders' | 'workOrderBoms' | 'productionPlans';

interface SourceData {
  partVersion: string;
  runId: number;
  dbSource?: string | null;
  contractVersion: string;
  sourcePartVersions: string[];
  partVersions: Row[];
  inventory: Row[];
  orders: Row[];
  forecasts: Row[];
  workOrders: Row[];
  workOrderBoms: Row[];
  productionPlans: Row[];
  erpPartNo: string | null;
  orderDemandSummary: OrderDemandSummary;
}

interface ColDef {
  key: string;
  label: string;
  type?: 'date' | 'num' | 'bool' | 'generation' | 'basis' | 'anomalies' | 'attribution';
  mono?: boolean;
  align?: 'right';
}

const TABS: { key: SourceKey; label: string }[] = [
  { key: 'partVersions',    label: '客戶料號' },
  { key: 'inventory',       label: '料品庫存' },
  { key: 'orders',          label: '訂單明細' },
  { key: 'forecasts',       label: '預示量' },
  { key: 'workOrders',      label: '工令單' },
  { key: 'workOrderBoms',   label: '工令單-BOM' },
  { key: 'productionPlans', label: '生產計畫' },
];

// Demo 來源連結只開啟本機合成紀錄，不連到外部表單。
const SOURCE_LINK: Record<SourceKey, { type: SourceRecordType; label: string }> = {
  partVersions:    { type: 'part-version', label: '客戶料號版本' },
  inventory:       { type: 'inventory', label: 'ERP 料品資料' },
  orders:          { type: 'order', label: '訂單明細' },
  forecasts:       { type: 'forecast', label: '客戶預示量' },
  workOrders:      { type: 'work-order', label: '工令單' },
  workOrderBoms:   { type: 'work-order-bom', label: '工令單 BOM' },
  productionPlans: { type: 'production-plan', label: '生產計畫' },
};

function buildMasterUrl(tabKey: SourceKey, row: Row): string | null {
  return buildSourceRecordUrl(SOURCE_LINK[tabKey].type, String(row.sourceRecordId ?? ''));
}

const COLS: Record<SourceKey, ColDef[]> = {
  partVersions: [
    { key: 'partVersion',        label: '客戶料號版本',  mono: true },
    { key: 'customerCode',       label: '客戶代碼' },
    { key: 'customerPartNo',     label: '客戶料號',      mono: true },
    { key: 'erpPartNo',          label: 'ERP料號',       mono: true },
    { key: 'productStatus',      label: '產品狀態' },
    { key: 'sortGroup',          label: 'MRP排序群組',   align: 'right' },
    { key: 'forgingParent',      label: '鍛造母件' },
    { key: 'surfaceTreatment',   label: '表面處理' },
    { key: 'targetStockPeriods', label: '目標備庫期數',  type: 'num', align: 'right' },
    { key: 'skipFgInventory',    label: '不計算成品庫存?', type: 'bool' },
  ],
  inventory: [
    { key: 'erpPartNo',         label: 'ERP料號',         mono: true },
    { key: 'goodStockPc',       label: '良品pc',          type: 'num', align: 'right' },
    { key: 'goodStockKg',       label: '良品kg',          type: 'num', align: 'right' },
    { key: 'badStockPc',        label: '不良pc',          type: 'num', align: 'right' },
    { key: 'badStockKg',        label: '不良kg',          type: 'num', align: 'right' },
    { key: 'purchaseLeadWeeks', label: '採購前置週數',    type: 'num', align: 'right' },
  ],
  orders: [
    { key: 'orderNo',            label: '訂單編號',       mono: true },
    { key: 'orderType',          label: '類型' },
    { key: 'customerPartNo',     label: '客戶料號',       mono: true },
    { key: 'partVersion',        label: '客戶料號版本',   mono: true },
    { key: 'orderQty',           label: '原始訂單pc',     type: 'num', align: 'right' },
    { key: 'designatedShipDate', label: '指定出貨日',     type: 'date' },
    { key: 'preparedQty',        label: '實際已備貨pc',   type: 'num', align: 'right' },
    { key: 'shippedQty',         label: '實際已出庫pc',   type: 'num', align: 'right' },
    { key: 'soldQty',            label: '實際已銷貨pc',   type: 'num', align: 'right' },
    { key: 'orderDemandContribution.preparedNotShippedQty', label: '已備未出庫pc', type: 'num', align: 'right' },
    { key: 'orderDemandAttribution.recognizedOrderQty', label: '訂單總量（MRP認列）pc', type: 'num', align: 'right' },
    { key: 'orderDemandAttribution.outstandingOrderQty', label: '訂單未結（MRP認列）pc', type: 'num', align: 'right' },
    { key: 'orderDemandAttribution.demandResolvedQty', label: '預示抵扣基礎pc', type: 'num', align: 'right' },
    { key: 'orderDemandContribution.closedUnfulfilledQty', label: '結案未履行pc', type: 'num', align: 'right' },
    { key: 'orderDemandAttribution.status', label: '月推歸屬', type: 'attribution' },
    { key: 'orderDemandContribution.basis', label: '數量判定', type: 'basis' },
    { key: 'orderDemandContribution.anomalies', label: '資料檢查', type: 'anomalies' },
    { key: 'shipmentStatus',     label: '出庫狀態' },
    { key: 'salesStatus',        label: '銷貨狀態' },
    { key: 'prepStatus',         label: '備貨狀態' },
  ],
  forecasts: [
    { key: 'partVersion',   label: '客戶料號版本', mono: true },
    { key: 'forecastStart', label: '需求月起始',   type: 'date' },
    { key: 'forecastQty',   label: '需求pc',       type: 'num', align: 'right' },
  ],
  workOrders: [
    { key: 'woNumber',      label: '工令單號',       mono: true },
    { key: 'partVersion',   label: '目標客料版本',   mono: true },
    { key: 'erpPartNo',     label: '完工ERP料號',    mono: true },
    { key: 'woQty',         label: '預定生產pc',     type: 'num', align: 'right' },
    { key: 'startDate',     label: '開始日',         type: 'date' },
    { key: 'endDate',       label: '結束日',         type: 'date' },
    { key: 'status',        label: '工令狀態' },
    { key: 'alreadyPicked', label: '領過料?' },
  ],
  workOrderBoms: [
    { key: 'woNumber',    label: '工令單號',       mono: true },
    { key: 'componentNo', label: '組件料號',       mono: true },
    { key: 'processCode', label: '製程' },
    { key: 'minUsage',    label: '預估最少用量',   type: 'num', align: 'right' },
    { key: 'unit',        label: '單位' },
    { key: 'startDate',   label: '開始日',         type: 'date' },
  ],
  productionPlans: [
    { key: 'planNo',         label: '生產計畫編號',       mono: true },
    { key: 'partVersion',    label: '目標客戶料號版本', mono: true },
    { key: 'erpPartNo',      label: '目標ERP料號',     mono: true },
    { key: 'planQty',        label: '計畫量pc',        type: 'num', align: 'right' },
    { key: 'completionDate', label: '預計完成日',      type: 'date' },
    { key: 'reportedQty',    label: '累計報工pc',      type: 'num', align: 'right' },
    { key: 'closedQty',      label: '累計結案入庫pc',  type: 'num', align: 'right' },
    { key: 'status',         label: '計畫狀態' },
    { key: 'generationStatus', label: '工令產生進度', type: 'generation' },
  ],
};

const GENERATION_STATUS: Record<WorkOrderStatus, { label: string; className: string }> = {
  [WORK_ORDER_STATUS.IDLE]: { label: '尚未排程', className: 'border-slate-300 bg-slate-50 text-slate-600' },
  [WORK_ORDER_STATUS.QUEUED]: { label: '排隊中', className: 'border-indigo-300 bg-indigo-50 text-indigo-700' },
  [WORK_ORDER_STATUS.PENDING]: { label: 'Source 執行中', className: 'border-blue-300 bg-blue-50 text-blue-700' },
  [WORK_ORDER_STATUS.SUCCEEDED]: { label: '工令已產生', className: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  [WORK_ORDER_STATUS.UNKNOWN]: { label: '待人工確認', className: 'border-amber-300 bg-amber-50 text-amber-800' },
  [WORK_ORDER_STATUS.FAILED]: { label: '執行失敗', className: 'border-red-300 bg-red-50 text-red-700' },
};

function formatCell(v: unknown, type?: ColDef['type']): React.ReactNode {
  if (type === 'generation') {
    const config = typeof v === 'string'
      ? GENERATION_STATUS[v as WorkOrderStatus]
      : null;
    return (
      <span className={`inline-flex h-6 items-center whitespace-nowrap rounded border px-1.5 text-[11px] font-medium ${
        config?.className ?? 'border-slate-200 bg-slate-50 text-slate-400'
      }`}>
        {config?.label ?? '非 App 建立'}
      </span>
    );
  }
  if (v == null || v === '') return <span className="text-slate-300">—</span>;
  if (type === 'basis') {
    return ORDER_DEMAND_BASIS_LABELS[String(v) as OrderDemandContributionBasis] ?? String(v);
  }
  if (type === 'attribution') {
    return FG_MONTHLY_ORDER_ATTRIBUTION_LABELS[
      String(v) as FgMonthlyOrderAttributionStatus
    ] ?? String(v);
  }
  if (type === 'anomalies') {
    const values = Array.isArray(v) ? v : [];
    return values.length > 0
      ? (
          <span className="font-medium text-amber-700">
            {values.map((value) => (
              ORDER_DEMAND_ANOMALY_LABELS[String(value) as OrderDemandAnomaly] ?? String(value)
            )).join('、')}
          </span>
        )
      : <span className="text-emerald-700">正常</span>;
  }
  if (type === 'date') return String(v).slice(0, 10);
  if (type === 'num') return Number(v).toLocaleString();
  if (type === 'bool') return v ? '✓' : '—';
  return String(v);
}

function nestedValue(row: Row, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)[part]
      : undefined
  ), row);
}

function orderSummaryValue(value: number, unknownCount: number = 0) {
  return (
    <span className="font-mono text-sm font-semibold tabular-nums text-slate-900">
      {value.toLocaleString()}
      {unknownCount > 0 && (
        <span className="ml-1 font-sans text-[10px] font-medium text-amber-700">
          + {unknownCount} 筆未知
        </span>
      )}
    </span>
  );
}

function OrderDemandSummaryBlock({ data }: { data: SourceData }) {
  const summary = data.orderDemandSummary;
  const isV2 = data.contractVersion === 'order-demand-v2-manual-close';
  const includedCount = data.orders.filter((order) => {
    const status = nestedValue(order, 'orderDemandAttribution.status');
    return status === 'included_prior' || status === 'included_period';
  }).length;
  const excludedCount = summary.orderCount - includedCount;
  return (
    <div className="mb-3 overflow-hidden rounded border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-xs">
        <div className="text-slate-600">
          <span className="font-semibold text-slate-800">訂單範圍</span>
          <span className="ml-2">{data.sourcePartVersions.length} 個客料版本／共 {summary.orderCount} 筆</span>
          <span className="ml-2 text-emerald-700">月推納入 {includedCount} 筆</span>
          {excludedCount > 0 && <span className="ml-2 text-slate-500">未納入 {excludedCount} 筆</span>}
          {summary.manualCloseCount > 0 && (
            <span className="ml-2 text-amber-700">人工結案 {summary.manualCloseCount} 筆</span>
          )}
        </div>
        <span className="text-slate-500">
          {isV2 ? 'v2：人工結案以實際已出庫量認列' : '歷史 v1：人工結案整筆排除'}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 sm:grid-cols-4 xl:grid-cols-8">
        {[
          ['訂單總量（MRP認列）', orderSummaryValue(summary.recognizedOrderQty)],
          ['訂單未結（MRP認列）', orderSummaryValue(summary.outstandingOrderQty)],
          ['預示抵扣基礎', orderSummaryValue(summary.demandResolvedQty)],
          ['結案未履行', orderSummaryValue(summary.closedUnfulfilledQty, summary.unknownClosedUnfulfilledCount)],
          ['原始訂單', orderSummaryValue(summary.rawOrderQty)],
          ['實際已備貨', orderSummaryValue(summary.preparedQty, summary.unknownPreparedCount)],
          ['實際已出庫', orderSummaryValue(summary.shippedQty, summary.unknownShippedCount)],
          ['已備未出庫', orderSummaryValue(summary.preparedNotShippedQty, summary.unknownPreparedNotShippedCount)],
        ].map(([label, value]) => (
          <div key={String(label)} className="min-w-0 px-3 py-2">
            <div className="truncate text-[10px] font-medium text-slate-500" title={String(label)}>{label}</div>
            <div className="mt-0.5">{value}</div>
          </div>
        ))}
      </div>
      {(summary.anomalyCount > 0 || summary.unknownShippedCount > 0) && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          {summary.anomalyCount > 0 && `資料異常 ${summary.anomalyCount} 筆。`}
          {summary.unknownShippedCount > 0 && ` 實際已出庫未知 ${summary.unknownShippedCount} 筆；MRP 不會用未知值假設已出庫。`}
        </div>
      )}
    </div>
  );
}

export function FgMonthlySourcePanel({
  partVersion,
  runId,
  dbSource,
  aggregatedMembers,
}: {
  partVersion: string;
  runId: number | null;
  dbSource?: string;
  aggregatedMembers?: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<SourceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SourceKey>('orders');
  const aggregatedMemberKey = [...new Set(
    (aggregatedMembers ?? []).map((value) => value.trim()).filter(Boolean),
  )].join('\u0000');

  useEffect(() => {
    if (!expanded || data || !runId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchFgMonthlySourcesByIdentity<SourceData>({
      partVersion,
      mrpRunId: runId,
      dbSource,
      aggregatedMembers: aggregatedMemberKey ? aggregatedMemberKey.split('\u0000') : undefined,
    }, { signal: controller.signal })
      .then((json) => setData(json))
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [expanded, data, partVersion, runId, dbSource, aggregatedMemberKey]);

  // partVersion 換掉時清資料、重 fetch
  useEffect(() => {
    setData(null);
    setExpanded(false);
    setLoading(false);
    setError(null);
  }, [partVersion, runId, dbSource, aggregatedMemberKey]);

  const trackedProductionPlanIds = data?.productionPlans
    .map((row) => Number(row.workOrderTransferId))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b) ?? [];
  const trackedProductionPlanKey = trackedProductionPlanIds.join(',');

  useEffect(() => {
    if (!expanded || !trackedProductionPlanKey) return;
    const update = (event: WorkOrderStatusEvent) => {
      setData((current) => {
        if (!current) return current;
        let changed = false;
        const productionPlans = current.productionPlans.map((row) => {
          if (Number(row.workOrderTransferId) !== event.transferId) return row;
          changed = true;
          return {
            ...row,
            generationStatus: event.workOrderStatus,
            generationError: event.workOrderError,
            generationStartedAt: event.workOrderStartedAt,
            generationCompletedAt: event.workOrderCompletedAt,
          };
        });
        return changed ? { ...current, productionPlans } : current;
      });
    };
    const subscriptions = trackedProductionPlanKey
      .split(',')
      .map(Number)
      .map((transferId) => subscribeWorkOrderStatus(transferId, update));
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [expanded, trackedProductionPlanKey]);

  const counts = data
    ? TABS.map((t) => `${t.label}(${data[t.key]?.length ?? 0})`).join(' / ')
    : '';

  const activeTabConfig = TABS.find((t) => t.key === activeTab)!;
  const activeRows = data?.[activeTab] ?? [];
  const activeCols = COLS[activeTab];

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 text-sm font-semibold text-slate-700 text-left flex items-center gap-2"
      >
        <span className={`transition-transform inline-block ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span>Source 來源資料</span>
        {counts && <span className="text-xs font-normal text-slate-500 ml-auto truncate">{counts}</span>}
      </button>

      {expanded && (
        <div className="p-3">
          {loading && (
            <div className="text-sm text-slate-400 py-4 text-center">載入中...</div>
          )}
          {error && (
            <div className="text-sm text-red-600 py-4">載入失敗：{error}</div>
          )}
          {data && !loading && (
            <>
              <div className="flex flex-wrap gap-0.5 border-b border-slate-200 mb-3">
                {TABS.map((t) => {
                  const count = data[t.key]?.length ?? 0;
                  const active = activeTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setActiveTab(t.key)}
                      className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        active
                          ? 'border-blue-500 text-blue-700'
                          : 'border-transparent text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {t.label} <span className="text-slate-400">({count})</span>
                    </button>
                  );
                })}
              </div>

              {activeTab === 'productionPlans' && (
                <div className="mb-3 border-l-2 border-blue-400 bg-blue-50 px-3 py-2 text-xs leading-5 text-slate-700">
                  <strong>計畫量</strong>會依預計完成日納入 MRP 供給；<strong>累計報工</strong>與<strong>累計結案入庫</strong>只顯示執行進度，不會再次加進剩餘庫存。工令產生進度只追蹤由本 App 建立的生產計畫。
                </div>
              )}

              {activeTab === 'orders' && <OrderDemandSummaryBlock data={data} />}

              {activeRows.length === 0 ? (
                <div className="text-xs text-slate-400 py-3 text-center">無 {activeTabConfig.label} 資料</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-300 bg-slate-50 text-slate-600">
                        {activeCols.map((c) => (
                          <th key={c.key} className={`px-2 py-1.5 font-semibold whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                            {c.label}
                          </th>
                        ))}
                        <th className="px-2 py-1.5 w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {activeRows.map((row, idx) => {
                        const masterUrl = buildMasterUrl(activeTab, row);
                        return (
                          <tr
                            key={(row.id as number) ?? idx}
                            onClick={masterUrl ? () => window.open(masterUrl, '_blank', 'noopener,noreferrer') : undefined}
                            title={masterUrl ? `在 Source 開啟 ${SOURCE_LINK[activeTab].label}` : undefined}
                            className={`border-b border-slate-100 ${
                              masterUrl ? 'cursor-pointer hover:bg-blue-50' : 'hover:bg-slate-50'
                            }`}
                          >
                            {activeCols.map((c) => (
                              <td
                                key={c.key}
                                title={c.key === 'generationStatus' && row.generationError
                                  ? String(row.generationError)
                                  : undefined}
                                className={`px-2 py-1 whitespace-nowrap ${c.mono ? 'font-mono' : ''} ${c.align === 'right' ? 'text-right' : ''}`}
                              >
                                {formatCell(nestedValue(row, c.key), c.type)}
                              </td>
                            ))}
                            <td className="px-1 py-1 text-center">
                              {masterUrl && <span className="text-blue-500">↗</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
