'use client';

import { useState } from 'react';
import {
  ISSUED_QTY_ERROR_LABELS,
  type IssuedQtyError,
} from '@/lib/mrp/work-order-bom-usage';

/**
 * Read-only renderer for a finished run's saved step status.
 *
 * The same data that powers the live `RunProgressPanel` is persisted in
 * `mrp_run.stepStatus` JSONB, so this component just renders a frozen snapshot
 * of the per-step counts/timings without any polling or controls.
 */

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface StepProgress {
  status: string;
  label: string;
  expected?: number;
  fetched?: number;
  inserted?: number;
  elapsed?: number;
  error?: string;
  warningCount?: number;
  warningMessage?: string;
  warningItems?: RunUsageWarningItem[];
  detailTiming?: Record<string, number>;
}

export interface RunUsageWarningItem {
  sourceRecordId: string | null;
  woNumber: string | null;
  componentNo: string | null;
  plannedUsage: number;
  unit: string | null;
  sourceType: string | null;
  processCode: string | null;
  level?: 'blocking' | 'review';
  reason: string | null;
}

interface CalcStepProgress {
  status?: string;
  partsProcessed?: number;
  totalParts?: number;
  materialsProcessed?: number;
  totalMaterials?: number;
}

interface StepStatus {
  [k: string]: StepProgress | CalcStepProgress | unknown;
  _phase?: string;
  _meta?: { expected?: number };
  _calcProgress?: CalcStepProgress;
  _componentProgress_W?: CalcStepProgress;
  _componentProgress_B?: CalcStepProgress;
  _componentProgress_D?: CalcStepProgress;
  _salesMeetingProgress?: CalcStepProgress;
  _componentCounts?: Record<string, number>;
  _salesMeetingCount?: number;
}

const SYNC_STEP_ORDER = [
  'part_versions',
  'inventory',
  'orders',
  'forecasts',
  'work_orders',
  'work_order_bom',
  'production_plans',
  'purchase_orders',
];

const STEP_LABELS: Record<string, string> = {
  part_versions: '客戶料號版本',
  inventory: '料號庫存',
  orders: '訂單明細',
  forecasts: '預示量',
  work_orders: '工令單',
  work_order_bom: '工令單BOM',
  production_plans: '生產計畫',
  purchase_orders: '採購單明細',
};

const WORK_ORDER_BOM_DETAIL_TIMING_LABELS = [
  ['work_order_bom_bom_snapshot_fetch', 'BOM snapshot API'],
  ['work_order_bom_bom_snapshot_insert', 'BOM snapshot 寫入'],
  ['work_order_bom_movement_snapshot_fetch', 'movement snapshot API'],
  ['work_order_bom_ledger_resolve', '領退料帳本'],
  ['work_order_bom_movement_insert', '領退料明細寫入'],
  ['work_order_bom_summary_update', 'BOM 摘要更新'],
] as const;

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  fetching: '↓',
  inserting: '⏳',
  done: '✓',
  error: '✗',
  skipped: '—',
};

