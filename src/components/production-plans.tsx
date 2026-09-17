'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import {
  useColumnVisibility,
  useRunCustomerCodeColumns,
  useTableFiltering,
  useTablePresets,
  useTableSorting,
} from './data-table/hooks';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheGet, cacheSet, cacheIsFresh } from '@/lib/swr-cache';

const ppKey = (runId: number | null) => (runId != null ? `/api/production-plans?runId=${runId}` : null);
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { PRODUCTION_PLAN_COLUMNS } from './data-table/column-defs/production-plan-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import { multiFieldSort } from './data-table/utils/sort-fns';
import { applyFiltersToRow } from './data-table/utils/filter-fns';
import type { TablePreset } from './data-table/types';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { useAutoTableHeight } from '@/hooks/use-auto-table-height';
import {
  ProductionPlanWorkOrderAction,
  type ProductionPlanWorkOrderUpdate,
} from './production-plan-work-order-action';
import { WORK_ORDER_STATUS, type WorkOrderStatus } from '@/lib/work-order-state';

const TABLE_ID = 'production_plans';
const SEARCHABLE_FIELDS = ['sourcePlanNo', 'partVersion', 'customerCode', 'mrpVersionCode'];

interface TransferItem {
  id: number;
  mrpRunId: number;
  mrpVersionCode: string;
  partVersion: string;
  planSequence: number;
  customerCode: string | null;
  suggestedQty: number | null;
  completionDate: string | null;
  sourceRecordId: string | null;
  sourcePlanNo: string | null;
  sourceUrl: string | null;
  transferredAt: string;
  transferredBy: string | null;
  workOrderStatus: WorkOrderStatus;
  workOrderError: string | null;
  workOrderStartedAt: string | null;
  workOrderCompletedAt: string | null;
}

