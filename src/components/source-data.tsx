'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  useColumnVisibility,
  useRunCustomerCodeColumns,
  useTableFiltering,
  useTablePresets,
  useTableSorting,
} from './data-table/hooks';
import { Loader } from '@/components/ui/loader';
import { ListRequestError } from './ui/list-request-error';
import { cachePeek, cacheIsFresh, cacheSet } from '@/lib/swr-cache';
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
  type ColumnHeaderMenuController,
} from './data-table/ui/column-header-menu';
import { SOURCE_DATA_TABLE_CONFIG } from './data-table/column-defs/source-data-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import type { MrpColumnDef, TablePreset } from './data-table/types';
import { loadColumnFilterOptions } from './data-table/column-filter-options-client';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { useAutoTableHeight } from '@/hooks/use-auto-table-height';
import { buildSourceRecordUrl, type SourceRecordType } from '@/lib/source-record-links';
import { useReportPage } from './ui/use-report-page';

type DataTab =
  | 'part_versions'
  | 'inventory'
  | 'orders'
  | 'forecasts'
  | 'work_orders'
  | 'work_order_bom'
  | 'inventory_lots'
  | 'work_order_material_movements'
  | 'production_plans'
  | 'purchase_orders';

const TAB_CONFIG: { key: DataTab; label: string; zhLabel: string }[] = [
  { key: 'part_versions', label: 'Part Versions', zhLabel: '客戶料號版本' },
  { key: 'inventory', label: 'Inventory', zhLabel: '料號庫存' },
  { key: 'inventory_lots', label: 'Inventory Lots', zhLabel: '庫存批號' },
  { key: 'orders', label: 'Orders', zhLabel: '訂單明細' },
  { key: 'forecasts', label: 'Forecasts', zhLabel: '預示量' },
  { key: 'work_orders', label: 'Work Orders', zhLabel: '工令單' },
  { key: 'work_order_bom', label: 'WO BOM', zhLabel: '工令單BOM' },
  { key: 'work_order_material_movements', label: 'WO Movements', zhLabel: '工令領退料' },
  { key: 'production_plans', label: 'Plans', zhLabel: '生產計畫' },
  { key: 'purchase_orders', label: 'Purchase Orders', zhLabel: '採購單' },
];