export function RunStepDetail({
  stepStatus,
  syncCounts,
  errorMessage,
  runId,
  logs,
}: {
  stepStatus: StepStatus | null | undefined;
  syncCounts?: Record<string, number> | null;
  errorMessage?: string | null;
  /** Run ID for lazy-fetching logs when the user clicks 顯示詳細日誌. */
  runId?: number;
  /** Pre-loaded logs (e.g. from live polling). If provided, no fetch is made. */
  logs?: LogEntry[] | null;
}) {
  const steps = stepStatus || {};
  const totalExpected = (steps._meta as StepProgress | undefined)?.expected || 0;

  const totalFetched = SYNC_STEP_ORDER.reduce((sum, key) => {
    const s = steps[key] as StepProgress | undefined;
    return sum + (s?.fetched || 0);
  }, 0);
  const doneCount = SYNC_STEP_ORDER.reduce((acc, key) => {
    const s = steps[key] as StepProgress | undefined;
    return acc + (s?.status === 'done' ? 1 : 0);
  }, 0);
  const workOrderBomStep = steps.work_order_bom as StepProgress | undefined;
  const inventoryReconcileStep = steps._inventoryReconcile as StepProgress | undefined;
  const workOrderBomDetailTimings = WORK_ORDER_BOM_DETAIL_TIMING_LABELS.flatMap(([key, label]) => {
    const elapsed = workOrderBomStep?.detailTiming?.[key];
    return typeof elapsed === 'number' ? [{ key, label, elapsed }] : [];
  });

  return (
    <div className="bg-slate-50 border border-slate-200 rounded p-3 space-y-3">
      {/* Sync steps */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
            同步進度 ({doneCount}/{SYNC_STEP_ORDER.length})
          </div>
          <div className="text-[10px] text-slate-400 tabular-nums">
            {totalFetched > 0 && (
              <>
                {totalFetched.toLocaleString()} 筆
                {totalExpected > 0 && (
                  <span className="text-slate-300"> / ~{totalExpected.toLocaleString()} 預期</span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="space-y-0.5">
          {SYNC_STEP_ORDER.map((key) => {
            const step = steps[key] as StepProgress | undefined;
            const fallbackFetched = syncCounts?.[key];
            return (
              <SavedStepRow
                key={key}
                label={step?.label || STEP_LABELS[key] || key}
                status={step?.status || (fallbackFetched != null ? 'done' : 'pending')}
                fetched={step?.fetched ?? fallbackFetched}
                expected={step?.expected}
                elapsed={step?.elapsed}
                error={step?.error}
                warningCount={step?.warningCount}
              />
            );
          })}
          {inventoryReconcileStep && (
            <SavedStepRow
              label={inventoryReconcileStep.label}
              status={inventoryReconcileStep.status}
              fetched={inventoryReconcileStep.inserted}
              elapsed={inventoryReconcileStep.elapsed}
              error={inventoryReconcileStep.error}
            />
          )}
        </div>
        {workOrderBomDetailTimings.length > 0 && (
          <div className="ml-6 mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-slate-400 sm:grid-cols-3">
            {workOrderBomDetailTimings.map(({ key, label, elapsed }) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <span>{label}</span>
                <span className="font-mono tabular-nums text-slate-500">{(elapsed / 1000).toFixed(2)}s</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <RunUsageWarningPanel
        warningCount={workOrderBomStep?.warningCount}
        warningMessage={workOrderBomStep?.warningMessage}
        warningItems={workOrderBomStep?.warningItems}
      />

      {/* Calc steps */}
      <div className="border-t border-slate-200 pt-2">
        <div className="text-[10px] font-medium text-slate-500 mb-1.5 uppercase tracking-wider">計算</div>
        <div className="space-y-0.5">
          <SavedCalcRow
            label="成品月推移 (FG Monthly)"
            data={steps._calcProgress as CalcStepProgress | undefined}
            countField="partsProcessed"
            unitLabel="品項"
          />
          <SavedCalcRow
            label="元件週推移 W線材"
            data={steps._componentProgress_W as CalcStepProgress | undefined}
            countField="materialsProcessed"
            unitLabel="料件"
            doneCount={steps._componentCounts?.W}
          />
          <SavedCalcRow
            label="元件週推移 B外購"
            data={steps._componentProgress_B as CalcStepProgress | undefined}
            countField="materialsProcessed"
            unitLabel="料件"
            doneCount={steps._componentCounts?.B}
          />
          <SavedCalcRow
            label="元件週推移 D內製組合"
            data={steps._componentProgress_D as CalcStepProgress | undefined}
            countField="materialsProcessed"
            unitLabel="料件"
            doneCount={steps._componentCounts?.D}
          />
          <SavedCalcRow
            label="產銷會議(週推移)"
            data={steps._salesMeetingProgress as CalcStepProgress | undefined}
            countField="partsProcessed"
            unitLabel="品項"
            doneCount={steps._salesMeetingCount}
          />
        </div>
      </div>

      {errorMessage && (
        <div className="border-t border-red-100 pt-2">
          <div className="text-[10px] font-medium text-red-500 mb-1 uppercase tracking-wider">錯誤</div>
          <div className="text-xs text-red-600 bg-red-50 rounded p-2 font-mono break-all">
            {errorMessage}
          </div>
        </div>
      )}

      <RunLogViewer runId={runId} logs={logs} />
    </div>
  );
}

function SavedStepRow({
  label,
  status,
  fetched,
  expected,
  elapsed,
  error,
  warningCount,
}: {
  label: string;
  status: string;
  fetched?: number;
  expected?: number;
  elapsed?: number;
  error?: string;
  warningCount?: number;
}) {
  const icon = STEP_ICONS[status] || '○';
  const iconColor =
    status === 'done' ? 'text-green-600'
    : status === 'error' ? 'text-red-600'
    : status === 'skipped' ? 'text-slate-300'
    : 'text-slate-300';
  const textColor =
    status === 'done' ? 'text-slate-700'
    : status === 'error' ? 'text-red-600'
    : status === 'skipped' ? 'text-slate-400 italic'
    : 'text-slate-400';

  let statusText: React.ReactNode = null;
  if (status === 'done' && fetched != null) {
    statusText = (
      <>
        {fetched.toLocaleString()} 筆
        {!!warningCount && (
          <span className="text-amber-700 ml-1.5">{warningCount.toLocaleString()} 筆異常</span>
        )}
        {elapsed != null && (
          <span className="text-slate-300 ml-1">({(elapsed / 1000).toFixed(1)}s)</span>
        )}
      </>
    );
  } else if (status === 'error') {
    statusText = <span className="text-red-500">{error || '失敗'}</span>;
  } else if (status === 'pending' && expected) {
    statusText = <span className="text-slate-300">~{expected.toLocaleString()}</span>;
  } else if (status === 'skipped') {
    statusText = '已略過';
  }

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className={`text-[10px] w-4 text-center ${iconColor}`}>{icon}</span>
      <span className={`flex-1 ${textColor}`}>{label}</span>
      <span className="text-[10px] text-slate-400 tabular-nums min-w-[140px] text-right">{statusText}</span>
    </div>
  );
}

export function RunUsageWarningPanel({
  warningCount,
  warningMessage,
  warningItems,
}: {
  warningCount?: number;
  warningMessage?: string;
  warningItems?: RunUsageWarningItem[];
}) {
  const [open, setOpen] = useState(false);
  if (!warningCount) return null;

  const items = warningItems || [];
  return (
    <div data-run-usage-warning className="border-t border-amber-200 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-amber-50 px-2.5 py-2 text-xs text-amber-950">
        <span className="font-medium">
          {warningMessage || `${warningCount.toLocaleString()} 筆工令用料無法確認剩餘用量，未納入需求計算。`}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="font-medium underline decoration-dotted underline-offset-2 hover:text-amber-700"
          >
            {open ? '隱藏明細' : `查看明細 (${items.length})`}
          </button>
        )}
      </div>
      {open && items.length > 0 && (
        <div className="mt-1.5 max-h-52 overflow-auto border border-amber-200 rounded bg-white">
          <table className="w-full text-[11px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-amber-100 text-amber-950">
              <tr>
                <th className="px-2 py-1.5 text-left border-b border-amber-200">工令單</th>
                <th className="px-2 py-1.5 text-left border-b border-amber-200">元件料號</th>
                <th className="px-2 py-1.5 text-right border-b border-amber-200">原工令用量</th>
                <th className="px-2 py-1.5 text-left border-b border-amber-200">原因</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.sourceRecordId || index} className="odd:bg-white even:bg-amber-50/40">
                  <td className="px-2 py-1.5 border-b border-amber-100 font-mono whitespace-nowrap">{item.woNumber || '—'}</td>
                  <td className="px-2 py-1.5 border-b border-amber-100 font-mono whitespace-nowrap">{item.componentNo || '—'}</td>
                  <td className="px-2 py-1.5 border-b border-amber-100 text-right tabular-nums whitespace-nowrap">
                    {Number(item.plannedUsage).toLocaleString()} {item.unit || ''}
                  </td>
                  <td className="px-2 py-1.5 border-b border-amber-100">{runUsageWarningLabel(item.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {warningCount > items.length && (
            <div className="px-2 py-1.5 text-[10px] text-amber-800">
              僅顯示前 {items.length} 筆，共 {warningCount.toLocaleString()} 筆。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function runUsageWarningLabel(reason: string | null): string {
  if (reason && reason in ISSUED_QTY_ERROR_LABELS) {
    return ISSUED_QTY_ERROR_LABELS[reason as IssuedQtyError];
  }
  return reason || '無法確認領料資料';
}

function SavedCalcRow({
  label,
  data,
  countField,
  unitLabel,
  doneCount,
}: {
  label: string;
  data: CalcStepProgress | undefined;
  countField: 'partsProcessed' | 'materialsProcessed';
  unitLabel: string;
  doneCount?: number;
}) {
  const isDone = data?.status === 'done' || doneCount != null;
  const count = doneCount ?? data?.[countField];
  const total = countField === 'partsProcessed' ? data?.totalParts : data?.totalMaterials;

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className={`text-[10px] w-4 text-center ${isDone ? 'text-green-600' : 'text-slate-300'}`}>
        {isDone ? '✓' : '○'}
      </span>
      <span className={`flex-1 ${isDone ? 'text-slate-700' : 'text-slate-400'}`}>{label}</span>
      <span className="text-[10px] text-slate-400 tabular-nums min-w-[140px] text-right">
        {count != null ? (
          <>
            {Number(count).toLocaleString()}
            {total ? ` / ${Number(total).toLocaleString()}` : ''} {unitLabel}
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Toggleable detail-log viewer.
 *
 * - If `logs` is provided (live polling case), renders them directly.
 * - Otherwise lazy-fetches from /api/runs/:id when the user clicks the button,
 *   so dashboard rows don't pay the bandwidth cost up front.
 */
export function RunLogViewer({
  runId,
  logs,
}: {
  runId?: number;
  logs?: LogEntry[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<LogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const display = logs ?? fetched;

  const handleClick = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (logs == null && fetched == null && runId != null) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const raw = json.run?.logs;
        setFetched(Array.isArray(raw) ? (raw as LogEntry[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  if (runId == null && (logs == null || logs.length === 0)) return null;

  return (
    <div className="border-t border-slate-200 pt-2">
      <button
        type="button"
        onClick={handleClick}
        className="text-[11px] text-slate-600 hover:text-slate-900 underline decoration-dotted"
      >
        {open ? '▾ 隱藏詳細日誌' : '▸ 顯示詳細日誌'}
        {display != null && display.length > 0 && (
          <span className="ml-1 text-slate-400 tabular-nums">({display.length})</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5">
          {loading && <div className="text-[11px] text-slate-400 italic">載入中…</div>}
          {error && <div className="text-[11px] text-red-500">無法載入日誌: {error}</div>}
          {display != null && display.length === 0 && !loading && (
            <div className="text-[11px] text-slate-400 italic">(無日誌)</div>
          )}
          {display != null && display.length > 0 && (
            <pre className="text-[10px] font-mono leading-relaxed bg-slate-900 text-slate-100 rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap break-all">
              {display.map((entry, i) => {
                const ts = new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false });
                const color =
                  entry.level === 'error' ? 'text-red-300'
                  : entry.level === 'warn' ? 'text-amber-300'
                  : 'text-slate-100';
                return (
                  <div key={i} className={color}>
                    <span className="text-slate-500">{ts}</span>{' '}
                    <span className="uppercase text-[9px] mr-1">{entry.level}</span>
                    {entry.msg}
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
