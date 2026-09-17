'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { FullLoader, Loader } from '@/components/ui/loader';
import { RunProgressPanel } from './run-progress';
import { RunStepDetail } from './run-step-detail';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { formatDurationMs, formatDurationSec, formatRunPhaseTiming } from '@/lib/run-duration';
import { formatSourcePreflightError } from '@/lib/source-health-client';
import { useRunDetailCache } from './use-run-detail-cache';
import { MRP_RETENTION_UPDATED_EVENT } from '@/lib/mrp-retention-client';
import { SystemStatusDrawer } from './system-status-drawer';
import { maintenanceIssueCount } from '@/lib/maintenance-indicator';

const DB_MODE_LABELS: Record<string, { label: string; color: string }> = {
  local: { label: '本機', color: 'bg-green-100 text-green-700' },
  docker: { label: 'Docker', color: 'bg-blue-100 text-blue-700' },
  remote: { label: '遠端', color: 'bg-purple-100 text-purple-700' },
};

interface MaintenanceData {
  source: {
    ok: boolean;
    status:
      | 'healthy'
      | 'slow'
      | 'dns_error'
      | 'connect_timeout'
      | 'tls_error'
      | 'http_error'
      | 'api_error'
      | 'invalid_response'
      | 'config_error'
      | 'network_error';
    checkedAt: string;
    lastSuccessAt: string | null;
    statusCode: number | null;
    timings: {
      dnsMs: number | null;
      tcpMs: number | null;
      tlsMs: number | null;
      ttfbMs: number | null;
      downloadMs: number | null;
      totalMs: number;
    };
    error: string | null;
  } | null;
  backup: {
    enabled: boolean;
    ready: boolean;
    due: boolean;
    activeRun: boolean;
    intervalHours: number;
    retentionDays: number;
    minimumBackups: number;
    lastAutomaticResult: {
      outcome:
        | 'completed'
        | 'skipped-active-run'
        | 'skipped-locked'
        | 'rotation-failed'
        | 'failed';
      startedAt: string;
      completedAt: string;
      durationMs: number;
      fileName: string | null;
      sizeBytes: number | null;
    } | null;
    latestBackup: {
      completedAt: string;
      durationMs: number;
      sizeBytes: number;
    } | null;
  };
  retention: {
    enabled: boolean;
    activeRun: boolean;
    retentionDays: number;
    minimumCompletedRuns: number;
    batchSize: number;
    completedRunCount: number;
    eligibleRunCount: number;
    blockedRunCount: number;
    nextEligibleRunId: number | null;
    nextCoverageReadyRunId: number | null;
    archiveGate: {
      enabled: boolean;
      coverageReady: boolean;
      reason:
        | 'gate-disabled'
        | 'archive-not-configured'
        | 'source-database-mismatch'
        | 'archive-unreachable'
        | 'coverage-missing'
        | 'ingest-not-verified'
        | 'dump-hash-not-verified'
        | 'required-tables-not-verified'
        | 'live-snapshot-mismatch'
        | null;
    };
    lastAutomaticResult: {
      outcome:
        | 'deleted'
        | 'no-candidate'
        | 'archive-blocked'
        | 'partial-archive-blocked'
        | 'partial-failure'
        | 'failed';
      candidateIds: number[];
      deletedIds: number[];
      archiveBlocks: Array<{
        allowed: false;
        runId: number;
        reason: string;
      }>;
      failureCount: number;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    } | null;
  };
}

interface DashboardData {
  dbMode?: string;
  latestRun: {
    id: number;
    versionCode: string;
    runDate: string;
    status: string;
    completedAt: string | null;
    createdBy: string;
  } | null;
  summary: {
    totalParts: number;
    shortageParts: number;
    partsWithPlans: number;
    healthPct: number;
  } | null;
  recentRuns: Array<{
    id: number;
    versionCode: string;
    status: string;
    isLatest: boolean;
    createdAt: string;
    completedAt: string | null;
    syncCounts: Record<string, number> | null;
    errorMessage: string | null;
    duration: number | null;
    stepTiming: Record<string, number> | null;
  }>;
}