export function SourceDataClient() {
  const { selectedRunId } = useMrpVersion();
  const [activeTab, setActiveTab] = useState<DataTab>('part_versions');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [anomalyOnly, setAnomalyOnly] = useState(false);
  // 初值 true（對齊其他頁）：cache hit 由下方 useLayoutEffect 在 paint 前設 false → 不閃；
  // miss 才顯 spinner，避免首幀閃「查無資料」空狀態。
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const { containerRef: tableRef, maxHeight: tableMaxHeight } = useAutoTableHeight();
  const limit = 100;

  const tabConfig = SOURCE_DATA_TABLE_CONFIG[activeTab];
  const baseColumns = useMemo(() => tabConfig?.columns || [], [tabConfig]);
  const columns = useRunCustomerCodeColumns(baseColumns, selectedRunId, undefined, true);
  const tableId = tabConfig?.tableId || `source_${activeTab}`;

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
      tableId,
      runId: selectedRunId,
      globalSearch: filtering.queryGlobalSearch,
      columnFilters: filtering.filterState.columnFilters,
      fixedScope: { anomalyOnly },
    },
    loadOptions: loadColumnFilterOptions,
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
  const presets = useTablePresets(tableId);
  const { page, setPage, queryReady } = useReportPage('mrp_page_source', JSON.stringify([
    selectedRunId,
    activeTab,
    filtering.queryGlobalSearch,
    filtering.filterQueryParams,
    sorting.sortQueryParam,
    anomalyOnly,
  ]), selectedRunId != null && filtering.hydrated && sorting.hydrated);

  // Track previous tab to reset state on tab change
  const prevTabRef = useRef(activeTab);

  // Reset state when tab changes
  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      sorting.clearSort();
      filtering.clearAllFilters();
      colVis.resetToDefault();
      setPage(1);
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 與 fetchData 共用的 cache key（= fetch URL）。
  const buildSourceKey = useCallback(() => {
    if (selectedRunId == null) return null;
    const params = new URLSearchParams({ table: activeTab, runId: String(selectedRunId), page: String(page), limit: String(limit) });
    if (filtering.queryGlobalSearch) params.set('search', filtering.queryGlobalSearch);
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (activeTab === 'work_order_bom' && anomalyOnly) params.set('anomalyOnly', 'true');
    for (const [k, v] of Object.entries(filtering.filterQueryParams)) params.set(k, v);
    return `/api/source-data?${params}`;
  }, [selectedRunId, activeTab, page, anomalyOnly, filtering.queryGlobalSearch, filtering.filterQueryParams, sorting.sortQueryParam]);

  // 切頁/換 tab 回來時在 paint 前先鋪上快取 → 零 spinner
  useLayoutEffect(() => {
    if (!queryReady) return;
    fetchAbortRef.current?.abort();
    setListError(null);
    const key = buildSourceKey();
    const cached = key ? cachePeek<{ items: unknown[]; total: number }>(key) : undefined;
    if (cached) { setData(cached.items); setTotal(cached.total); setLoading(false); }
    else { setData([]); setTotal(0); setLoading(true); }
  }, [buildSourceKey, queryReady]);

  // Fetch data when run, tab, search, page, sort, or filters change
  const fetchData = useCallback(async () => {
    if (!queryReady) return;
    fetchAbortRef.current?.abort();
    const ac = new AbortController();
    fetchAbortRef.current = ac;
    setListError(null);
    const key = buildSourceKey();
    if (!key) return;
    const cached = cachePeek<{ items: unknown[]; total: number }>(key);
    if (cached) {
      setData(cached.items);
      setTotal(cached.total);
      setLoading(false);
      if (cacheIsFresh(key)) return; // 夠新不打網路；否則靜默背景 revalidate
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(key, { signal: ac.signal });
      const json = await res.json();
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      if (!res.ok) throw new Error(json.error || `原始資料讀取失敗 (${res.status})`);
      setData(json.items || []);
      setTotal(json.total || 0);
      cacheSet(key, { items: json.items || [], total: json.total || 0 });
    } catch (error) {
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      setListError(error instanceof Error ? error.message : '原始資料讀取失敗');
    } finally {
      if (!ac.signal.aborted && fetchAbortRef.current === ac) setLoading(false);
    }
  }, [buildSourceKey, queryReady]);

  useEffect(() => {
    fetchData();
    return () => fetchAbortRef.current?.abort();
  }, [fetchData]);

  const totalPages = Math.ceil(total / limit);

  const handleLoadPreset = useCallback((preset: TablePreset) => {
    presets.loadPreset(preset);
  }, [presets]);

  const handleSavePreset = useCallback((name: string, isDefault: boolean) => {
    presets.savePreset({
      tableId,
      presetName: name,
      isDefault,
      sorting: sorting.sortState,
      filtering: filtering.filterState,
      columnVisibility: colVis.visibility,
    });
  }, [presets, tableId, sorting.sortState, filtering.filterState, colVis.visibility]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">原始資料</h2>
        <div className="text-sm text-slate-500">{total.toLocaleString()} 筆</div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <div className="flex gap-0 -mb-px overflow-x-auto">
          {TAB_CONFIG.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {tab.zhLabel}
              <span className="text-xs text-slate-400 ml-1">({tab.label})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div>
        <TableToolbar
          tableId={tableId}
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
          loadFilterOptions={columnHeader.menuController.loadOptions}
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
          extraControls={activeTab === 'work_order_bom' ? (
            <button
              type="button"
              onClick={() => setAnomalyOnly((value) => !value)}
              className={`rounded border px-2 py-1 text-xs transition-colors ${
                anomalyOnly
                  ? 'border-red-300 bg-red-100 font-medium text-red-700'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-red-300 hover:text-red-700'
              }`}
            >
              只看領退料異常
            </button>
          ) : undefined}
        />
        <ColumnHeaderMenu controller={columnHeader.menuController} />

        {listError && <ListRequestError message={listError} onRetry={fetchData} />}

        {/* Data Table */}
        <div ref={tableRef} className="bg-white border border-t-0 border-slate-200 rounded-b-lg overflow-auto" style={{ maxHeight: tableMaxHeight }}>
          {loading ? (
            <Loader />
          ) : listError && data.length === 0 ? null : data.length === 0 ? (
            <div className="text-center py-12 text-slate-400">查無資料。</div>
          ) : (
            <GenericTable
              tab={activeTab}
              columns={columns}
              data={data}
              visibility={colVis.visibility}
              onContextMenu={cellMenu.handleContextMenu}
              columnHeaderController={columnHeader.menuController}
            />
          )}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            上一頁
          </button>
          <span className="text-sm text-slate-500">
            第 {page} 頁，共 {totalPages} 頁
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            下一頁
          </button>
        </div>
      )}
      <CellContextMenu {...cellMenu.contextMenuProps} />
    </div>
  );
}

function fmtDate(val: string | null | undefined): string {
  if (!val) return '\u2014';
  try {
    return new Date(val).toLocaleDateString('zh-TW');
  } catch {
    return val;
  }
}

