'use client';

import { useState, useEffect, useLayoutEffect, useCallback, Fragment, useRef, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  SalesMeetingTraditionalView,
  SALES_MEETING_FREEZABLE_COLUMN_IDS,
  SM_DEFAULT_FROZEN,
  SM_MAX_FROZEN,
} from './sales-meeting-traditional';
import { SalesMeetingSourceDrawer } from './sales-meeting-source-drawer';
import { SalesMeetingSourceValue } from './sales-meeting-source-value';
import { salesMeetingSummarySource } from '@/lib/mrp/sales-meeting-summary-source';
import {
  WarehouseStockDrawer,
  WarehouseStockValue,
  type WarehouseStockRequest,
} from './warehouse-stock-detail';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import { ListRequestError } from './ui/list-request-error';
import type {
  SalesMeetingItem,
  SalesMeetingPeriodDetail as PeriodDetail,
  SalesMeetingSourceTarget,
} from '@/lib/mrp/sales-meeting-types';

interface SmListCache {
  items: SalesMeetingItem[];
  total: number;
  runVersionCode: string | null;
  runDate: string | null;
  sources: DbSource[];
  customerCodeOptions: string[];
}
import {
  useColumnVisibility,
  useRunCustomerCodeColumns,
  useTableFiltering,
  useTablePresets,
  useTableSorting,
} from './data-table/hooks';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { loadColumnFilterOptions } from './data-table/column-filter-options-client';
import { SALES_MEETING_COLUMNS, SALES_MEETING_PERIOD_COLUMNS, SALES_MEETING_PERIOD_VISIBILITY_IDS } from './data-table/column-defs/sales-meeting-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import type { TablePreset } from './data-table/types';
import { TextSizeControl, TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { FrozenColsControl } from './ui/frozen-cols-control';
import { usePersistedState } from './ui/use-persisted-state';
import { useReportPage } from './ui/use-report-page';
import { useReportScroll } from './ui/use-report-scroll';
import { TablePagination } from './ui/table-pagination';
import { DbSourceBadge } from './ui/db-source-badge';
import {
  hasCompletePeriodMap,
  salesMeetingPeriodsCacheKey,
} from '@/lib/mrp/list-periods-contract';

const SALES_MEETING_COLUMN_IDS = new Set(
  SALES_MEETING_COLUMNS.map((column) => column.id),
);

interface DbSource {
  mode: string;
  runVersionCode: string;
  runDate: string;
  runId: number;
}

type ViewMode = 'default' | 'traditional';

const ROW_COLORS = {
  demand: { bg: 'bg-orange-500', text: 'text-white', label: '訂單需求' },
  supply: { bg: 'bg-green-500', text: 'text-white', label: '生產計畫' },
  remainingStock: { bg: 'bg-emerald-800', text: 'text-white', label: '剩餘庫存' },
};

const STATUS_STYLES: Record<string, string> = {
  '足夠': 'bg-green-100 text-green-800',
  '不足': 'bg-red-100 text-red-800',
  '無訂單': 'bg-slate-100 text-slate-500',
};

export function SalesMeetingClient() {
  const { selectedRunId, isLoading: versionLoading } = useMrpVersion();
  const [items, setItems] = useState<SalesMeetingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const [periodData, setPeriodData] = useState<PeriodDetail[]>([]);
  const [runVersionCode, setRunVersionCode] = useState<string | null>(null);
  const [runDate, setRunDate] = useState<string | null>(null);
  const [viewMode, setViewMode] = usePersistedState<ViewMode>('mrp_viewMode_sm', 'traditional');
  const [textSize, setTextSize] = usePersistedState('mrp_textSize_sm', 0);
  const [frozenCols, setFrozenCols] = usePersistedState('mrp_frozenCols_sm', SM_DEFAULT_FROZEN);
  // 合併 DB 開關移到「設定」頁；此處僅讀取
  const [mergeDb] = usePersistedState('mrp_mergeDb', false);
  const [sources, setSources] = useState<DbSource[]>([]);
  const [customerCodes, setCustomerCodes] = useState<string[]>([]);
  const [sourceTarget, setSourceTarget] = useState<SalesMeetingSourceTarget | null>(null);
  const sourceTriggerRef = useRef<HTMLElement | null>(null);
  const openSource = useCallback((target: SalesMeetingSourceTarget) => {
    sourceTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSourceTarget(target);
  }, []);
  const [warehouseRequest, setWarehouseRequest] = useState<WarehouseStockRequest | null>(null);

  const [limit, setLimit] = usePersistedState('mrp_pageSize_sm', 50);
  const columns = useRunCustomerCodeColumns(
    SALES_MEETING_COLUMNS,
    selectedRunId,
    customerCodes,
    true,
  );
  const tableId = 'sales_meeting';
  const visibilityColumns = useMemo(() => [...SALES_MEETING_PERIOD_COLUMNS, ...columns], [columns]);

  const sorting = useTableSorting([
    { id: 'erpPartNo', direction: 'asc', label: 'ERP料號' },
    { id: 'customerCode', direction: 'asc', label: '客戶代碼' },
    { id: 'customerPartNo', direction: 'asc', label: '客戶料號' },
  ], 'mrp_sort_sm_v2', SALES_MEETING_COLUMN_IDS);
  const filtering = useTableFiltering(undefined, 'mrp_filter_sm', SALES_MEETING_COLUMN_IDS);
  const colVis = useColumnVisibility(visibilityColumns, 'mrp_colvis_sm_v2');
  const freezeToSalesMeetingColumn = useCallback((columnId: string) => {
    const visibleColumnIds = SALES_MEETING_FREEZABLE_COLUMN_IDS.filter(
      (id) => colVis.visibility[id] !== false,
    );
    const index = visibleColumnIds.indexOf(columnId);
    if (index >= 0) setFrozenCols(Math.min(index + 1, SM_MAX_FROZEN));
  }, [colVis.visibility, setFrozenCols]);
  const columnHeader = useTableColumnHeaderMenu({
    columnFilters: filtering.filterState.columnFilters,
    sortFields: sorting.sortState.fields,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    onPrioritizeSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
    onFreezeToColumn: freezeToSalesMeetingColumn,
    canFreezeColumn: (columnId) => SALES_MEETING_FREEZABLE_COLUMN_IDS.includes(columnId),
    optionContext: {
      tableId,
      runId: selectedRunId,
      mergeDb,
      globalSearch: filtering.queryGlobalSearch,
      columnFilters: filtering.filterState.columnFilters,
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

  // Reset page when filters/sort change
  useEffect(() => {
    setExpandedPart(null);
  }, [filtering.queryGlobalSearch, filtering.filterState.columnFilters, sorting.sortState, limit]);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const { page, setPage, queryReady } = useReportPage('mrp_page_sm', JSON.stringify([
    selectedRunId, mergeDb, filtering.queryGlobalSearch, filtering.filterQueryParams,
    sorting.sortQueryParam, limit,
  ]), !versionLoading && filtering.hydrated && sorting.hydrated);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);

  const buildListKey = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filtering.queryGlobalSearch) params.set('search', filtering.queryGlobalSearch);
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (mergeDb) params.set('merge', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    if (viewMode === 'traditional' && !mergeDb) params.set('includePeriods', '1');
    for (const [k, v] of Object.entries(filtering.filterQueryParams)) params.set(k, v);
    return `/api/sales-meeting?${params}`;
  }, [page, limit, filtering.queryGlobalSearch, filtering.filterQueryParams, sorting.sortQueryParam, mergeDb, selectedRunId, viewMode]);

  const listPending = !queryReady || loadedListKey !== buildListKey();
  useReportScroll('mrp_scroll_sales-meeting', buildListKey(), !loading && !listPending);

  // 切頁回來時 paint 前先鋪上快取 stale → 零 spinner（merge 模式不快取）
  useLayoutEffect(() => {
    if (!queryReady) return;
    fetchAbortRef.current?.abort();
    setListError(null);
    const cached = !mergeDb ? cachePeek<SmListCache>(buildListKey()) : undefined;
    if (cached) {
      setItems(cached.items);
      setLoadedListKey(buildListKey());
      setTotal(cached.total);
      if (cached.runVersionCode) setRunVersionCode(cached.runVersionCode);
      if (cached.runDate) setRunDate(cached.runDate);
      setSources(cached.sources);
      setCustomerCodes(cached.customerCodeOptions);
      setLoading(false);
    } else {
      setTotal(0);
      setLoading(true);
    }
  }, [buildListKey, mergeDb, queryReady]);

  const fetchData = useCallback(async () => {
    if (!queryReady) return;
    fetchAbortRef.current?.abort();
    const ac = new AbortController();
    fetchAbortRef.current = ac;
    setListError(null);
    const key = buildListKey();
    const cached = !mergeDb ? cachePeek<SmListCache>(key) : undefined;
    if (cached) {
      if (cacheIsFresh(key)) { if (fetchAbortRef.current === ac) setLoading(false); return; }
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(key, { signal: ac.signal });
      const json = await res.json();
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      if (!res.ok) throw new Error(json.error || `產銷會議資料讀取失敗 (${res.status})`);
      const responseItems = (json.items || []) as SalesMeetingItem[];
      if (
        !mergeDb
        && hasCompletePeriodMap(responseItems.map((item) => item.partVersion), json.periods)
      ) {
        const periodsKey = salesMeetingPeriodsCacheKey(responseItems);
        if (periodsKey) cacheSet(periodsKey, json.periods);
      }
      setItems(responseItems);
      setLoadedListKey(key);
      setTotal(json.total || 0);
      if (json.runVersionCode) setRunVersionCode(json.runVersionCode);
      if (json.runDate) setRunDate(json.runDate);
      setSources(json.sources || []);
      setCustomerCodes(json.filterOptions?.customerCode || []);
      if (!mergeDb) {
        cacheSet<SmListCache>(key, {
          items: json.items || [], total: json.total || 0,
          runVersionCode: json.runVersionCode ?? null,
          runDate: json.runDate ?? null,
          sources: json.sources || [],
          customerCodeOptions: json.filterOptions?.customerCode || [],
        });
      }
    } catch (err) {
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      setListError(err instanceof Error ? err.message : '產銷會議資料讀取失敗');
    } finally {
      if (!ac.signal.aborted && fetchAbortRef.current === ac) setLoading(false);
    }
  }, [buildListKey, mergeDb, queryReady]);

  useEffect(() => {
    fetchData();
    return () => fetchAbortRef.current?.abort();
  }, [fetchData]);

  // Fetch ALL items (no pagination) for export
  const fetchAllForExport = useCallback(async (): Promise<SalesMeetingItem[]> => {
    const params = new URLSearchParams({ page: '1', limit: '100000' });
    if (filtering.filterState.globalSearch) params.set('search', filtering.filterState.globalSearch);
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (mergeDb) params.set('merge', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    for (const [key, val] of Object.entries(filtering.filterQueryParams)) {
      params.set(key, val);
    }
    const res = await fetch(`/api/sales-meeting?${params}`);
    const json = await res.json();
    return json.items || [];
  }, [filtering.filterState.globalSearch, filtering.filterQueryParams, sorting.sortQueryParam, mergeDb, selectedRunId]);

  const toggleExpand = async (item: SalesMeetingItem) => {
    if (expandedPart === item.partVersion) {
      setExpandedPart(null);
      return;
    }
    setExpandedPart(item.partVersion);
    try {
      const periodParams = new URLSearchParams({ runId: String(item.mrpRunId) });
      periodParams.set('memberPartVersions', JSON.stringify(item.memberPartVersions));
      if (mergeDb && item.dbSource) periodParams.set('dbSource', item.dbSource);
      const res = await fetch(
        `/api/sales-meeting/${encodeURIComponent(item.partVersion)}/periods?${periodParams}`,
      );
      const json = await res.json();
      setPeriodData(json.periods || []);
    } catch {
      setPeriodData([]);
    }
  };

  const totalPages = Math.ceil(total / limit);
  const colSpan = columns.length + 1; // +1 for expand arrow

  const fmtNum = (v: number | null | undefined, decimals = 0): string => {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (decimals > 0) return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return n.toLocaleString();
  };
  const openWarehouse = useCallback((
    item: SalesMeetingItem,
    warehouseGroup: WarehouseStockRequest['warehouseGroup'],
    initialFilter?: WarehouseStockRequest['initialFilter'],
  ) => {
    setWarehouseRequest({
      runId: item.mrpRunId,
      partVersion: item.partVersion,
      aggregated: false,
      warehouseGroup,
      initialFilter,
      dbSource: item.dbSource,
    });
  }, []);
  const closeWarehouse = useCallback(() => setWarehouseRequest(null), []);
  const closeSource = useCallback(() => {
    setSourceTarget(null);
    const trigger = sourceTriggerRef.current;
    sourceTriggerRef.current = null;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
  }, []);

  return (
    <div className="h-full flex flex-col px-6 pt-6 pb-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <h2 className="text-2xl font-bold text-slate-800">產銷會議(週推移)</h2>
        <TablePagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          onPageChange={setPage}
          onLimitChange={setLimit}
        />
      </div>

      {/* Toolbar */}
      <TableToolbar
        tableId={tableId}
        columns={visibilityColumns}
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
        onSearchDraftChange={filtering.rememberSearchDraft}
        searchStateReady={filtering.hydrated}
        restoredSession={filtering.restoredSession}
        columnFilters={filtering.filterState.columnFilters}
        onSetColumnFilter={filtering.setColumnFilter}
        onRemoveColumnFilter={filtering.removeColumnFilter}
        onClearAllFilters={filtering.clearAllFilters}
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
        filterOptionContext={columnHeader.menuController.optionContext}
        loadFilterOptions={columnHeader.menuController.loadOptions}
        extraControls={
          <div className="flex items-center gap-2 ml-auto">
            {viewMode === 'traditional' && (
              <FrozenColsControl value={frozenCols} max={SM_MAX_FROZEN} onChange={setFrozenCols} />
            )}
            <TextSizeControl value={textSize} onChange={setTextSize} />
            <div className="flex items-center border border-slate-300 rounded-md p-0.5">
              {(['default', 'traditional'] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === mode
                      ? 'bg-blue-500 text-white'
                      : 'text-slate-600 hover:text-slate-800'
                  }`}
                >
                  {mode === 'default' ? '簡易' : '傳統'}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <ColumnHeaderMenu controller={columnHeader.menuController} />

      {/* Merge Sources Summary */}
      {mergeDb && sources.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-600 bg-indigo-50 border border-indigo-200 rounded px-3 py-1.5">
          <span className="font-medium">來源:</span>
          {sources.map((s, i) => (
            <span key={s.mode} className="flex items-center gap-1">
              {i > 0 && <span className="text-slate-400">+</span>}
              <DbSourceBadge source={s.mode} />
              <span className="text-slate-400">({s.runVersionCode})</span>
            </span>
          ))}
        </div>
      )}

      {/* Color Legend + Quick Filters */}
      <div className="flex items-center gap-3 text-xs flex-wrap">
        <span className="font-semibold text-slate-500">圖例：</span>
        {Object.entries(ROW_COLORS).map(([key, c]) => (
          <span key={key} className={`${c.bg} ${c.text} px-2 py-0.5 rounded`}>
            {c.label}
          </span>
        ))}
        <span
          className="px-2 py-0.5 border border-sky-300 bg-sky-50 text-sky-800 rounded"
          title="同一 ERP 料號的實體庫存與生產計畫只計一次，剩餘庫存依週別、客戶代碼、客料版本順序扣用"
        >
          同 ERP 共享庫存
        </span>
        <span className="mx-1 text-slate-300">|</span>
        <button
          onClick={() => {
            const hasFilter = filtering.filterState.columnFilters.some(f => f.columnId === 'fgStatus04');
            if (hasFilter) {
              filtering.removeColumnFilter('fgStatus04');
            } else {
              filtering.setColumnFilter({ columnId: 'fgStatus04', operator: 'equals', value: '不足' });
            }
          }}
          className={`px-2 py-0.5 rounded border transition-colors ${
            filtering.filterState.columnFilters.some(f => f.columnId === 'fgStatus04')
              ? 'bg-red-100 border-red-300 text-red-700 font-medium'
              : 'bg-white border-slate-300 text-slate-500 hover:border-red-300 hover:text-red-600'
          }`}
        >
          [前四期] 庫存&lt;訂單
        </button>
        <HintTip text="前4期現有庫存不足以滿足訂單需求（不含生產供應）" />
        <button
          onClick={() => {
            const hasFilter = filtering.filterState.columnFilters.some(f => f.columnId === 'shortageStartWeek');
            if (hasFilter) {
              filtering.removeColumnFilter('shortageStartWeek');
            } else {
              filtering.setColumnFilter({ columnId: 'shortageStartWeek', operator: 'isNotEmpty', value: '' });
            }
          }}
          className={`px-2 py-0.5 rounded border transition-colors ${
            filtering.filterState.columnFilters.some(f => f.columnId === 'shortageStartWeek')
              ? 'bg-red-100 border-red-300 text-red-700 font-medium'
              : 'bg-white border-slate-300 text-slate-500 hover:border-red-300 hover:text-red-600'
          }`}
        >
          [生產計劃推移]出現缺口
        </button>
        <HintTip text="13週生產計劃推移中庫存會變負數的項目（已含生產供應）" />
        <button
          onClick={() => {
            const current = filtering.filterState.columnFilters.find((filter) => (
              filter.columnId === 'customerCode'
            ));
            const values: string[] = current?.operator === 'oneOf' && Array.isArray(current.value)
              ? current.value.filter((entry): entry is string => typeof entry === 'string')
              : current?.operator === 'equals'
                ? [String(current.value)]
                : [];
            const next = values.includes('SY')
              ? values.filter((value) => value !== 'SY')
              : [...values, 'SY'];
            if (next.length === 0) filtering.removeColumnFilter('customerCode');
            else filtering.setColumnFilter({
              columnId: 'customerCode',
              operator: 'oneOf',
              value: next,
              valueType: 'enum',
            });
          }}
          className={`px-2 py-0.5 rounded border transition-colors ${
            filtering.filterState.columnFilters.some((filter) => (
              filter.columnId === 'customerCode'
              && (
                (filter.operator === 'oneOf'
                  && Array.isArray(filter.value)
                  && filter.value.some((entry) => entry === 'SY'))
                || (filter.operator === 'equals' && filter.value === 'SY')
              )
            ))
              ? 'bg-blue-100 border-blue-300 text-blue-700 font-medium'
              : 'bg-white border-slate-300 text-slate-500 hover:border-blue-300 hover:text-blue-700'
          }`}
        >
          客戶 SY
        </button>
        <button
          onClick={() => {
            const active = filtering.filterState.columnFilters.some((filter) => (
              filter.columnId === 'inventoryAnomalyCount'
            ));
            if (active) filtering.removeColumnFilter('inventoryAnomalyCount');
            else filtering.setColumnFilter({
              columnId: 'inventoryAnomalyCount',
              operator: 'gt',
              value: '0',
            });
          }}
          className={`px-2 py-0.5 rounded border transition-colors ${
            filtering.filterState.columnFilters.some((filter) => (
              filter.columnId === 'inventoryAnomalyCount'
            ))
              ? 'bg-amber-100 border-amber-400 text-amber-800 font-medium'
              : 'bg-white border-slate-300 text-slate-500 hover:border-amber-400 hover:text-amber-800'
          }`}
        >
          庫存異常
        </button>
      </div>

      {listError && <ListRequestError message={listError} onRetry={fetchData} />}

      {/* Traditional View */}
      {viewMode === 'traditional' && (
        <>
          {loading && listPending && <Loader label="讀取產銷會議資料" className="flex-1" />}
          <div className={listPending ? 'hidden' : 'contents'}>
          <SalesMeetingTraditionalView
            items={items}
            active={!listPending}
            textSize={textSize}
            frozenCount={frozenCols}
            fetchAllForExport={fetchAllForExport}
            onOpenSource={openSource}
            onOpenWarehouse={openWarehouse}
            columnVisibility={colVis.visibility}
            columnFilters={filtering.filterState.columnFilters}
            onSetColumnFilter={filtering.setColumnFilter}
            onRemoveColumnFilter={filtering.removeColumnFilter}
            sortFields={sorting.sortState.fields}
            onAddSort={sorting.prioritizeSort}
            onRemoveSort={sorting.removeSort}
            onToggleColumn={colVis.toggleColumn}
            onFreezeToColumn={freezeToSalesMeetingColumn}
            columnHeaderController={columnHeader.menuController}
            columnHeaderColumns={columns}
          />
          </div>
        </>
      )}

      {/* Data Table */}
      {viewMode !== 'traditional' && (
      <div data-mrp-scroll className="flex-1 min-h-0 bg-white border border-slate-200 rounded-lg overflow-auto">
        <table className="w-full mrp-table" style={{ zoom: TEXT_ZOOM_LEVELS[textSize] || 1 }} onContextMenu={cellMenu.handleContextMenu}>
          <thead>
            <tr>
              <th className="w-8" style={{ minWidth: 32 }}></th>
              {columns.map((col) =>
                colVis.visibility[col.id] !== false ? (
                  <ColumnHeaderCell
                    labelMaxLines={3}
                    style={{ minWidth: Math.max(col.width || 0, col.id === 'unit' ? 70 : col.filterType === 'numeric' ? 100 : 90) }}
                    key={col.id}
                    column={col}
                    controller={columnHeader.menuController}
                  />
                ) : null,
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colSpan}><Loader /></td>
              </tr>
            ) : listPending ? null : items.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-center py-8 text-slate-400">
                  查無資料，請先執行 MRP。
                </td>
              </tr>
            ) : (
              items.map((item, rowIndex) => {
                const previousErp = rowIndex > 0 ? items[rowIndex - 1]?.erpPartNo?.trim() : null;
                const startsSharedGroup = item.sharedErpCount > 1
                  && item.erpPartNo?.trim() !== previousErp;
                return (
                <Fragment key={item.id}>
                  <tr
                    className={`cursor-pointer hover:bg-slate-50 ${
                      startsSharedGroup ? 'border-t-2 border-t-sky-400' : ''
                    }`}
                    onClick={() => toggleExpand(item)}
                  >
                    <td className="text-center text-slate-400">
                      {expandedPart === item.partVersion ? '▼' : '▶'}
                    </td>
                    {colVis.visibility['customerCode'] !== false && (
                      <td data-col="customerCode" data-value={item.customerCode ?? ''} className="text-center text-xs font-medium">
                        {item.customerCode || '—'}
                      </td>
                    )}
                    {colVis.visibility['customerPartNo'] !== false && (
                      <td
                        data-col="customerPartNo"
                        data-value={item.customerPartNo ?? ''}
                        className="font-mono text-xs font-medium"
                      >
                        {mergeDb && item.dbSource && <DbSourceBadge source={item.dbSource} />}{' '}
                        {item.customerPartNo || item.partVersion}
                        {item.memberPartVersions.length > 1 && (
                          <span
                            className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500"
                            title={item.memberPartVersions.join('\n')}
                          >
                            {item.memberPartVersions.length} 版本
                          </span>
                        )}
                      </td>
                    )}
                    {colVis.visibility['partVersion'] !== false && (
                      <td data-col="partVersion" data-value={item.partVersion ?? ''} className="font-mono text-xs font-medium">
                        {item.memberPartVersions.join('、')}
                      </td>
                    )}
                    {colVis.visibility['erpPartNo'] !== false && (
                      <td data-col="erpPartNo" data-value={item.erpPartNo ?? ''} className="font-mono text-xs">{item.erpPartNo || '—'}</td>
                    )}
                    {colVis.visibility['unit'] !== false && (
                      <td data-col="unit" data-value={item.unit ?? ''} className="text-xs text-center">{item.unit || '—'}</td>
                    )}
                    {colVis.visibility['goodStockPc'] !== false && (
                      <td data-col="goodStockPc" data-value={String(item.goodStockPc ?? '')} className="text-right font-mono text-xs">{fmtNum(item.goodStockPc)}</td>
                    )}
                    {colVis.visibility['goodStockKg'] !== false && (
                      <td data-col="goodStockKg" data-value={String(item.goodStockKg ?? '')} className="text-right font-mono text-xs">{fmtNum(item.goodStockKg, 2)}</td>
                    )}
                    {colVis.visibility['mainStockPc'] !== false && (
                      <td data-col="mainStockPc" data-value={String(item.mainStockPc ?? '')} className="text-right font-mono text-xs">
                        <WarehouseStockValue
                          value={item.mainStockPc}
                          warehouseGroup="INTERNAL"
                          onOpen={() => openWarehouse(item, 'INTERNAL')}
                          hasInventoryAnomaly={item.mainInventoryAnomalyCount > 0}
                          inventoryAnomalyCount={item.mainInventoryAnomalyCount}
                        />
                      </td>
                    )}
                    {colVis.visibility['auxStockPc'] !== false && (
                      <td data-col="auxStockPc" data-value={String(item.auxStockPc ?? '')} className="text-right font-mono text-xs">
                        <WarehouseStockValue
                          value={item.auxStockPc}
                          warehouseGroup="AUX"
                          onOpen={() => openWarehouse(item, 'AUX')}
                          hasInventoryAnomaly={item.auxInventoryAnomalyCount > 0}
                          inventoryAnomalyCount={item.auxInventoryAnomalyCount}
                        />
                      </td>
                    )}
                    {colVis.visibility['inventoryAnomalyCount'] !== false && (
                      <td
                        data-col="inventoryAnomalyCount"
                        data-value={String(item.inventoryAnomalyCount)}
                        className="text-center text-xs"
                      >
                        {item.inventoryAnomalyCount > 0 ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openWarehouse(
                                item,
                                item.mainInventoryAnomalyCount > 0 ? 'INTERNAL' : 'AUX',
                                'ANOMALY',
                              );
                            }}
                            className="inline-flex items-center gap-1 border border-amber-400 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
                            title={`有 ${item.inventoryAnomalyCount} 筆庫存批號可能未同步`}
                          >
                            <AlertTriangle size={11} />
                            待確認 {item.inventoryAnomalyCount}
                          </button>
                        ) : (
                          <span className="text-emerald-600">正常</span>
                        )}
                      </td>
                    )}
                    {colVis.visibility['badStockPc'] !== false && (
                      <td data-col="badStockPc" data-value={String(item.badStockPc ?? '')} className="text-right font-mono text-xs">{fmtNum(item.badStockPc)}</td>
                    )}
                    {colVis.visibility['badStockKg'] !== false && (
                      <td data-col="badStockKg" data-value={String(item.badStockKg ?? '')} className="text-right font-mono text-xs">{fmtNum(item.badStockKg, 2)}</td>
                    )}
                    {colVis.visibility['avgDemandPerWeek'] !== false && (
                      <td data-col="avgDemandPerWeek" data-value={String(item.avgDemandPerWeek ?? '')} className="text-right font-mono text-xs">{fmtNum(item.avgDemandPerWeek, 1)}</td>
                    )}
                    {colVis.visibility['stockWeeks'] !== false && (
                      <td data-col="stockWeeks" data-value={String(item.stockWeeks ?? '')} className="text-right font-mono text-xs">{fmtNum(item.stockWeeks, 1)}</td>
                    )}
                    {colVis.visibility['purchaseLeadWeeks'] !== false && (
                      <td data-col="purchaseLeadWeeks" data-value={String(item.purchaseLeadWeeks ?? '')} className="text-right font-mono text-xs">{fmtNum(item.purchaseLeadWeeks)}</td>
                    )}
                    {colVis.visibility['shortageStartWeek'] !== false && (
                      <td data-col="shortageStartWeek" data-value={item.shortageStartWeek != null ? String(item.shortageStartWeek) : ''} className="text-center text-xs">
                        {item.shortageStartWeek !== null ? (
                          <span className="badge badge-danger">W{item.shortageStartWeek}</span>
                        ) : (
                          <span className="badge badge-success">OK</span>
                        )}
                      </td>
                    )}
                    {colVis.visibility['outstanding04'] !== false && (
                      <td data-col="outstanding04" data-value={String(item.outstanding04 ?? '')} className="text-right font-mono text-xs"><SalesMeetingSourceValue target={salesMeetingSummarySource(item, 'outstanding04')} onOpen={openSource}>{fmtNum(item.outstanding04)}</SalesMeetingSourceValue></td>
                    )}
                    {colVis.visibility['fgDiff04'] !== false && (
                      <td data-col="fgDiff04" data-value={String(item.fgDiff04 ?? '')} className={`text-right font-mono text-xs font-bold ${Number(item.fgDiff04) < 0 ? 'text-red-600' : ''}`}>
                        <SalesMeetingSourceValue target={salesMeetingSummarySource(item, 'fgDiff04')} onOpen={openSource}>{fmtNum(item.fgDiff04)}</SalesMeetingSourceValue>
                      </td>
                    )}
                    {colVis.visibility['fgStatus04'] !== false && (
                      <td data-col="fgStatus04" data-value={item.fgStatus04 ?? ''} className="text-center text-xs">
                        {item.fgStatus04 ? (
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[item.fgStatus04] || 'bg-slate-100'}`}>
                            {item.fgStatus04}
                          </span>
                        ) : '—'}
                      </td>
                    )}
                    {colVis.visibility['totalOrderDemand'] !== false && (
                      <td data-col="totalOrderDemand" data-value={String(item.totalOrderDemand ?? '')} className="text-right font-mono text-xs"><SalesMeetingSourceValue target={salesMeetingSummarySource(item, 'totalOrderDemand')} onOpen={openSource}>{fmtNum(item.totalOrderDemand)}</SalesMeetingSourceValue></td>
                    )}
                    {colVis.visibility['totalFgDiff'] !== false && (
                      <td data-col="totalFgDiff" data-value={String(item.totalFgDiff ?? '')} className={`text-right font-mono text-xs font-bold ${Number(item.totalFgDiff) < 0 ? 'text-red-600' : ''}`}>
                        <SalesMeetingSourceValue target={salesMeetingSummarySource(item, 'totalFgDiff')} onOpen={openSource}>{fmtNum(item.totalFgDiff)}</SalesMeetingSourceValue>
                      </td>
                    )}
                  </tr>

                  {/* Expanded period detail */}
                  {expandedPart === item.partVersion && (
                    <tr key={`${item.id}-detail`} data-detail="true">
                      <td colSpan={colSpan} className="bg-slate-50 p-4">
                        {/* Header info */}
                        <div className="mb-3 p-3 bg-white border border-slate-200 rounded-lg text-xs grid grid-cols-2 md:grid-cols-4 gap-2">
                          <div><span className="text-slate-500">MRP版本: </span><span className="font-mono font-medium text-blue-700">{runVersionCode || '—'}</span></div>
                          <div><span className="text-slate-500">跑表日期: </span><span className="font-medium">{runDate || '—'}</span></div>
                          <div><span className="text-slate-500">客戶料號: </span><span className="font-mono font-medium text-blue-600">{item.customerPartNo || item.partVersion}</span></div>
                          <div className="md:col-span-2"><span className="text-slate-500">包含版本: </span><span className="font-mono">{item.memberPartVersions.join('、')}</span></div>
                          <div><span className="text-slate-500">ERP料號: </span><span className="font-mono">{item.erpPartNo || '—'}</span></div>
                          <div><span className="text-slate-500">單位: </span><span className="font-medium">{item.unit || '—'}</span></div>
                          <div><span className="text-slate-500">良品庫存: </span><span className="font-mono font-bold">{item.unit?.toUpperCase() === 'KG' ? fmtNum(item.goodStockKg, 2) + ' kg' : fmtNum(item.goodStockPc) + ' pc'}</span></div>
                          <div><span className="text-slate-500">平均需求/週: </span><span className="font-mono">{fmtNum(item.avgDemandPerWeek, 1)}</span></div>
                          <div><span className="text-slate-500">庫存週數: </span><span className="font-mono">{fmtNum(item.stockWeeks, 1)}</span></div>
                          <div><span className="text-slate-500">採購前置期: </span><span className="font-medium">{fmtNum(item.purchaseLeadWeeks)} 週</span></div>
                          <div>
                            <span className="text-slate-500">缺貨: </span>
                            {item.shortageStartWeek !== null ? (
                              <span className="text-red-600 font-bold">W{item.shortageStartWeek}</span>
                            ) : (
                              <span className="text-green-600 font-bold">無缺料</span>
                            )}
                          </div>
                          <div><span className="text-slate-500">前4期狀態: </span><span className={`px-2 py-0.5 rounded font-medium ${STATUS_STYLES[item.fgStatus04 || ''] || ''}`}>{item.fgStatus04 || '—'}</span></div>
                          <div><span className="text-slate-500">總量推移: </span><span className={`font-mono font-bold ${Number(item.totalFgDiff) < 0 ? 'text-red-600' : ''}`}>{fmtNum(item.totalFgDiff)}</span></div>
                        </div>

                        {/* 13-week period table */}
                        <WeeklyPeriodTable
                          item={item}
                          periods={periodData}
                          onOpenSource={openSource}
                          columnVisibility={colVis.visibility}
                        />
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
      )}

      {/* 頁碼移到標題列 — 見 TablePagination */}
      <CellContextMenu {...cellMenu.contextMenuProps} />
      {sourceTarget && <SalesMeetingSourceDrawer target={sourceTarget} onClose={closeSource} />}
      {warehouseRequest && <WarehouseStockDrawer request={warehouseRequest} onClose={closeWarehouse} />}
    </div>
  );
}