export function DashboardClient() {
  const { selectedRunId, setSelectedRunId, reloadRunsList } = useMrpVersion();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [maintenance, setMaintenance] = useState<MaintenanceData | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // 執行 MRP 的「不計算成品庫存」開關 — 預設不勾(仿照 Source,照算真實庫存)
  const [applySkipFg, setApplySkipFg] = useState(false);
  // 跑成功後自動把新版本設為「使用中」，免去手動點「使用此版本」。預設打勾，存 localStorage。
  const [autoUseLatest, setAutoUseLatest] = useState(true);
  const [updatingNotice, setUpdatingNotice] = useState(false);
  const [missingTables, setMissingTables] = useState<string[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [databaseHealthChecked, setDatabaseHealthChecked] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  // 公式漂移 modal：dismiss 後記住該 run id，下次 fetchDashboard 不會重彈
  const [dismissedDivergenceRunId, setDismissedDivergenceRunId] = useState<number | null>(null);
  const {
    details,
    loadingIds,
    errors,
    loadRunDetail,
    invalidateRunDetail,
  } = useRunDetailCache();

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      const json = await res.json();
      setData(json);
      const newest = json.recentRuns?.[0];
      if (newest && ['error', 'stopped'].includes(newest.status)) {
        void loadRunDetail(newest.id);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loadRunDetail]);

  const fetchMaintenance = useCallback(async () => {
    try {
      const res = await fetch('/api/maintenance-status');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '讀取資料維護狀態失敗');
      setMaintenance(json);
      setMaintenanceError(null);
    } catch (error) {
      setMaintenanceError(
        error instanceof Error ? error.message : '讀取資料維護狀態失敗',
      );
    } finally {
      setMaintenanceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (localStorage.getItem('mrp_autoUseLatest') === 'false') setAutoUseLatest(false);
    if (localStorage.getItem('mrp_applySkipFg') === 'true') setApplySkipFg(true);
  }, []);

  useEffect(() => {
    fetchDashboard();
    void fetchMaintenance();
    const fastMaintenanceRefresh = window.setTimeout(() => {
      void fetchMaintenance();
    }, 2_000);
    const timeoutMaintenanceRefresh = window.setTimeout(() => {
      void fetchMaintenance();
    }, 11_000);
    // DB health check
    fetch('/api/db-health')
      .then((r) => r.json())
      .then((h) => {
        setMissingTables(Array.isArray(h.missing) ? h.missing : []);
        setHealthError(typeof h.error === 'string' ? h.error : null);
      })
      .catch(() => setHealthError('無法取得資料庫結構檢查結果'))
      .finally(() => setDatabaseHealthChecked(true));

    // Re-attach the live progress panel after a hard refresh.
    // `activeRunId` is local React state, so a browser refresh wipes it and
    // the user sees a frozen "executing" snapshot instead of the live run.
    // Asking the server for any in-flight run on mount lets us re-mount
    // <RunProgressPanel>, which then takes over with its 1s polling.
    fetch('/api/runs/active')
      .then((r) => r.json())
      .then((j) => {
        if (j?.active && typeof j.runId === 'number') {
          setActiveRunId(j.runId);
        }
      })
      .catch(() => {});
    return () => {
      window.clearTimeout(fastMaintenanceRefresh);
      window.clearTimeout(timeoutMaintenanceRefresh);
    };
  }, [fetchDashboard, fetchMaintenance]);

  useEffect(() => {
    const refreshAfterRetention = () => {
      void fetchDashboard();
      void fetchMaintenance();
    };
    window.addEventListener(MRP_RETENTION_UPDATED_EVENT, refreshAfterRetention);
    return () => {
      window.removeEventListener(
        MRP_RETENTION_UPDATED_EVENT,
        refreshAfterRetention,
      );
    };
  }, [fetchDashboard, fetchMaintenance]);

  const startRun = async () => {
    setRunError(null);
    setUpdatingNotice(false);
    setStarting(true);

    // Race the POST against /api/runs/active polling. POST has a built-in
    // 200ms server-side wait before returning the runId; meanwhile the run
    // record is created within ~10ms. Polling /active in parallel lets us
    // attach to the panel as soon as the row exists, rather than waiting
    // for the POST round-trip.
    let attached = false;
    const attach = (runId: number) => {
      if (attached) return;
      attached = true;
      setActiveRunId(runId);
      setStarting(false);
      setUpdatingNotice(false);
    };

    const pollActive = async () => {
      for (let i = 0; i < 30 && !attached; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (attached) return;
        try {
          const r = await fetch('/api/runs/active');
          const j = await r.json();
          if (j?.active && typeof j.runId === 'number') {
            attach(j.runId);
            return;
          }
        } catch {
          // ignore polling errors
        }
      }
    };
    void pollActive();

    // Retries POST /api/runs while the server is mid-deploy (HTTP 423). Server
    // sets the lock at the start of deploy.sh and clears it on exit; we just
    // wait it out so the user gets the run they asked for once the new code
    // is live, without manual retry.
    const MAX_DEPLOY_WAIT_MS = 15 * 60 * 1000;
    const deadline = Date.now() + MAX_DEPLOY_WAIT_MS;

    try {
      while (true) {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ createdBy: 'web-user', applySkipFgInventory: applySkipFg }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status !== 423) void fetchMaintenance();

        // Server is mid-deploy — show banner, sleep, retry.
        if (res.status === 423 && json?.updating) {
          if (Date.now() >= deadline) {
            setUpdatingNotice(false);
            setRunError('伺服器更新時間過長，請稍後手動重試 / Update is taking too long; please retry manually.');
            setStarting(false);
            return;
          }
          setUpdatingNotice(true);
          const wait = Math.max(1, json.retryAfterSeconds ?? 10) * 1000;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        // 409 "already in progress" carries activeRunId — attach to the running
        // run instead of leaving the user looking at an error toast with no panel.
        if (res.status === 409 && typeof json.activeRunId === 'number') {
          attach(json.activeRunId);
          return;
        }
        if (!res.ok) {
          setRunError(formatSourcePreflightError(json, '執行失敗'));
          setStarting(false);
          setUpdatingNotice(false);
          return;
        }
        const runId = json.runId || json.run?.id;
        if (runId) {
          attach(runId);
        } else {
          // Completed instantly (no runId returned). Reset the starting flag
          // and refresh the dashboard so the user sees the new "latest run".
          setStarting(false);
          setUpdatingNotice(false);
          await fetchDashboard();
        }
        return;
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : '網路錯誤');
      setStarting(false);
      setUpdatingNotice(false);
    }
  };

  const handleRunComplete = useCallback(
    (status: 'completed' | 'error' | 'stopped', runId: number) => {
      setActiveRunId(null);
      void fetchDashboard();
      void reloadRunsList();
      // 跑成功且使用者勾了「執行後自動套用」就把這個版本設為使用中（免去手動點「使用此版本」）。
      if (status === 'completed' && autoUseLatest) {
        setSelectedRunId(runId);
      }
    },
    [fetchDashboard, reloadRunsList, autoUseLatest, setSelectedRunId],
  );

  if (loading) {
    return <FullLoader label="載入儀表板" />;
  }

  const newestRun = data?.recentRuns?.[0] ?? null;
  const newestRunDetail = newestRun ? details[newestRun.id] : null;
  const databaseReady = databaseHealthChecked
    && missingTables.length === 0
    && healthError === null;
  const divergenceRun = newestRun && newestRunDetail
    ? { ...newestRun, stepStatus: newestRunDetail.stepStatus }
    : null;

  return (
    <div className="h-full overflow-auto" data-dashboard-scroll>
      <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">儀表板</h2>
          {data?.latestRun && (
            <p className="text-sm text-slate-500 mt-1 flex items-center gap-2">
              <span>
                最新版本：{data.latestRun.versionCode} —{' '}
                {new Date(data.latestRun.completedAt || data.latestRun.runDate).toLocaleString('zh-TW')}
              </span>
              {data.dbMode && DB_MODE_LABELS[data.dbMode] && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${DB_MODE_LABELS[data.dbMode].color}`}>
                  {DB_MODE_LABELS[data.dbMode].label}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 justify-end">
          <SystemStatusDrawer onRefresh={() => void fetchMaintenance()} loading={maintenanceLoading} incomplete={Boolean(maintenanceError || !maintenance?.source)}
            issueCount={maintenanceIssueCount(maintenance)}>
            {maintenanceLoading ? <p className="p-4 text-sm text-slate-500">載入維護狀態…</p> : maintenanceError ?
              <div role="status" className="p-4 text-sm text-slate-500">維護資訊暫時無法讀取。<button type="button" onClick={() => void fetchMaintenance()} className="ml-2 min-h-11 px-3 text-blue-700 underline">重試</button></div> : maintenance ? <MaintenanceOverview data={maintenance} /> : null}
          </SystemStatusDrawer>
          <label
            className="flex items-center gap-1.5 text-xs text-slate-600"
            title="勾選了「不計算成品庫存」設定的料件,執行時把成品庫存當 0 算;不勾則照算真實庫存（同 Source）"
          >
            <input
              type="checkbox"
              checked={applySkipFg}
              onChange={(e) => {
                setApplySkipFg(e.target.checked);
                localStorage.setItem('mrp_applySkipFg', String(e.target.checked));
              }}
              disabled={activeRunId !== null || starting}
              className="rounded"
            />
            把「不計算成品庫存」料件當 0
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-slate-600"
            title="跑成功後自動把新版本設為「使用中」，免去手動點「使用此版本」；失敗或停止不會自動切。"
          >
            <input
              type="checkbox"
              checked={autoUseLatest}
              onChange={(e) => {
                setAutoUseLatest(e.target.checked);
                localStorage.setItem('mrp_autoUseLatest', String(e.target.checked));
              }}
              disabled={activeRunId !== null || starting}
              className="rounded"
            />
            執行後自動套用
          </label>
          <button
            onClick={startRun}
            disabled={activeRunId !== null || starting || !databaseReady}
            title={!databaseReady ? '請先完成資料庫結構更新' : undefined}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          >
            {starting
              ? '⏳ 啟動中...'
              : activeRunId !== null
                ? '⏳ 執行中...'
                : !databaseHealthChecked
                  ? '檢查資料庫...'
                  : !databaseReady
                    ? '請先更新資料庫'
                    : '▶ 執行 MRP'}
          </button>
        </div>
      </div>

      {updatingNotice && (
        <div className="bg-sky-50 border border-sky-200 text-sky-800 px-4 py-3 rounded-lg text-sm flex items-start gap-3">
          <span className="text-lg leading-none mt-0.5">🔄</span>
          <div className="space-y-0.5">
            <div className="font-semibold">
              伺服器正在更新中，新運行將自動開始⋯
            </div>
            <div className="text-xs text-sky-700">
              Server is performing an update — your run will begin automatically as soon as it&apos;s ready.
            </div>
          </div>
        </div>
      )}

      {runError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span className="whitespace-pre-line">{runError}</span>
          <button
            onClick={async () => {
              try {
                const res = await fetch('/api/runs/reset', { method: 'POST' });
                const json = await res.json();
                if (!res.ok) {
                  setRunError(json.error || '重設失敗，請重試。');
                  return;
                }
                setRunError(null);
                await fetchDashboard();
              } catch {
                setRunError('重設失敗，請重試。');
              }
            }}
            className="ml-3 px-3 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 transition-colors whitespace-nowrap"
          >
            🔄 強制重設
          </button>
        </div>
      )}

      {/* DB Schema Warning */}
      {(missingTables.length > 0 || healthError) && (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 px-4 py-3 rounded-lg text-sm">
          <div className="font-semibold mb-1">
            {healthError ? '資料庫連線異常' : '資料庫結構不完整'}
          </div>
          {healthError ? (
            <p className="text-xs">{healthError}</p>
          ) : (
            <>
              <p className="text-xs mb-2">
                以下資料表或必要欄位不存在，部分功能可能無法正常運作。請由維運人員執行版本控制內的 <code className="bg-amber-100 px-1 rounded">prisma/init.sql</code> migration 更新資料庫結構。
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missingTables.map((t) => (
                  <span key={t} className="inline-block px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[11px] font-mono">
                    {t}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Live Progress Panel */}
      {activeRunId !== null && (
        <RunProgressPanel
          runId={activeRunId}
          onComplete={handleRunComplete}
        />
      )}
      {!data?.summary && !activeRunId && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-slate-500">
          尚無 MRP 執行紀錄，請按「執行 MRP」開始。
        </div>
      )}


      {/* Recent Runs */}
      {data?.recentRuns && data.recentRuns.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-700">執行紀錄</h3>
          </div>
          <table className="w-full mrp-table border-separate border-spacing-0">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>版本</th>
                <th>狀態</th>
                <th>耗時</th>
                <th>同步筆數</th>
                <th>開始時間</th>
                <th>完成時間</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {data.recentRuns.map((run) => {
                const durationSec = run.duration;
                const syncTotal = run.syncCounts
                  ? Object.values(run.syncCounts).reduce((a, b) => a + (b || 0), 0)
                  : 0;
                const isSelected = run.id === selectedRunId;
                const isOpen = expandedRunId === run.id;
                const phaseTiming = formatRunPhaseTiming(run.stepTiming);
                return (
                  <Fragment key={run.id}>
                  <tr
                    className={`cursor-pointer ${run.status === 'error' ? 'bg-red-50/50' : isSelected ? 'bg-blue-50/60' : ''} hover:bg-slate-50`}
                    onClick={() => {
                      if (isOpen) {
                        setExpandedRunId(null);
                        return;
                      }
                      setExpandedRunId(run.id);
                      void loadRunDetail(run.id);
                    }}
                  >
                    <td className="text-center text-slate-400 select-none">
                      <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
                    </td>
                    <td className="font-mono text-xs">
                      {run.versionCode}
                      {run.isLatest && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-blue-100 text-blue-700 rounded">
                          最新
                        </span>
                      )}
                      {isSelected && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700 rounded">
                          使用中
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="text-xs text-slate-500 tabular-nums">
                      <div>{formatDurationSec(durationSec)}</div>
                      {phaseTiming && (
                        <div className="mt-0.5 whitespace-nowrap text-[10px] text-slate-400">
                          {phaseTiming}
                        </div>
                      )}
                    </td>
                    <td className="text-xs text-slate-500 tabular-nums">
                      {syncTotal > 0 ? (
                        <span title={run.syncCounts ? Object.entries(run.syncCounts).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}>
                          {syncTotal.toLocaleString()} 筆
                        </span>
                      ) : '—'}
                    </td>
                    <td className="text-xs text-slate-500">
                      {new Date(run.createdAt).toLocaleString('zh-TW')}
                    </td>
                    <td className="text-xs text-slate-500">
                      {run.completedAt
                        ? new Date(run.completedAt).toLocaleString('zh-TW')
                        : '—'}
                    </td>
                    <td className="text-center whitespace-nowrap">
                      {run.status === 'completed' && !isSelected && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedRunId(run.id); }}
                          className="text-xs px-1.5 py-0.5 text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded transition-colors"
                        >
                          使用此版本
                        </button>
                      )}
                      {(run.status === 'error' || run.status === 'stopped') && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const res = await fetch(`/api/runs/${run.id}/resume`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ createdBy: 'web-user' }),
                              });
                              const json = await res.json().catch(() => ({}));
                              if (res.status === 423 && json?.updating) {
                                alert('伺服器更新中，請稍後重試。\nServer is updating; please retry shortly.');
                                return;
                              }
                              if (res.status === 409 && typeof json.activeRunId === 'number') {
                                setActiveRunId(json.activeRunId);
                                return;
                              }
                              if (!res.ok) {
                                alert(formatSourcePreflightError(json, '繼續執行失敗 / Resume failed'));
                                return;
                              }
                              const resumedId = json.runId ?? run.id;
                              invalidateRunDetail(run.id);
                              setActiveRunId(resumedId);
                              await fetchDashboard();
                            } catch {
                              alert('網路錯誤 / Network error');
                            }
                          }}
                          className="text-xs px-1.5 py-0.5 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-100 rounded transition-colors mr-1"
                          title="從中斷處繼續 / Resume from where it stopped"
                        >
                          ▶ 繼續
                        </button>
                      )}
                      {run.status === 'error' && !run.isLatest && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`刪除執行 ${run.versionCode}？此操作無法復原。`)) return;
                            try {
                              const res = await fetch(`/api/runs/${run.id}`, { method: 'DELETE' });
                              if (res.ok) {
                                invalidateRunDetail(run.id);
                                if (expandedRunId === run.id) setExpandedRunId(null);
                                await fetchDashboard();
                              } else {
                                const json = await res.json();
                                alert(json.error || '刪除失敗');
                              }
                            } catch {
                              alert('網路錯誤');
                            }
                          }}
                          className="text-xs px-1.5 py-0.5 text-red-500 hover:text-red-700 hover:bg-red-100 rounded transition-colors"
                          title={run.errorMessage || '刪除錯誤的執行'}
                        >
                          刪除
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} className="bg-slate-50/40 p-3">
                        {loadingIds.has(run.id) ? (
                          <Loader label="載入執行明細" className="py-6" />
                        ) : details[run.id] ? (
                          <RunStepDetail
                            stepStatus={details[run.id].stepStatus as Parameters<typeof RunStepDetail>[0]['stepStatus']}
                            syncCounts={details[run.id].syncCounts ?? run.syncCounts}
                            errorMessage={details[run.id].errorMessage ?? run.errorMessage}
                            runId={run.id}
                            logs={details[run.id].logs}
                          />
                        ) : (
                          <div className="py-4 text-center text-xs text-red-500">
                            無法載入執行明細：{errors[run.id] || '未知錯誤'}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PlanQtyDivergenceModal
        run={divergenceRun}
        dismissedRunId={dismissedDivergenceRunId}
        onClose={(runId) => setDismissedDivergenceRunId(runId)}
      />
      </div>
    </div>
  );
}

// ============================================================
// Plan QTY divergence modal — verify-plan-qty halt 時跳出，列出每筆
// divergent record + Source 直達連結 + 中文操作指引。
// ============================================================
interface DivergenceMeta {
  recordId: string;
  source: number;
  ours: number;
  diff: number;
  reason?: 'fetch_failed' | 'mismatch';
  planNo?: string;
  partVersion?: string;
  sourceUrl?: string;
}

function PlanQtyDivergenceModal({
  run,
  dismissedRunId,
  onClose,
}: {
  run: { id: number; versionCode: string; status: string; stepStatus: Record<string, unknown> | null } | null;
  dismissedRunId: number | null;
  onClose: (runId: number) => void;
}) {
  if (!run || !['error', 'stopped'].includes(run.status) || dismissedRunId === run.id) return null;
  const stepStatus = run.stepStatus as Record<string, unknown> | null;
  const raw = stepStatus?._planQtyDivergences;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const divs = raw as DivergenceMeta[];
  const close = () => onClose(run.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div
        className="relative w-full max-w-2xl max-h-[85vh] bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-4">
          <h3 className="text-lg font-bold text-amber-900">⚠ Source 公式未自動重算</h3>
          <div className="text-xs text-amber-700 mt-1">MRP 已暫停，無法產生新版本</div>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-3 text-sm">
          <div className="text-slate-700">
            Source 端「生產計畫」表有{' '}
            <b className="text-amber-700">{divs.length} 筆</b>
            紀錄的 plan_qty 與我們重新計算的不一致：
          </div>

          <div className="space-y-2">
            {divs.map((d, i) => (
              <div key={`${d.recordId}-${i}`} className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                <div className="text-[11px] text-slate-500 mb-1">#{i + 1}</div>
                {d.planNo && (
                  <div className="text-xs">
                    生產計畫單號：<b className="font-mono text-slate-800">{d.planNo}</b>
                  </div>
                )}
                {d.partVersion && (
                  <div className="text-xs text-slate-600">
                    客戶料號版本：<span className="font-mono">{d.partVersion}</span>
                  </div>
                )}
                {d.reason === 'fetch_failed' ? (
                  <div className="text-xs text-red-600 mt-1">Source 端撈取失敗 (record id: {d.recordId})</div>
                ) : (
                  <div className="text-xs font-mono mt-1">
                    Source 值：<b>{Number(d.source).toLocaleString()}</b> ／ 我們算的：
                    <b>{Number(d.ours).toLocaleString()}</b>{' '}
                    <span className="text-slate-500">
                      （差 {d.diff > 0 ? '+' : ''}{d.diff}）
                    </span>
                  </div>
                )}
                {d.sourceUrl && (
                  <div className="mt-2 flex items-center gap-3">
                    <a
                      href={d.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-xs"
                    >
                      → 在 Source 開啟這筆
                    </a>
                    <button
                      onClick={() => navigator.clipboard.writeText(d.sourceUrl!)}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      複製連結
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-slate-200 pt-3 text-xs text-slate-600 space-y-1">
            <div>通常是 Source 子表單欄位 (AC11) 有變動但 G5 欄位沒被觸發重算造成的。</div>
            <div>
              ▸ <b>操作方式</b>：請 MRP 系統管理員點上方連結進到該筆 → 任意編輯一個欄位後存檔 → G5
              會自動重算 → 完成後重新執行 MRP。
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 px-5 py-3 flex items-center justify-between bg-slate-50">
          <span className="text-xs text-slate-500">版本：{run.versionCode}</span>
          <button
            onClick={close}
            className="px-4 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md"
          >
            我已通知系統管理員
          </button>
        </div>
      </div>
    </div>
  );
}



function formatMaintenanceBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MaintenanceOverview({ data }: { data: MaintenanceData }) {
  const lastBackupResult = data.backup.lastAutomaticResult;
  const backupStatus = !data.backup.enabled
    ? { label: '已停用', color: 'bg-slate-100 text-slate-600' }
    : !data.backup.ready
      ? { label: '設定異常', color: 'bg-red-100 text-red-700' }
      : lastBackupResult?.outcome === 'failed'
        ? { label: '最近備份失敗', color: 'bg-red-100 text-red-700' }
        : lastBackupResult?.outcome === 'rotation-failed'
          ? { label: '備份完成，輪替失敗', color: 'bg-red-100 text-red-700' }
          : data.backup.due
            ? { label: data.backup.activeRun ? '等待 Run 完成' : '等待備份', color: 'bg-amber-100 text-amber-700' }
            : { label: '備份正常', color: 'bg-emerald-100 text-emerald-700' };
  const retentionStatus = !data.retention.enabled
    ? { label: '尚未啟用', color: 'bg-slate-100 text-slate-600' }
    : !data.retention.archiveGate.coverageReady
      ? { label: '等待封存驗證', color: 'bg-amber-100 text-amber-700' }
      : data.retention.activeRun
        ? { label: '等待 Run 完成', color: 'bg-blue-100 text-blue-700' }
        : { label: '自動整理啟用', color: 'bg-emerald-100 text-emerald-700' };
  const sourceStatusMap: Record<NonNullable<MaintenanceData['source']>['status'], { label: string; color: string }> = {
    healthy: { label: '連線正常', color: 'bg-emerald-100 text-emerald-700' },
    slow: { label: '連線延遲', color: 'bg-amber-100 text-amber-700' },
    dns_error: { label: 'DNS 解析失敗', color: 'bg-red-100 text-red-700' },
    connect_timeout: { label: '連線逾時', color: 'bg-red-100 text-red-700' },
    tls_error: { label: 'TLS 憑證異常', color: 'bg-red-100 text-red-700' },
    http_error: { label: 'HTTP 異常', color: 'bg-red-100 text-red-700' },
    api_error: { label: 'API 拒絕', color: 'bg-red-100 text-red-700' },
    invalid_response: { label: '回應格式異常', color: 'bg-red-100 text-red-700' },
    config_error: { label: '連線設定異常', color: 'bg-red-100 text-red-700' },
    network_error: { label: '網路異常', color: 'bg-red-100 text-red-700' },
  };
  const sourceStatus = data.source
    ? sourceStatusMap[data.source.status]
    : { label: '正在檢查', color: 'bg-slate-100 text-slate-600' };
  const outcomeLabels = {
    deleted: '已完成清理',
    'no-candidate': '沒有可清理版本',
    'archive-blocked': '等待封存驗證',
    'partial-archive-blocked': '部分版本等待封存驗證',
    'partial-failure': '部分清理失敗',
    failed: '清理失敗',
  } as const;
  const archiveGateLabels = {
    'gate-disabled': '尚未啟用',
    'archive-not-configured': 'Archive 尚未設定',
    'source-database-mismatch': '目前資料庫不是封存來源',
    'archive-unreachable': 'Archive 無法連線',
    'coverage-missing': '下一版本尚未封存',
    'ingest-not-verified': '封存匯入尚未驗證',
    'dump-hash-not-verified': '來源備份尚未驗證',
    'required-tables-not-verified': '封存資料表尚未完整驗證',
    'live-snapshot-mismatch': '目前資料與封存不一致',
  } as const;
  const backupOutcomeLabels = {
    completed: '備份完成',
    'skipped-active-run': '因 Run 執行中跳過',
    'skipped-locked': '因其他備份執行中跳過',
    'rotation-failed': '備份完成但輪替失敗',
    failed: '備份失敗',
  } as const;
  const lastResult = data.retention.lastAutomaticResult;

  return (
    <section className="rounded-lg border border-slate-200 bg-white" aria-label="系統狀態">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">自動維護與連線</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Source 唯讀連線探測、自動備份與 Run 保留狀態；此處不執行資料清理。
          </p>
        </div>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          唯讀狀態
        </span>
      </div>

      <div className="space-y-3 p-4 text-xs">
        {[{ name: 'Source 連線', status: sourceStatus, at: data.source?.lastSuccessAt },
          { name: '資料庫備份', status: backupStatus, at: data.backup.latestBackup?.completedAt },
          { name: '版本清理', status: retentionStatus, at: lastResult?.completedAt }].map(item =>
          <div key={item.name} className="flex flex-wrap items-start justify-between gap-2">
            <span className="text-slate-600">{item.name}</span>
            <div className="text-right"><span className={`rounded px-2 py-0.5 ${item.status.color}`}>{item.status.label}</span>
              <div className="mt-1 text-slate-500">{item.at ? `最近紀錄 ${new Date(item.at).toLocaleString('zh-TW')}` : '尚無紀錄'}</div></div>
          </div>)}
      </div>
      <details className="border-t border-slate-100">
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-slate-600 focus-visible:outline focus-visible:outline-blue-500">技術明細</summary>
      <div className="grid grid-cols-1 divide-y divide-slate-200">
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-slate-700">Source API 連線</h4>
            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${sourceStatus.color}`}>
              {sourceStatus.label}
            </span>
          </div>
          {data.source ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-slate-500">最近檢查</dt>
            <dd className="text-right font-medium text-slate-700">
              {new Date(data.source.checkedAt).toLocaleString('zh-TW')}
            </dd>
            <dt className="text-slate-500">最近成功</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.source.lastSuccessAt
                ? new Date(data.source.lastSuccessAt).toLocaleString('zh-TW')
                : '尚無'}
            </dd>
            <dt className="text-slate-500">探測總耗時</dt>
            <dd className="text-right font-medium text-slate-700">
              {formatDurationMs(data.source.timings.totalMs)}
            </dd>
            <dt className="text-slate-500">DNS／TCP／TLS</dt>
            <dd className="text-right font-medium text-slate-700">
              {formatDurationMs(data.source.timings.dnsMs)}／
              {formatDurationMs(data.source.timings.tcpMs)}／
              {formatDurationMs(data.source.timings.tlsMs)}
            </dd>
            <dt className="text-slate-500">等待回應 TTFB</dt>
            <dd className="text-right font-medium text-slate-700">
              {formatDurationMs(data.source.timings.ttfbMs)}
            </dd>
            {data.source.error && (
              <>
                <dt className="text-red-600">錯誤</dt>
                <dd className="break-words text-right font-medium text-red-700" title={data.source.error}>
                  {data.source.error}
                </dd>
              </>
            )}
          </dl>
          ) : (
            <p className="mt-3 text-xs leading-5 text-slate-500">
              尚無持久化探測紀錄；後端已在背景檢查 Source，完成後會自動更新。
            </p>
          )}
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-slate-700">資料庫自動備份</h4>
            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${backupStatus.color}`}>
              {backupStatus.label}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-slate-500">備份週期</dt>
            <dd className="text-right font-medium text-slate-700">{data.backup.intervalHours} 小時</dd>
            <dt className="text-slate-500">保存規則</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.backup.retentionDays} 天／至少 {data.backup.minimumBackups} 份
            </dd>
            <dt className="text-slate-500">最近成功備份</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.backup.latestBackup
                ? new Date(data.backup.latestBackup.completedAt).toLocaleString('zh-TW')
                : '尚無'}
            </dd>
            <dt className="text-slate-500">最近自動執行</dt>
            <dd className="text-right font-medium text-slate-700">
              {lastBackupResult
                ? `${backupOutcomeLabels[lastBackupResult.outcome]} · ${new Date(lastBackupResult.completedAt).toLocaleString('zh-TW')}`
                : '尚無'}
            </dd>
            <dt className="text-slate-500">最近備份大小</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.backup.latestBackup
                ? formatMaintenanceBytes(data.backup.latestBackup.sizeBytes)
                : '—'}
            </dd>
          </dl>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-slate-700">MRP Run 保留</h4>
            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${retentionStatus.color}`}>
              {retentionStatus.label}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-slate-500">保留規則</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.retention.retentionDays} 天／至少 {data.retention.minimumCompletedRuns} 個完成版本
            </dd>
            <dt className="text-slate-500">符合清理條件</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.retention.eligibleRunCount} 個
              {data.retention.blockedRunCount > 0
                ? `（${data.retention.blockedRunCount} 個轉單阻擋）`
                : ''}
            </dd>
            <dt className="text-slate-500">Archive coverage</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.retention.archiveGate.coverageReady
                ? 'Coverage 已驗證；清除時再比對 live'
                : data.retention.archiveGate.reason
                  ? archiveGateLabels[data.retention.archiveGate.reason]
                  : '等待候選版本'}
            </dd>
            <dt className="text-slate-500">下一個符合條件</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.retention.nextEligibleRunId === null
                ? '—'
                : `Run #${data.retention.nextEligibleRunId}`}
            </dd>
            <dt className="text-slate-500">下一個 coverage 通過</dt>
            <dd className="text-right font-medium text-slate-700">
              {data.retention.nextCoverageReadyRunId === null
                ? '—'
                : `Run #${data.retention.nextCoverageReadyRunId}`}
            </dd>
            <dt className="text-slate-500">最近自動整理</dt>
            <dd className="text-right font-medium text-slate-700">
              {lastResult
                ? `${outcomeLabels[lastResult.outcome]} · ${new Date(lastResult.completedAt).toLocaleString('zh-TW')}`
                : '尚無'}
            </dd>
          </dl>
        </div>
      </div>
      </details>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'badge-success',
    syncing: 'badge-info',
    calculating: 'badge-info',
    pending: 'badge-neutral',
    error: 'badge-danger',
  };
  const labelMap: Record<string, string> = {
    completed: '已完成',
    syncing: '同步中',
    calculating: '計算中',
    pending: '待處理',
    error: '錯誤',
  };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{labelMap[status] || status}</span>;
}