function fmtNum(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return '\u2014';
  const n = Number(val);
  return isNaN(n) ? '\u2014' : n.toLocaleString();
}

function formatCellValue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: any,
  col: MrpColumnDef,
): string {
  const val = row[col.id];
  if (col.filterType === 'date') return fmtDate(val);
  if (col.filterType === 'numeric') return fmtNum(val);
  if (col.filterType === 'boolean') return val ? '是' : '\u2014';
  if (val === null || val === undefined || val === '') return '\u2014';
  return String(val);
}

function sourceRecordTypeForTab(tab: DataTab): SourceRecordType | null {
  if (tab === 'inventory') return 'inventory-master';
  if (tab === 'inventory_lots') return 'inventory-lot';
  if (tab === 'work_order_material_movements') return 'inventory-movement';
  if (tab === 'purchase_orders') return 'purchase-order';
  if (tab === 'work_orders') return 'work-order';
  if (tab === 'work_order_bom') return 'work-order-bom';
  return null;
}

function SourceRecordLink({
  type,
  recordId,
  label,
}: {
  type: SourceRecordType;
  recordId: string | null | undefined;
  label: string;
}) {
  const href = buildSourceRecordUrl(type, recordId);
  if (!href) return <span className="text-slate-400">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 whitespace-nowrap text-blue-700 hover:underline"
    >
      {label}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

function GenericTable({
  tab,
  columns,
  data,
  visibility,
  onContextMenu,
  columnHeaderController,
}: {
  tab: DataTab;
  columns: MrpColumnDef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
  visibility: Record<string, boolean>;
  onContextMenu?: (e: React.MouseEvent) => void;
  columnHeaderController: ColumnHeaderMenuController;
}) {
  const visibleCols = columns.filter((col) => visibility[col.id] !== false);

  return (
    <table className="w-full text-xs" onContextMenu={onContextMenu}>
      <thead>
        <tr className="bg-slate-50 text-slate-500 sticky top-0">
          {visibleCols.map((col) => (
            <ColumnHeaderCell
              key={col.id}
              column={col}
              controller={columnHeaderController}
              className="px-2 py-1.5"
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => {
          // Special row highlighting for forecasts with missing dates
          const rowClass = tab === 'forecasts' && !row.forecastStart
            ? 'bg-red-50'
            : row.anomalyLevel === 'blocking'
              ? 'bg-red-50'
              : row.anomalyLevel === 'review'
                ? 'bg-amber-50'
                : row.anomalyLevel === 'source'
                  ? 'bg-blue-50'
                  : '';
          return (
            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${rowClass}`}>
              {visibleCols.map((col) => {
                const isSourceId = col.id === 'sourceRecordId';
                // Special styling for forecast missing date
                const isMissingDate = tab === 'forecasts' && col.id === 'forecastStart' && !row.forecastStart;
                const cellVal = row[col.id];
                const recordType = col.id === 'sourceRecordId' ? sourceRecordTypeForTab(tab) : null;
                const workOrderRecordId = col.id === 'sourceWorkOrderNo'
                  ? row.sourceWorkOrderSourceRecordId
                  : row.workOrderSourceRecordId;
                const isWorkOrderLink = (
                  col.id === 'woNumber'
                  || col.id === 'workOrderNo'
                  || col.id === 'sourceWorkOrderNo'
                ) && workOrderRecordId;
                return (
                  <td
                    key={col.id}
                    data-col={col.id}
                    data-value={cellVal != null ? String(cellVal) : ''}
                    className={`px-2 py-1 ${
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''
                    } ${col.mono ? 'font-mono' : ''} ${
                      isSourceId ? 'text-slate-400' : ''
                    } ${isMissingDate ? 'text-red-500 font-medium' : ''}`}
                  >
                    {isMissingDate ? '缺少' : recordType ? (
                      <SourceRecordLink
                        type={recordType}
                        recordId={row.sourceRecordId}
                        label={String(row.sourceRecordId || '來源')}
                      />
                    ) : isWorkOrderLink ? (
                      <SourceRecordLink
                        type="work-order"
                        recordId={workOrderRecordId}
                        label={String(cellVal || '工令')}
                      />
                    ) : col.id === 'anomalyLevel' ? (
                      row.anomalyLevel === 'blocking'
                        ? <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">阻擋</span>
                        : row.anomalyLevel === 'review'
                          ? <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">待確認</span>
                          : row.anomalyLevel === 'source'
                            ? <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">BOM snapshot</span>
                            : <span className="text-slate-400">正常</span>
                    ) : formatCellValue(row, col)}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