export function ProductionPlansClient() {
  const { selectedRunId, isLoading: versionLoading, isLatestSelected } = useMrpVersion();
  const queryRunId = versionLoading ? null : selectedRunId;
  const activeRunIdRef = useRef(queryRunId);
  activeRunIdRef.current = queryRunId;
  const [items, setItems] = useState<TransferItem[]>(() => {
    const k = ppKey(queryRunId);
    return k ? (cachePeek<TransferItem[]>(k) ?? []) : [];
  });
  const [loading, setLoading] = useState(() => {
    const k = ppKey(queryRunId);
    return k ? cachePeek(k) === undefined : true;
  });
  const { containerRef: tableRef, maxHeight: tableMaxHeight } = useAutoTableHeight();
  const columns = useRunCustomerCodeColumns(PRODUCTION_PLAN_COLUMNS, selectedRunId);

  const handleWorkOrderChange = useCallback((id: number, update: ProductionPlanWorkOrderUpdate) => {
    setItems((current) => current.map((item) => (
      item.id === id ? { ...item, ...update } : item
    )));
  }, []);

  const sorting = useTableSorting();
  const filtering = useTableFiltering();
  const colVis = useColumnVisibility(columns);
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
      runId: selectedRunId,
      globalSearch: filtering.queryGlobalSearch,
      columnFilters: filtering.filterState.columnFilters,
    },
    optionRows: items as unknown as Record<string, unknown>[],
  });
  const cellMenu = useCellContextMenu({
    columns,
    columnFilters: filtering.filterState.columnFilters,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    sortFields: sorting.sortState.fields,
    onAddSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
  });
  const presets = useTablePresets(TABLE_ID);

  useLayoutEffect(() => {
    const key = ppKey(queryRunId);
    const cached = key ? cachePeek<TransferItem[]>(key) : undefined;
    setItems(cached ?? []);
    setLoading(!cached);
  }, [queryRunId]);

  useEffect(() => {
    if (queryRunId === null) return;
    const controller = new AbortController();
    const key = ppKey(queryRunId);
    const url = `/api/production-plans?runId=${queryRunId}`;
    if (key) {
      const cached = cacheGet<TransferItem[]>(key);
      if (cached) {
        setItems(cached);
        setLoading(false);
        if (cacheIsFresh(key)) return; // 夠新不打網路；否則靜默背景 revalidate
      } else {
        setLoading(true);
      }
    } else {
      setLoading(true);
    }
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('相關生產計畫讀取失敗');
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted || activeRunIdRef.current !== queryRunId) return;
        const t = data.transfers || [];
        setItems(t);
        if (key) cacheSet(key, t);
      })
      .catch(() => { /* Keep the empty state when the request fails. */ })
      .finally(() => { if (!controller.signal.aborted && activeRunIdRef.current === queryRunId) setLoading(false); });
    return () => controller.abort();
  }, [queryRunId]);

  const processed = useMemo(() => {
    let result = items;

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
      result = multiFieldSort(result as unknown as Record<string, unknown>[], sorting.sortState.fields) as unknown as TransferItem[];
    }

    return result;
  }, [items, filtering.filterState, sorting.sortState]);

  const workOrderSummary = useMemo(() => ({
    queued: items.filter((item) => item.workOrderStatus === WORK_ORDER_STATUS.QUEUED).length,
    running: items.filter((item) => item.workOrderStatus === WORK_ORDER_STATUS.PENDING).length,
    succeeded: items.filter((item) => item.workOrderStatus === WORK_ORDER_STATUS.SUCCEEDED).length,
    attention: items.filter((item) => (
      item.workOrderStatus === WORK_ORDER_STATUS.FAILED
      || item.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN
    )).length,
  }), [items]);

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
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">相關生產計劃</h2>
        <div className="text-sm text-slate-500">{processed.length.toLocaleString()} 筆</div>
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border-y border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
        <span className="font-semibold text-slate-700">工令背景進度</span>
        <span>排隊中 <strong className="text-indigo-700">{workOrderSummary.queued}</strong></span>
        <span>Source 執行中 <strong className="text-blue-700">{workOrderSummary.running}</strong></span>
        <span>已完成 <strong className="text-emerald-700">{workOrderSummary.succeeded}</strong></span>
        <span>需處理 <strong className="text-red-700">{workOrderSummary.attention}</strong></span>
        <span className="text-slate-400">送出後可離開頁面，系統會依序執行。</span>
      </div>

      <div>
        <TableToolbar
          tableId={TABLE_ID}
          columns={columns}
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

        <div ref={tableRef} className="bg-white border border-t-0 border-slate-200 rounded-b-lg overflow-auto" style={{ maxHeight: tableMaxHeight }}>
          <table className="w-full mrp-table" onContextMenu={cellMenu.handleContextMenu}>
            <thead>
              <tr>
                {columns.filter((column) => colVis.isVisible(column.id)).map((column) => (
                  <ColumnHeaderCell key={column.id} column={column} controller={columnHeader.menuController} />
                ))}
                <th className="text-center">工令</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colVis.visibleCount + 1}><Loader /></td>
                </tr>
              ) : processed.length === 0 ? (
                <tr>
                  <td colSpan={colVis.visibleCount + 1} className="text-center py-8 text-slate-400">
                    {items.length === 0 ? '此版本尚無轉單紀錄。' : '無符合篩選條件的結果。'}
                  </td>
                </tr>
              ) : (
                processed.map((item) => (
                  <tr key={item.id}>
                    {colVis.isVisible('sourcePlanNo') && (
                      <td data-col="sourcePlanNo" data-value={item.sourcePlanNo ?? ''} className="font-mono text-xs">
                        {item.sourceUrl ? (
                          <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline"
                          >
                            {item.sourcePlanNo || item.sourceRecordId || '—'}
                          </a>
                        ) : (
                          item.sourcePlanNo || '—'
                        )}
                      </td>
                    )}
                    {colVis.isVisible('partVersion') && (
                      <td data-col="partVersion" data-value={item.partVersion ?? ''} className="font-mono text-xs">{item.partVersion}</td>
                    )}
                    {colVis.isVisible('customerCode') && (
                      <td data-col="customerCode" data-value={item.customerCode ?? ''} className="text-xs">{item.customerCode || '—'}</td>
                    )}
                    {colVis.isVisible('planSequence') && (
                      <td data-col="planSequence" data-value={String(item.planSequence ?? '')} className="text-xs text-center">#{item.planSequence}</td>
                    )}
                    {colVis.isVisible('suggestedQty') && (
                      <td data-col="suggestedQty" data-value={String(item.suggestedQty ?? '')} className="text-xs font-mono text-right">
                        {item.suggestedQty != null ? Number(item.suggestedQty).toLocaleString() : '—'}
                      </td>
                    )}
                    {colVis.isVisible('completionDate') && (
                      <td data-col="completionDate" data-value={item.completionDate ?? ''} className="text-xs text-slate-500">
                        {item.completionDate ? new Date(item.completionDate).toLocaleDateString('zh-TW') : '—'}
                      </td>
                    )}
                    {colVis.isVisible('mrpVersionCode') && (
                      <td data-col="mrpVersionCode" data-value={item.mrpVersionCode ?? ''} className="font-mono text-xs text-slate-500">{item.mrpVersionCode}</td>
                    )}
                    {colVis.isVisible('transferredAt') && (
                      <td data-col="transferredAt" data-value={item.transferredAt ?? ''} className="text-xs text-slate-500">
                        {new Date(item.transferredAt).toLocaleString('zh-TW')}
                      </td>
                    )}
                    <td className="text-center">
                      <ProductionPlanWorkOrderAction
                        transferId={item.id}
                        sourceRecordId={item.sourceRecordId}
                        sourcePlanNo={item.sourcePlanNo}
                        sourceUrl={item.sourceUrl}
                        initialStatus={item.workOrderStatus}
                        initialError={item.workOrderError}
                        disabled={!isLatestSelected}
                        compact
                        onChange={(update) => handleWorkOrderChange(item.id, update)}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <CellContextMenu {...cellMenu.contextMenuProps} />
    </div>
  );
}
