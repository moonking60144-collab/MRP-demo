'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RunLogViewer,
  RunUsageWarningPanel,
  type RunUsageWarningItem,
} from './run-step-detail';

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  seq?: number;
}

interface StepProgress {
  status: 'pending' | 'fetching' | 'inserting' | 'done' | 'error' | 'skipped';
  label: string;
  expected?: number;
  fetched?: number;
  inserted?: number;
  elapsed?: number;
  error?: string;
  apiStatus?: string;
  warningCount?: number;
  warningMessage?: string;
  warningItems?: RunUsageWarningItem[];
}

interface CalcStepProgress {
  status: string;
  partsProcessed?: number;
  totalParts?: number;
  materialsProcessed?: number;
  totalMaterials?: number;
}

interface RunProgress {
  runId: number;
  versionCode: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  steps: Record<string, StepProgress> & {
    _phase?: string;
    _meta?: { expected?: number };
    _calcProgress?: CalcStepProgress;
    _componentProgress_W?: CalcStepProgress;
    _componentProgress_B?: CalcStepProgress;
    _componentProgress_D?: CalcStepProgress;
    _salesMeetingProgress?: CalcStepProgress;
    _componentCounts?: Record<string, number>;
    _salesMeetingCount?: number;
  };
  syncCounts: Record<string, number>;
  errorMessage: string | null;
  logs: LogEntry[];
}

const STEP_ORDER = [
  'part_versions',
  'inventory',
  'orders',
  'forecasts',
  'work_orders',
  'work_order_bom',
  'production_plans',
  'purchase_orders',
];

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  fetching: '↓',
  inserting: '⏳',
  done: '✓',
  error: '✗',
  skipped: '—',
};

