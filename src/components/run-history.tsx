'use client';

import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { useTableSorting, useTableFiltering, useColumnVisibility, useTablePresets } from './data-table/hooks';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheGet, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { RUN_HISTORY_COLUMNS } from './data-table/column-defs/run-history-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import { multiFieldSort } from './data-table/utils/sort-fns';
import { applyFiltersToRow } from './data-table/utils/filter-fns';
import type { TablePreset } from './data-table/types';
import { RunStepDetail } from './run-step-detail';
import { useRunDetailCache } from './use-run-detail-cache';
import { formatRunPhaseTiming } from '@/lib/run-duration';
import { formatRagicPreflightError } from '@/lib/ragic-health-client';

const TABLE_ID = 'run_history';
const SEARCHABLE_FIELDS = ['versionCode', 'status', 'createdBy'];

interface RunItem {
  id: number;
  versionCode: string;
  runDate: string;
  status: string;
  isLatest: boolean;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
  syncCounts: Record<string, number>;
  stepTiming: Record<string, number> | null;
  errorMessage: string | null;
  duration: number | null;
}

const DASH = '—';

export function RunHistoryClient() {
  const [runs, setRuns] = useState<RunItem[]>(() => cachePeek<RunItem[]>('/api/runs') ?? []);
  const [loading, setLoading] = useState(() => cachePeek('/api/runs') === undefined);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const {
    details,
    loadingIds,
    errors,
    loadRunDetail,
    invalidateRunDetail,
  } = useRunDetailCache();

  const sorting = useTableSorting();
  const filtering = useTableFiltering();
  const colVis = useColumnVisibility(RUN_HISTORY_COLUMNS);
  const columnHeader = useTableColumnHeaderMenu({
    columnFilters: filtering.filterState.columnFilters,
    sortFields: sorting.sortState.fields,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    onPrioritizeSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
    optionContext: {
      tableId: TABLE_ID,
      runId: null,
      globalSearch: filtering.queryGlobalSearch,
      columnFilters: filtering.filterState.columnFilters,
    },
    optionRows: runs as unknown as Record<string, unknown>[],
  });
  const cellMenu = useCellContextMenu({
    columns: RUN_HISTORY_COLUMNS,
    columnFilters: filtering.filterState.columnFilters,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    sortFields: sorting.sortState.fields,
    onAddSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
  });
  const presets = useTablePresets(TABLE_ID);

  useEffect(() => {
    const cached = cacheGet<RunItem[]>('/api/runs');
    if (cached) {
      setRuns(cached);
      setLoading(false);
      if (cacheIsFresh('/api/runs', 30_000)) return; // run 清單 30s 內視為新；SSE 跑新 run 也會主動砍
    }
    fetch('/api/runs')
      .then((res) => res.json())
      .then((data) => {
        const items = (data.runs || []) as RunItem[];
        setRuns(items);
        cacheSet('/api/runs', items);
      })
      .finally(() => setLoading(false));
  }, []);

  const processedRuns = useMemo(() => {
    let result = runs;
    if (filtering.filterState.globalSearch || filtering.filterState.columnFilters.length > 0) {
      result = result.filter((row) =>
        applyFiltersToRow(
          row as unknown as Record<string, unknown>,
          filtering.filterState.columnFilters,
          filtering.filterState.globalSearch,
          SEARCHABLE_FIELDS,
        ),
      );
    }
    if (sorting.sortState.fields.length > 0) {
      result = multiFieldSort(result as unknown as Record<string, unknown>[], sorting.sortState.fields) as unknown as RunItem[];
    }
    return result;
  }, [runs, filtering.filterState, sorting.sortState]);

  const handleLoadPreset = useCallback((preset: TablePreset) => {
    presets.loadPreset(preset);
  }, [presets]);

  const handleSavePreset = useCallback((name: string, isDefault: boolean) => {
    presets.savePreset({
      tableId: TABLE_ID,
      presetName: name,
      isDefault,
      sorting: sorting.sortState,
      filtering: filtering.filterState,
      columnVisibility: colVis.visibility,
    });
  }, [presets, sorting.sortState, filtering.filterState, colVis.visibility]);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-2xl font-bold text-slate-800">執行紀錄</h2>

      <div>
        <TableToolbar
          tableId={TABLE_ID}
          columns={RUN_HISTORY_COLUMNS}
          sortFields={sorting.sortState.fields}
          onAddSort={sorting.addSort}
          onRemoveSort={sorting.removeSort}
          onToggleSortDirection={sorting.toggleDirection}
          onReorderSort={sorting.reorderSort}
          onClearSort={sorting.clearSort}
          onResetSort={sorting.resetSort}
          onSetSort={sorting.setSort}
          globalSearch={filtering.filterState.globalSearch}
          onGlobalSearchChange={filtering.setGlobalSearch}
          columnFilters={filtering.filterState.columnFilters}
          onSetColumnFilter={filtering.setColumnFilter}
          onRemoveColumnFilter={filtering.removeColumnFilter}
          onClearAllFilters={filtering.clearAllFilters}
          filterOptionContext={columnHeader.menuController.optionContext}
          filterOptionRows={columnHeader.menuController.optionRows}
          onSetFilters={filtering.setFilters}
          visibility={colVis.visibility}
          onToggleColumn={colVis.toggleColumn}
          onShowAllColumns={colVis.showAll}
          onResetColumns={colVis.resetToDefault}
          visibleCount={colVis.visibleCount}
          totalColumnCount={colVis.totalCount}
          onSetColumnVisibility={colVis.setColumnVisibility}
          systemSorting={sorting.defaultSortState}
          systemFiltering={filtering.defaultFilterState}
          systemVisibility={colVis.defaultVisibility}
          presets={presets.presets}
          activePresetId={presets.activePresetId}
          presetsLoading={presets.loading}
          onLoadPreset={handleLoadPreset}
          onSavePreset={handleSavePreset}
          onUpdatePreset={presets.updatePreset}
          onDeletePreset={presets.deletePreset}
          onSetDefaultPreset={presets.setDefault}
          onUnsetDefaultPreset={presets.unsetDefault}
          onUseSystemDefault={presets.useSystemDefault}
          filterModalController={columnHeader.filterModalController}
        />
        <ColumnHeaderMenu controller={columnHeader.menuController} />

        <div className="bg-white border border-t-0 border-slate-200 rounded-b-lg overflow-auto">
          <table className="w-full mrp-table" onContextMenu={cellMenu.handleContextMenu}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                {RUN_HISTORY_COLUMNS.filter((column) => colVis.isVisible(column.id)).map((column) => (
                  <ColumnHeaderCell key={column.id} column={column} controller={columnHeader.menuController} />
                ))}
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colVis.visibleCount + 2}><Loader /></td>
                </tr>
              ) : processedRuns.length === 0 ? (
                <tr>
                  <td colSpan={colVis.visibleCount + 2} className="text-center py-8 text-slate-400">
                    {runs.length === 0 ? '尚無執行紀錄。' : '無符合篩選條件的結果。'}
                  </td>
                </tr>
              ) : (
                processedRuns.map((run) => {
                  const isOpen = expandedRunId === run.id;
                  const phaseTiming = formatRunPhaseTiming(run.stepTiming);
                  return (
                    <Fragment key={run.id}>
                      <tr
                        className="cursor-pointer hover:bg-slate-50"
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
                        {colVis.isVisible('versionCode') && (
                          <td data-col="versionCode" data-value={run.versionCode ?? ''} className="font-mono text-xs">
                            {run.versionCode}
                            {run.isLatest && <span className="ml-1 badge badge-info">最新</span>}
                          </td>
                        )}
                        {colVis.isVisible('status') && (
                          <td data-col="status" data-value={run.status ?? ''}><StatusBadge status={run.status} /></td>
                        )}
                        {colVis.isVisible('createdBy') && (
                          <td data-col="createdBy" data-value={run.createdBy ?? ''} className="text-xs text-slate-500">{run.createdBy || DASH}</td>
                        )}
                        {colVis.isVisible('createdAt') && (
                          <td data-col="createdAt" data-value={run.createdAt ?? ''} className="text-xs text-slate-500">
                            {new Date(run.createdAt).toLocaleString('zh-TW')}
                          </td>
                        )}
                        {colVis.isVisible('completedAt') && (
                          <td data-col="completedAt" data-value={run.completedAt ?? ''} className="text-xs text-slate-500">
                            {run.completedAt ? new Date(run.completedAt).toLocaleString('zh-TW') : DASH}
                          </td>
                        )}
                        {colVis.isVisible('duration') && (
                          <td data-col="duration" data-value={run.duration != null ? String(run.duration) : ''} className="text-xs font-mono">
                            <div>{run.duration !== null && run.duration !== undefined ? `${run.duration}s` : DASH}</div>
                            {phaseTiming && (
                              <div className="mt-0.5 whitespace-nowrap font-sans text-[10px] text-slate-400">
                                {phaseTiming}
                              </div>
                            )}
                          </td>
                        )}
                        {colVis.isVisible('syncCounts') && (
                          <td className="text-xs">
                            {run.syncCounts && typeof run.syncCounts === 'object'
                              ? Object.entries(run.syncCounts).map(([k, v]) => `${k}: ${v}`).join(', ')
                              : DASH}
                          </td>
                        )}
                        <td className="text-center whitespace-nowrap">
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
                                  if (!res.ok && res.status !== 409) {
                                    alert(formatRagicPreflightError(json, '繼續執行失敗 / Resume failed'));
                                    return;
                                  }
                                  invalidateRunDetail(run.id);
                                  if (expandedRunId === run.id) setExpandedRunId(null);
                                  // Reload list to reflect status change
                                  const r = await fetch('/api/runs');
                                  const d = await r.json();
                                  const items = (d.runs || []) as RunItem[];
                                  setRuns(items);
                                  cacheSet('/api/runs', items);
                                } catch {
                                  alert('網路錯誤 / Network error');
                                }
                              }}
                              className="text-xs px-1.5 py-0.5 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-100 rounded transition-colors"
                              title="從中斷處繼續 / Resume from where it stopped"
                            >
                              ▶ 繼續
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={colVis.visibleCount + 2} className="bg-slate-50/40 p-3">
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
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <CellContextMenu {...cellMenu.contextMenuProps} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const classMap: Record<string, string> = {
    completed: 'badge-success',
    syncing: 'badge-info',
    calculating: 'badge-info',
    synced: 'badge-info',
    pending: 'badge-neutral',
    error: 'badge-danger',
  };
  const labelMap: Record<string, string> = {
    completed: '已完成',
    syncing: '同步中',
    calculating: '計算中',
    synced: '已同步',
    pending: '待處理',
    error: '錯誤',
  };
  return <span className={`badge ${classMap[status] || 'badge-neutral'}`}>{labelMap[status] || status}</span>;
}