// ============================================================
// Weekly Period Breakdown Component
// ============================================================

function WeeklyPeriodTable({
  item,
  periods,
  onOpenSource,
  columnVisibility,
}: {
  item: SalesMeetingItem;
  periods: PeriodDetail[];
  onOpenSource: (target: SalesMeetingSourceTarget) => void;
  columnVisibility: Record<string, boolean>;
}) {
  if (periods.length === 0) {
    return <div className="text-sm text-slate-400 py-4 text-center">載入週期資料...</div>;
  }

  const fmtVal = (v: number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const n = Number(v);
    if (n === 0) return '';
    return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  };

  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left bg-slate-100 border border-slate-200 sticky left-0 z-10 min-w-[70px]">
              週
            </th>
            {periods.map((p) => (
              <th
                key={p.weekIndex}
                className="px-2 py-1 text-center bg-slate-100 border border-slate-200 min-w-[65px] whitespace-nowrap"
              >
                {p.weekLabel || `W${String(p.weekIndex).padStart(2, '0')}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Demand row */}
          {columnVisibility[SALES_MEETING_PERIOD_VISIBILITY_IDS.demand] !== false && (
          <tr>
            <td className={`px-2 py-1 font-medium ${ROW_COLORS.demand.bg} ${ROW_COLORS.demand.text} sticky left-0 z-10 border border-slate-200`}>
              {ROW_COLORS.demand.label}
            </td>
            {periods.map((p) => (
              <td key={p.weekIndex} className="px-2 py-1 text-right font-mono border border-slate-200 bg-orange-50">
                <button
                  type="button"
                  onClick={() => onOpenSource({
                    item,
                    type: 'orders',
                    weekIndex: p.weekIndex,
                    weekLabel: p.weekLabel || `W${p.weekIndex}`,
                  })}
                  className="w-full text-right hover:text-blue-700 hover:underline"
                  title="查看訂單需求來源"
                >
                  {fmtVal(p.demand) || '0'}
                </button>
              </td>
            ))}
          </tr>
          )}

          {/* Supply row */}
          {columnVisibility[SALES_MEETING_PERIOD_VISIBILITY_IDS.supply] !== false && (
          <tr>
            <td className={`px-2 py-1 font-medium ${ROW_COLORS.supply.bg} ${ROW_COLORS.supply.text} sticky left-0 z-10 border border-slate-200`}>
              {ROW_COLORS.supply.label}
            </td>
            {periods.map((p) => (
              <td key={p.weekIndex} className="px-2 py-1 text-right font-mono border border-slate-200 bg-green-50">
                <button
                  type="button"
                  onClick={() => onOpenSource({
                    item,
                    type: 'production_plans',
                    weekIndex: p.weekIndex,
                    weekLabel: p.weekLabel || `W${p.weekIndex}`,
                  })}
                  className="w-full text-right hover:text-blue-700 hover:underline"
                  title="查看生產計畫來源"
                >
                  {fmtVal(p.supply) || '0'}
                </button>
              </td>
            ))}
          </tr>
          )}

          {/* Remaining Stock row */}
          {columnVisibility[SALES_MEETING_PERIOD_VISIBILITY_IDS.remainingStock] !== false && (
          <tr>
            <td className={`px-2 py-1 font-medium ${ROW_COLORS.remainingStock.bg} ${ROW_COLORS.remainingStock.text} sticky left-0 z-10 border border-slate-200`}>
              {ROW_COLORS.remainingStock.label}
            </td>
            {periods.map((p) => {
              const remaining = Number(p.remainingStock);
              const isNegative = p.remainingStock !== null && remaining < 0;
              return (
                <td
                  key={p.weekIndex}
                  className={`px-2 py-1 text-right font-mono font-bold border border-slate-200 ${
                    p.weekIndex === 0
                      ? '' // Prior period — no remaining stock display
                      : isNegative
                      ? 'bg-red-100 text-red-800'
                      : 'bg-emerald-50 text-emerald-800'
                  }`}
                >
                  {p.weekIndex === 0 ? '' : (
                    <button
                      type="button"
                      onClick={() => onOpenSource({
                        item,
                        type: 'balance',
                        weekIndex: p.weekIndex,
                        weekLabel: p.weekLabel || `W${p.weekIndex}`,
                      })}
                      className="w-full text-right hover:text-blue-700 hover:underline"
                      title="查看剩餘庫存計算明細"
                    >
                      {fmtVal(p.remainingStock) || '0'}
                    </button>
                  )}
                </td>
              );
            })}
          </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function HintTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-slate-400 hover:text-slate-600 text-[10px] cursor-pointer"
      >
        (?)
      </button>
      {open && (
        <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 w-52 px-2 py-1.5 text-[11px] text-slate-700 bg-white border border-slate-200 rounded shadow-lg leading-tight">
          {text}
        </span>
      )}
    </span>
  );
}