export function RunProgressPanel({
  runId,
  onComplete,
}: {
  runId: number;
  onComplete: (status: 'completed' | 'error' | 'stopped', runId: number) => void;
}) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(Date.now());
  const logCursorRef = useRef(0);
  const logsRef = useRef<LogEntry[]>([]);
  const pollingRef = useRef(false);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const res = await fetch(`/api/runs/${runId}/progress?afterLogSeq=${logCursorRef.current}`);
      if (!res.ok) return;
      const json = await res.json();
      const run = json.run;
      if (!run) return;

      const deltaLogs = Array.isArray(json.logs) ? (json.logs as LogEntry[]) : [];
      logsRef.current = json.logsReset
        ? deltaLogs
        : [...logsRef.current, ...deltaLogs];
      logCursorRef.current = Number.isInteger(json.logCursor) ? json.logCursor : logCursorRef.current;

      setProgress({
        runId: run.id,
        versionCode: run.versionCode || run.version_code,
        status: run.status,
        createdAt: run.createdAt || run.created_at,
        completedAt: run.completedAt || run.completed_at,
        steps: (run.stepStatus || run.step_status || {}) as RunProgress['steps'],
        syncCounts: (run.syncCounts || run.sync_counts || {}) as Record<string, number>,
        errorMessage: run.errorMessage || run.error_message,
        logs: logsRef.current,
      });

      if (['completed', 'error', 'stopped'].includes(run.status)) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (timerRef.current) clearInterval(timerRef.current);
        const finalStatus = run.status as 'completed' | 'error' | 'stopped';
        const finalRunId = run.id;
        setTimeout(() => onComplete(finalStatus, finalRunId), 1500);
      }
    } catch {
      // Ignore polling errors
    } finally {
      pollingRef.current = false;
    }
  }, [runId, onComplete]);

  useEffect(() => {
    startRef.current = Date.now();
    logCursorRef.current = 0;
    logsRef.current = [];
    pollingRef.current = false;
    poll();
    intervalRef.current = setInterval(poll, 1000);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 500);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  const sendSignal = async (action: 'stop' | 'pause' | 'resume') => {
    setIsSending(true);
    try {
      await fetch(`/api/runs/${runId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (action === 'pause') setIsPaused(true);
      if (action === 'resume') setIsPaused(false);
    } catch {
      // ignore
    } finally {
      setIsSending(false);
    }
  };

  /**
   * Force-abort: bypass the cooperative signal (which only fires between sync
   * steps and so won't interrupt a hung Source API call) and mark the run as
   * stopped directly in the DB. Releases the advisory lock so a new run can
   * start. The actual fetch may still finish in the background but its results
   * are discarded because the run record is no longer "active".
   */
  const forceAbort = async () => {
    if (!confirm('強制停止會直接標記此執行為錯誤並釋放鎖。卡住的 API 呼叫可能還會在背景跑完但結果會被丟棄。\n\n確定要強制停止嗎?')) return;
    setIsSending(true);
    try {
      await fetch('/api/runs/reset', { method: 'POST' });
      // Trigger the parent's onComplete so the panel closes
      onComplete('stopped', runId);
    } catch {
      // ignore
    } finally {
      setIsSending(false);
    }
  };

  if (!progress) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="animate-pulse text-slate-400 text-sm">連線中...</div>
      </div>
    );
  }

  const phase = progress.steps._phase || progress.status;
  const isCalc = phase === 'calculating' || phase.startsWith('calc_');
  const isDone = progress.status === 'completed';
  const isError = progress.status === 'error';
  const isStopped = progress.status === 'stopped';
  const isRunning = !isDone && !isError && !isStopped;
  const calcProgress = progress.steps._calcProgress;

  // Count done steps and total fetched
  const doneCount = STEP_ORDER.filter(
    (s) => progress.steps[s]?.status === 'done'
  ).length;
  const totalSteps = STEP_ORDER.length;

  // Total fetched so far (across all steps)
  const totalFetched = STEP_ORDER.reduce((sum, s) => {
    const step = progress.steps[s] as StepProgress | undefined;
    return sum + (step?.fetched || 0);
  }, 0);

  // Total expected from last run
  const totalExpected = (progress.steps._meta as StepProgress | undefined)?.expected || 0;
  const workOrderBomStep = progress.steps.work_order_bom as StepProgress | undefined;
  const inventoryReconcileStep = progress.steps._inventoryReconcile as StepProgress | undefined;

  // Calculate overall progress: sync = 0-70%, calc steps = 70-100%
  // 5 calc steps: FG Monthly, Component W, B, D, Sales Meeting (each ~6%)
  const CALC_STEPS = ['_calcProgress', '_componentProgress_W', '_componentProgress_B', '_componentProgress_D', '_salesMeetingProgress'] as const;
  const CALC_PHASE_MAP: Record<string, number> = {
    calculating: 0, calc_component_W: 1, calc_component_B: 2, calc_component_D: 3, calc_sales_meeting: 4, completed: 5,
  };
  const calcStepsDone = CALC_STEPS.filter((k) => {
    const s = progress.steps[k] as CalcStepProgress | undefined;
    return s?.status === 'done' || s?.status === 'running';
  }).length;
  const calcPhaseIdx = CALC_PHASE_MAP[phase] ?? 0;
  const calcPct = isDone ? 30 : Math.round((Math.max(calcStepsDone, calcPhaseIdx) / 5) * 30);

  const overallPct = isDone
    ? 100
    : isStopped
    ? Math.round((doneCount / totalSteps) * 70)
    : isCalc
    ? 70 + calcPct
    : Math.round((doneCount / totalSteps) * 70);

  const borderColor = isDone
    ? 'border-green-200'
    : isError
    ? 'border-red-200'
    : isStopped
    ? 'border-yellow-200'
    : isPaused
    ? 'border-amber-200'
    : 'border-blue-200';

  const headerBg = isDone
    ? 'bg-green-50'
    : isError
    ? 'bg-red-50'
    : isStopped
    ? 'bg-yellow-50'
    : isPaused
    ? 'bg-amber-50'
    : 'bg-blue-50';

  return (
    <div className={`bg-white border ${borderColor} rounded-lg shadow-sm overflow-hidden`}>
      {/* Header */}
      <div className={`px-4 py-3 ${headerBg} border-b ${borderColor} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          {isRunning && !isPaused && (
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          )}
          {isPaused && (
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          )}
          {isDone && <span className="text-green-600 font-bold">✓</span>}
          {isError && <span className="text-red-600 font-bold">✗</span>}
          {isStopped && <span className="text-yellow-600 font-bold">■</span>}
          <span className="text-sm font-semibold text-slate-700">
            MRP 執行：{progress.versionCode}
            {isPaused && <span className="text-amber-600 ml-2">（已暫停）</span>}
            {isStopped && <span className="text-yellow-600 ml-2">（已停止）</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Control buttons */}
          {isRunning && (
            <>
              {isPaused ? (
                <button
                  onClick={() => sendSignal('resume')}
                  disabled={isSending}
                  className="px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  ▶ 繼續
                </button>
              ) : (
                <button
                  onClick={() => sendSignal('pause')}
                  disabled={isSending}
                  className="px-2.5 py-1 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50 transition-colors"
                >
                  ⏸ 暫停
                </button>
              )}
              <button
                onClick={() => sendSignal('stop')}
                disabled={isSending}
                className="px-2.5 py-1 text-xs font-medium bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 transition-colors"
                title="優雅停止：在下一個步驟邊界停止 (若卡在 Source API 呼叫中可能無效)"
              >
                ■ 停止
              </button>
              <button
                onClick={forceAbort}
                disabled={isSending}
                className="px-2.5 py-1 text-xs font-medium bg-red-700 text-white rounded hover:bg-red-800 disabled:opacity-50 transition-colors"
                title="強制停止：直接標記此執行為錯誤並釋放鎖。當「停止」按鈕無效 (卡在 API 呼叫中) 時使用。"
              >
                ✕ 強制停止
              </button>
            </>
          )}
          <span className="text-xs text-slate-500 font-mono ml-1">{formatTime(elapsed)}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-100">
        <div
          className={`h-full transition-all duration-500 ease-out ${
            isError
              ? 'bg-red-500'
              : isDone
              ? 'bg-green-500'
              : isStopped
              ? 'bg-yellow-500'
              : isPaused
              ? 'bg-amber-400'
              : 'bg-blue-500'
          }`}
          style={{ width: `${overallPct}%` }}
        />
      </div>

      {/* Steps */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">
            同步進度 ({doneCount}/{totalSteps})
          </div>
          {/* Total record counter */}
          <div className="text-xs text-slate-400 tabular-nums">
            {totalFetched > 0 && (
              <>
                {totalFetched.toLocaleString()} 筆
                {totalExpected > 0 && (
                  <span className="text-slate-300"> / ~{totalExpected.toLocaleString()} 預期</span>
                )}
              </>
            )}
            {totalFetched === 0 && totalExpected > 0 && (
              <span>~{totalExpected.toLocaleString()} 筆（預期）</span>
            )}
          </div>
        </div>
        <div className="space-y-1">
          {STEP_ORDER.map((stepKey) => {
            const step = progress.steps[stepKey] as StepProgress | undefined;
            if (!step) {
              return (
                <StepRow
                  key={stepKey}
                  label={stepKey}
                  status="pending"
                />
              );
            }
            return (
              <StepRow
                key={stepKey}
                label={step.label}
                status={step.status}
                expected={step.expected}
                fetched={step.fetched}
                inserted={step.inserted}
                elapsed={step.elapsed}
                error={step.error}
                apiStatus={step.apiStatus}
                warningCount={step.warningCount}
              />
            );
          })}
          {inventoryReconcileStep && (
            <StepRow
              label={inventoryReconcileStep.label}
              status={inventoryReconcileStep.status}
              inserted={inventoryReconcileStep.inserted}
              elapsed={inventoryReconcileStep.elapsed}
              error={inventoryReconcileStep.error}
              apiStatus={inventoryReconcileStep.apiStatus}
            />
          )}
        </div>

        <RunUsageWarningPanel
          warningCount={workOrderBomStep?.warningCount}
          warningMessage={workOrderBomStep?.warningMessage}
          warningItems={workOrderBomStep?.warningItems}
        />

        {/* Calculating phase */}
        {(isCalc || isDone) && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <div className="text-xs font-medium text-slate-500 mb-1 uppercase tracking-wider">
              計算
            </div>
            <div className="space-y-1">
              <CalcStepRow
                label="成品月推移 (FG Monthly)"
                phase={phase}
                myPhase="calculating"
                progressData={calcProgress}
                countField="partsProcessed"
                totalField="totalParts"
                unitLabel="品項"
                isDone={isDone}
                doneCount={calcProgress?.status === 'done' ? calcProgress.partsProcessed : undefined}
              />
              <CalcStepRow
                label="成品月推移 (主件聚合)"
                phase={phase}
                myPhase="calc_fg_aggregated"
                progressData={calcProgress}
                countField="partsProcessed"
                totalField="totalParts"
                unitLabel="聚合群組"
                isDone={isDone}
              />
              <CalcStepRow
                label="元件週推移 W線材"
                phase={phase}
                myPhase="calc_component_W"
                progressData={progress.steps._componentProgress_W}
                countField="materialsProcessed"
                totalField="totalMaterials"
                unitLabel="料件"
                isDone={isDone}
                doneCount={progress.steps._componentCounts?.W}
              />
              <CalcStepRow
                label="元件週推移 B外購"
                phase={phase}
                myPhase="calc_component_B"
                progressData={progress.steps._componentProgress_B}
                countField="materialsProcessed"
                totalField="totalMaterials"
                unitLabel="料件"
                isDone={isDone}
                doneCount={progress.steps._componentCounts?.B}
              />
              <CalcStepRow
                label="元件週推移 D內製組合"
                phase={phase}
                myPhase="calc_component_D"
                progressData={progress.steps._componentProgress_D}
                countField="materialsProcessed"
                totalField="totalMaterials"
                unitLabel="料件"
                isDone={isDone}
                doneCount={progress.steps._componentCounts?.D}
              />
              <CalcStepRow
                label="產銷會議(週推移)"
                phase={phase}
                myPhase="calc_sales_meeting"
                progressData={progress.steps._salesMeetingProgress}
                countField="partsProcessed"
                totalField="totalParts"
                unitLabel="品項"
                isDone={isDone}
                doneCount={progress.steps._salesMeetingCount as number | undefined}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {isError && progress.errorMessage && (
          <div className="mt-3 pt-3 border-t border-red-100">
            <div className="text-xs text-red-600 bg-red-50 rounded p-2 font-mono break-all">
              {progress.errorMessage}
            </div>
          </div>
        )}

        {/* Detail logs (live during running, persisted after) — uses
            polled `progress.logs` so no extra fetch is needed. */}
        <div className="mt-3 pt-3">
          <RunLogViewer runId={progress.runId} logs={progress.logs} />
        </div>

        {/* Stopped */}
        {isStopped && (
          <div className="mt-3 pt-3 border-t border-yellow-100">
            <div className="text-sm text-yellow-700 font-medium">
              使用者已停止執行
            </div>
            {Object.keys(progress.syncCounts || {}).length > 0 && (
              <div className="text-xs text-slate-500 mt-1">
                部分同步：{Object.values(progress.syncCounts).reduce(
                  (a, b) => a + (typeof b === 'number' ? b : 0), 0
                )} 筆，來自 {doneCount} 個來源
              </div>
            )}
          </div>
        )}

        {/* Done summary */}
        {isDone && (
          <div className="mt-3 pt-3 border-t border-green-100">
            <div className="text-sm text-green-700 font-medium">
              MRP 執行完成
            </div>
            <div className="text-xs text-slate-500 mt-1">
              同步總筆數：{' '}
              {Object.values(progress.syncCounts || {}).reduce(
                (a, b) => a + (typeof b === 'number' ? b : 0), 0
              ).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({
  label,
  status,
  expected,
  fetched,
  inserted,
  elapsed,
  error,
  apiStatus,
  warningCount,
}: {
  label: string;
  status: string;
  expected?: number;
  fetched?: number;
  inserted?: number;
  elapsed?: number;
  error?: string;
  apiStatus?: string;
  warningCount?: number;
}) {
  const icon = STEP_ICONS[status] || '○';
  const isActive = status === 'fetching' || status === 'inserting';

  const statusColor =
    status === 'done'
      ? 'text-green-600'
      : status === 'error'
      ? 'text-red-600'
      : status === 'skipped'
      ? 'text-slate-300'
      : isActive
      ? 'text-blue-600'
      : 'text-slate-300';

  const textColor = isActive
    ? 'text-slate-800 font-medium'
    : status === 'done'
    ? 'text-slate-600'
    : status === 'skipped'
    ? 'text-slate-400 italic'
    : 'text-slate-400';

  // Build the right-side status text
  let statusText: React.ReactNode = null;
  if (status === 'fetching') {
    if (apiStatus && apiStatus !== '呼叫 Source API...') {
      // Show live page-by-page progress
      statusText = (
        <span className="animate-pulse">
          {fetched != null && fetched > 0
            ? `${fetched.toLocaleString()}${expected ? ` / ~${expected.toLocaleString()}` : ''} 筆`
            : apiStatus}
        </span>
      );
    } else {
      statusText = (
        <span className="animate-pulse">
          呼叫 Source API...
          {expected ? <span className="text-slate-300 ml-1">(~{expected.toLocaleString()})</span> : null}
        </span>
      );
    }
  } else if (status === 'inserting' && fetched != null) {
    statusText = <span className="animate-pulse">寫入 {fetched.toLocaleString()} 筆...</span>;
  } else if (status === 'done' && fetched != null) {
    statusText = (
      <>
        {(inserted ?? fetched).toLocaleString()} 筆
        {!!warningCount && (
          <span className="text-amber-700 ml-1.5">{warningCount.toLocaleString()} 筆異常</span>
        )}
        {elapsed != null && (
          <span className="text-slate-300 ml-1">
            ({(elapsed / 1000).toFixed(1)}s)
          </span>
        )}
      </>
    );
  } else if (status === 'pending' && expected) {
    statusText = <span className="text-slate-300">~{expected.toLocaleString()}</span>;
  } else if (status === 'skipped') {
    statusText = '已略過';
  } else if (status === 'error') {
    statusText = <span className="text-red-500">{error || '失敗'}</span>;
  }

  return (
    <div
      className={`flex items-center gap-2 py-0.5 text-sm ${
        isActive ? 'bg-blue-50/50 -mx-2 px-2 rounded' : ''
      }`}
    >
      <span className={`text-xs w-4 text-center ${statusColor} ${isActive ? 'animate-pulse' : ''}`}>
        {icon}
      </span>
      <span className={`flex-1 ${textColor}`}>{label}</span>

      <span className="text-xs text-slate-400 tabular-nums min-w-[140px] text-right">
        {statusText}
      </span>
    </div>
  );
}

// Phases in order — a step is "done" if the current phase is past it.
// IMPORTANT: every value the orchestrator writes to stepStatus._phase must appear here,
// otherwise CalcStepRow computes isFuture=true for every row and the entire 計算
// section renders empty (looks like a hang).
const PHASE_ORDER = [
  'calculating',
  'calc_fg_aggregated',
  'calc_component_W',
  'calc_component_B',
  'calc_component_D',
  'calc_sales_meeting',
  'completed',
];

function CalcStepRow({
  label,
  phase,
  myPhase,
  progressData,
  countField,
  totalField,
  unitLabel,
  isDone,
  doneCount,
}: {
  label: string;
  phase: string;
  myPhase: string;
  progressData?: CalcStepProgress;
  countField: string;
  totalField: string;
  unitLabel: string;
  isDone: boolean;
  doneCount?: number;
}) {
  const myIdx = PHASE_ORDER.indexOf(myPhase);
  const curIdx = PHASE_ORDER.indexOf(phase);
  const isActive = phase === myPhase;
  const isPast = isDone || (curIdx > myIdx && myIdx >= 0);
  const isFuture = !isActive && !isPast;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pd = progressData as Record<string, any> | undefined;
  const count = pd?.[countField];
  const total = pd?.[totalField];

  let icon = '○';
  let iconColor = 'text-slate-300';
  let textColor = 'text-slate-400';

  if (isPast) {
    icon = '✓'; iconColor = 'text-green-600'; textColor = 'text-slate-600';
  } else if (isActive) {
    icon = '⏳'; iconColor = 'text-blue-600'; textColor = 'text-slate-800 font-medium';
  }

  let statusText: React.ReactNode = null;
  if (isActive && count != null && count > 0) {
    statusText = (
      <span className="animate-pulse">
        {Number(count).toLocaleString()}
        {total ? ` / ${Number(total).toLocaleString()}` : ''} {unitLabel}
      </span>
    );
  } else if (isActive) {
    statusText = <span className="animate-pulse">處理中...</span>;
  } else if (isPast && doneCount != null) {
    statusText = <span>{Number(doneCount).toLocaleString()} {unitLabel}</span>;
  }

  if (isFuture) {
    return null; // Don't show future steps yet
  }

  return (
    <div className={`flex items-center gap-2 py-0.5 text-sm ${isActive ? 'bg-blue-50/50 -mx-2 px-2 rounded' : ''}`}>
      <span className={`text-xs w-4 text-center ${iconColor} ${isActive ? 'animate-pulse' : ''}`}>
        {icon}
      </span>
      <span className={`flex-1 ${textColor}`}>{label}</span>
      <span className="text-xs text-slate-400 tabular-nums min-w-[140px] text-right">
        {statusText}
      </span>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
