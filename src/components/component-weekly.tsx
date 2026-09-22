'use client';

import { useState, useEffect, useLayoutEffect, useCallback, Fragment, useMemo, useRef } from 'react';
import {
  ComponentWeeklyTraditionalView,
  COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS,
  CW_DEFAULT_FROZEN,
  CW_MAX_FROZEN,
} from './component-weekly-traditional';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import {
  ISSUED_QTY_ERROR_LABELS,
  type IssuedQtyError,
} from '@/lib/mrp/work-order-bom-usage';
import {
  componentWeeklyPeriodsCacheKey,
  componentWeeklyRowKey,
  normalizeComponentWeeklyPeriod,
} from '@/lib/mrp/component-weekly-periods';
import { hasCompletePeriodMap } from '@/lib/mrp/list-periods-contract';
import {
  formatComponentWeeklyLeadTime,
  presentComponentWeeklyPurchaseAction,
  presentComponentWeeklyShortage,
  type ComponentWeeklyDecisionSummary,
} from '@/lib/mrp/component-weekly-purchase';
import { buildSourceRecordUrl } from '@/lib/source-record-links';

interface CwListCache {
  items: ComponentWeeklyItem[];
  total: number;
  runVersionCode: string | null;
  runDate: string | null;
  sources: DbSource[];
  usageWarnings: UsageWarnings;
}
import { useTableSorting, useTableFiltering, useColumnVisibility, useTablePresets } from './data-table/hooks';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { COMPONENT_WEEKLY_COLUMNS } from './data-table/column-defs/component-weekly-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import type { TablePreset } from './data-table/types';
import { withServerFacetedColumnOptions } from './data-table/column-header-contract';
import { loadColumnFilterOptions } from './data-table/column-filter-options-client';
import { TextSizeControl, TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { FrozenColsControl } from './ui/frozen-cols-control';
import { usePersistedState } from './ui/use-persisted-state';
import { useReportPage } from './ui/use-report-page';
import { useReportScroll } from './ui/use-report-scroll';
import { TablePagination } from './ui/table-pagination';
import { DbSourceBadge } from './ui/db-source-badge';
import {
  ComponentWeeklyUsageDrawer,
  type ComponentWeeklyUsageDetailTab,
  type ComponentWeeklyUsageMetric,
  type ComponentWeeklyUsageTarget,
} from './component-weekly-usage-drawer';
import {
  ComponentWeeklyLeadTimeButton,
  ComponentWeeklyPurchaseActionButton,
  ComponentWeeklyShortageButton,
} from './component-weekly-decision-cell';

const COMPONENT_WEEKLY_COLUMN_IDS = new Set(
  COMPONENT_WEEKLY_COLUMNS.map((column) => column.id),
);

interface DbSource {
  mode: string;
  runVersionCode: string;
  runDate: string;
  runId: number;
}

interface UsageWarningItem {
  sourceRecordId: string | null;
  woNumber: string | null;
  componentNo: string | null;
  plannedUsage: number;
  unit: string | null;
  sourceType: string | null;
  processCode: string | null;
  level: 'blocking' | 'review';
  reason: string | null;
  dbSource?: string;
}

interface UsageWarnings {
  count: number;
  blockingCount: number;
  reviewCount: number;
  items: UsageWarningItem[];
  incompleteSources?: number;
}

const EMPTY_USAGE_WARNINGS: UsageWarnings = {
  count: 0,
  blockingCount: 0,
  reviewCount: 0,
  items: [],
};

type ViewMode = 'default' | 'traditional';

interface ComponentWeeklyItem extends ComponentWeeklyDecisionSummary {
  id: number;
  mrpRunId: number;
  materialPartNo: string;
  goodStockPc: number;
  goodStockKg: number;
  badStockPc: number;
  badStockKg: number;
  avgWeeklyUsage: number;
  stockWeeks: number;
  dbSource?: string;
}

interface PeriodDetail {
  weekIndex: number;
  weekLabel: string | null;
  weekStart: string | null;
  remainingStock: number | null;
  usage: number;
  receipts: number;
}

type MrpType = 'W' | 'B' | 'D';

const MRP_TYPE_LABELS: Record<MrpType, string> = {
  W: 'W線材',
  B: 'B外購',
  D: 'D內製組合',
};

const ROW_COLORS = {
  remainingStock: { bg: 'bg-emerald-800', text: 'text-white', label: '剩餘庫存' },
  usage: { bg: 'bg-orange-500', text: 'text-white', label: '工令用料' },
  receipts: { bg: 'bg-green-500', text: 'text-white', label: '預納(進貨)' },
};

export function ComponentWeeklyClient() {
  const { selectedRunId, isLoading: versionLoading } = useMrpVersion();
  const [mrpType, setMrpType] = useState<MrpType>('W');
  const [typeReady, setTypeReady] = useState(false);
  useEffect(() => {
    try {
      const type = sessionStorage.getItem('mrp_type_cw');
      if (type === 'W' || type === 'B' || type === 'D') setMrpType(type);
    } catch { /* optional storage */ }
    setTypeReady(true);
  }, []);
  useEffect(() => {
    if (!typeReady) return;
    try { sessionStorage.setItem('mrp_type_cw', mrpType); } catch { /* optional storage */ }
  }, [mrpType, typeReady]);
  const [items, setItems] = useState<ComponentWeeklyItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [periodData, setPeriodData] = useState<PeriodDetail[]>([]);
  const [runVersionCode, setRunVersionCode] = useState<string | null>(null);
  const [runDate, setRunDate] = useState<string | null>(null);
  const [viewMode, setViewMode] = usePersistedState<ViewMode>('mrp_viewMode_cw', 'traditional');
  const [textSize, setTextSize] = usePersistedState(`mrp_textSize_cw_${mrpType}`, 0);
  const [frozenCols, setFrozenCols] = usePersistedState(`mrp_frozenCols_cw_${mrpType}`, CW_DEFAULT_FROZEN);
  // 合併 DB 開關移到「設定」頁；此處僅讀取
  const [mergeDb] = usePersistedState('mrp_mergeDb', false);
  const [sources, setSources] = useState<DbSource[]>([]);
  const [usageWarnings, setUsageWarnings] = useState<UsageWarnings>(EMPTY_USAGE_WARNINGS);
  const [usageDetailTarget, setUsageDetailTarget] = useState<ComponentWeeklyUsageTarget | null>(null);

  const [limit, setLimit] = usePersistedState('mrp_pageSize_cw', 50);
  const columns = useMemo(
    () => withServerFacetedColumnOptions(COMPONENT_WEEKLY_COLUMNS),
    [],
  );
  const tableId = `component_weekly_${mrpType}`;

  const openUsageDetail = useCallback((
    item: ComponentWeeklyItem,
    options: {
      weekIndex?: number | null;
      weekLabel?: string;
      initialTab: ComponentWeeklyUsageDetailTab;
      focusMetric: ComponentWeeklyUsageMetric;
    },
  ) => {
    setUsageDetailTarget({
      materialPartNo: item.materialPartNo,
      mrpType: item.mrpType,
      mrpRunId: item.mrpRunId,
      dbSource: item.dbSource,
      weekIndex: options.weekIndex ?? null,
      weekLabel: options.weekLabel ?? '全部週期',
      initialTab: options.initialTab,
      focusMetric: options.focusMetric,
    });
  }, []);

  const openPurchaseActionDetail = useCallback((item: ComponentWeeklyItem) => {
    const opensSupply = item.purchaseAction === 'expedite_overdue_po'
      || item.purchaseAction === 'expedite_open_po'
      || item.purchaseAction === 'expedite_and_order'
      || item.purchaseAction === 'covered_by_open_po'
      || item.purchaseAction === 'review_overdue_po';
    openUsageDetail(item, {
      initialTab: opensSupply ? 'supply' : 'calculation',
      focusMetric: opensSupply ? 'supplyQty' : 'weeksUntilOrder',
    });
  }, [openUsageDetail]);

  const sorting = useTableSorting([
    { id: 'materialPartNo', direction: 'asc', label: '料號' },
  ], 'mrp_sort_cw', COMPONENT_WEEKLY_COLUMN_IDS);
  const filtering = useTableFiltering(undefined, 'mrp_filter_cw', COMPONENT_WEEKLY_COLUMN_IDS);
  const colVis = useColumnVisibility(columns, 'mrp_colvis_cw');
  const freezeToComponentColumn = useCallback((columnId: string) => {
    const visibleColumnIds = COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS.filter(
      (id) => colVis.visibility[id] !== false,
    );
    const index = visibleColumnIds.indexOf(columnId);
    if (index >= 0) setFrozenCols(Math.min(index + 1, CW_MAX_FROZEN));
  }, [colVis.visibility, setFrozenCols]);
  const columnHeader = useTableColumnHeaderMenu({
    columnFilters: filtering.filterState.columnFilters,
    sortFields: sorting.sortState.fields,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    onPrioritizeSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
    onFreezeToColumn: freezeToComponentColumn,
    canFreezeColumn: (columnId) => COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS.includes(columnId),
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
    columns: COMPONENT_WEEKLY_COLUMNS,
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

  // Reset page when filters/sort/type change
  useEffect(() => {
    setExpandedRowKey(null);
  }, [filtering.queryGlobalSearch, filtering.filterState.columnFilters, sorting.sortState, mrpType, limit]);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const { page, setPage, queryReady } = useReportPage('mrp_page_cw', JSON.stringify([
    selectedRunId, mergeDb, filtering.queryGlobalSearch, filtering.filterQueryParams,
    sorting.sortQueryParam, mrpType, limit,
  ]), !versionLoading && typeReady && filtering.hydrated && sorting.hydrated);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const detailRequestSeq = useRef(0);

  const buildListKey = useCallback(() => {
    const params = new URLSearchParams({ mrpType, page: String(page), limit: String(limit) });
    if (filtering.queryGlobalSearch) params.set('search', filtering.queryGlobalSearch);
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (mergeDb) params.set('merge', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    if (viewMode === 'traditional' && !mergeDb) params.set('includePeriods', '1');
    for (const [k, v] of Object.entries(filtering.filterQueryParams)) params.set(k, v);
    return `/api/component-weekly?${params}`;
  }, [page, limit, mrpType, filtering.queryGlobalSearch, filtering.filterQueryParams, sorting.sortQueryParam, mergeDb, selectedRunId, viewMode]);

  const listPending = !queryReady || loadedListKey !== buildListKey();
  useReportScroll('mrp_scroll_component-weekly', buildListKey(), !loading && !listPending);

  // 切頁回來時 paint 前先鋪上快取 stale → 零 spinner（merge 模式不快取）
  useLayoutEffect(() => {
    if (!queryReady) return;
    fetchAbortRef.current?.abort();
    setListError(null);
    const cached = !mergeDb ? cachePeek<CwListCache>(buildListKey()) : undefined;
    if (cached) {
      setItems(cached.items);
      setLoadedListKey(buildListKey());
      setTotal(cached.total);
      if (cached.runVersionCode) setRunVersionCode(cached.runVersionCode);
      if (cached.runDate) setRunDate(cached.runDate);
      setSources(cached.sources);
      setUsageWarnings(cached.usageWarnings || EMPTY_USAGE_WARNINGS);
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
    const cached = !mergeDb ? cachePeek<CwListCache>(key) : undefined;
    if (cached) {
      if (cacheIsFresh(key)) { if (fetchAbortRef.current === ac) setLoading(false); return; }
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(key, { signal: ac.signal });
      const json = await res.json();
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      if (!res.ok) throw new Error(json.error || `元件週推資料讀取失敗 (${res.status})`);
      const responseItems = (json.items || []) as ComponentWeeklyItem[];
      if (
        !mergeDb
        && hasCompletePeriodMap(responseItems.map((item) => item.materialPartNo), json.periods)
      ) {
        const periods = Object.fromEntries(responseItems.map((item) => [
          componentWeeklyRowKey(item),
          json.periods[item.materialPartNo].map(normalizeComponentWeeklyPeriod),
        ]));
        const periodsKey = componentWeeklyPeriodsCacheKey(responseItems);
        if (periodsKey) cacheSet(periodsKey, periods);
      }
      setItems(responseItems);
      setLoadedListKey(key);
      setTotal(json.total || 0);
      if (json.runVersionCode) setRunVersionCode(json.runVersionCode);
      if (json.runDate) setRunDate(json.runDate);
      setSources(json.sources || []);
      setUsageWarnings(json.usageWarnings || EMPTY_USAGE_WARNINGS);
      if (!mergeDb) {
        cacheSet<CwListCache>(key, {
          items: json.items || [], total: json.total || 0,
          runVersionCode: json.runVersionCode ?? null, runDate: json.runDate ?? null, sources: json.sources || [],
          usageWarnings: json.usageWarnings || EMPTY_USAGE_WARNINGS,
        });
      }
    } catch (err) {
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      setListError(err instanceof Error ? err.message : '元件週推資料讀取失敗');
    } finally {
      if (!ac.signal.aborted && fetchAbortRef.current === ac) setLoading(false);
    }
  }, [buildListKey, mergeDb, queryReady]);

  useEffect(() => {
    fetchData();
    return () => fetchAbortRef.current?.abort();
  }, [fetchData]);

  // Fetch ALL items (no pagination) for export
  const fetchAllForExport = useCallback(async (): Promise<ComponentWeeklyItem[]> => {
    const params = new URLSearchParams({ mrpType, page: '1', limit: '100000' });
    if (filtering.filterState.globalSearch) params.set('search', filtering.filterState.globalSearch);
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (mergeDb) params.set('merge', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    for (const [key, val] of Object.entries(filtering.filterQueryParams)) {
      params.set(key, val);
    }
    const res = await fetch(`/api/component-weekly?${params}`);
    const json = await res.json();
    return json.items || [];
  }, [mrpType, filtering.filterState.globalSearch, filtering.filterQueryParams, sorting.sortQueryParam, mergeDb, selectedRunId]);

  const toggleExpand = async (item: ComponentWeeklyItem) => {
    const rowKey = componentWeeklyRowKey(item);
    if (expandedRowKey === rowKey) {
      setExpandedRowKey(null);
      return;
    }
    const requestSeq = ++detailRequestSeq.current;
    setExpandedRowKey(rowKey);
    setPeriodData([]);
    try {
      const periodParams = new URLSearchParams({ mrpType, runId: String(item.mrpRunId) });
      if (item.dbSource) periodParams.set('dbSource', item.dbSource);
      const res = await fetch(
        `/api/component-weekly/${encodeURIComponent(item.materialPartNo)}/periods?${periodParams}`,
      );
      if (!res.ok) throw new Error(`periods request failed: ${res.status}`);
      const json = await res.json();
      if (json.runId !== item.mrpRunId || (item.dbSource && json.dbSource !== item.dbSource)) {
        throw new Error('periods response identity mismatch');
      }
      if (detailRequestSeq.current !== requestSeq) return;
      setPeriodData(json.periods || []);
    } catch {
      if (detailRequestSeq.current !== requestSeq) return;
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

  return (
    <div className="h-full flex flex-col px-4 lg:px-6 pt-4 pb-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <h2 className="text-xl font-bold text-slate-800">元件週推移 (Component Weekly)</h2>
        <TablePagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          onPageChange={setPage}
          onLimitChange={setLimit}
          unitLabel="料件"
        />
      </div>

      {/* MRP Type Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        {(['W', 'B', 'D'] as MrpType[]).map((type) => (
          <button
            key={type}
            onClick={() => setMrpType(type)}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
              mrpType === type
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            {MRP_TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      {/* Toolbar */}
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
        onSearchDraftChange={filtering.rememberSearchDraft}
        searchStateReady={filtering.hydrated}
        restoredSession={filtering.restoredSession}
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
        extraControls={
          <div className="flex items-center gap-2 ml-auto">
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const hasFilter = filtering.filterState.columnFilters.some((filter) => filter.columnId === 'shortageStartWeek');
                  if (hasFilter) filtering.removeColumnFilter('shortageStartWeek');
                  else filtering.setColumnFilter({ columnId: 'shortageStartWeek', operator: 'isNotEmpty', value: '' });
                }}
                className={`px-2 py-1 rounded border text-xs transition-colors ${
                  filtering.filterState.columnFilters.some((filter) => filter.columnId === 'shortageStartWeek')
                    ? 'bg-red-100 border-red-300 text-red-700 font-medium'
                    : 'bg-white border-slate-300 text-slate-500 hover:border-red-300 hover:text-red-600'
                }`}
              >
                僅顯示缺貨
              </button>
              <HintTip text="篩選庫存推移中會出現負數（缺貨）的項目，已考慮進貨/供應" />
            </span>
            {viewMode === 'traditional' && (
              <FrozenColsControl value={frozenCols} max={CW_MAX_FROZEN} onChange={setFrozenCols} />
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
        <div className="flex items-center gap-2 text-xs text-slate-600 bg-indigo-50 border border-indigo-200 rounded px-3 py-1">
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

      {!listPending && <UsageWarningBanner warnings={usageWarnings} />}

      {listError && items.length > 0 && (
        <div
          role="status"
          className="flex items-center gap-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700"
        >
          <span className="min-w-0 flex-1 truncate">資料更新失敗：{listError}</span>
          <button
            type="button"
            onClick={fetchData}
            className="shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 font-medium hover:bg-red-100"
          >
            重試
          </button>
        </div>
      )}

      {/* Traditional View */}
      {viewMode === 'traditional' && (
        <>
          {loading && listPending && <Loader label="讀取元件週推資料" className="flex-1" />}
          {listError && items.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div>
              <div className="text-sm font-semibold text-red-700">元件週推資料讀取失敗</div>
              <div className="mt-1 text-xs text-red-600">{listError}</div>
            </div>
            <button
              type="button"
              onClick={fetchData}
              className="rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              重試
            </button>
          </div>
          )}
          <div className={listPending ? 'hidden' : 'contents'}>
          <ComponentWeeklyTraditionalView
            items={items}
            active={!listPending}
            mrpType={mrpType}
            textSize={textSize}
            frozenCount={frozenCols}
            fetchAllForExport={fetchAllForExport}
            columnVisibility={colVis.visibility}
            columnFilters={filtering.filterState.columnFilters}
            onSetColumnFilter={filtering.setColumnFilter}
            onRemoveColumnFilter={filtering.removeColumnFilter}
            sortFields={sorting.sortState.fields}
            onAddSort={sorting.prioritizeSort}
            onRemoveSort={sorting.removeSort}
            onToggleColumn={colVis.toggleColumn}
            onFreezeToColumn={freezeToComponentColumn}
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
            ) : listError && items.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="py-8 text-center">
                  <div className="text-sm font-semibold text-red-700">元件週推資料讀取失敗</div>
                  <div className="mt-1 text-xs text-red-600">{listError}</div>
                  <button
                    type="button"
                    onClick={fetchData}
                    className="mt-3 rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    重試
                  </button>
                </td>
              </tr>
            ) : listPending ? null : items.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-center py-8 text-slate-400">
                  查無資料，請先執行 MRP。
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const rowKey = componentWeeklyRowKey(item);
                const shortagePresentation = presentComponentWeeklyShortage(item);
                const purchasePresentation = presentComponentWeeklyPurchaseAction(item);
                return (
                  <Fragment key={rowKey}>
                  <tr
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => toggleExpand(item)}
                  >
                    <td className="text-center text-slate-400">
                      {expandedRowKey === rowKey ? '▼' : '▶'}
                    </td>
                    {colVis.visibility['materialPartNo'] !== false && (
                      <td data-col="materialPartNo" data-value={item.materialPartNo ?? ''} className="font-mono text-xs font-medium">
                        {mergeDb && item.dbSource && <DbSourceBadge source={item.dbSource} />}{' '}
                        {item.materialPartNo}
                      </td>
                    )}
                    {colVis.visibility['unit'] !== false && (
                      <td data-col="unit" data-value={item.unit ?? ''} className="text-xs text-center">{item.unit || '—'}</td>
                    )}
                    {colVis.visibility['goodStockPc'] !== false && (
                      <td data-col="goodStockPc" data-value={String(item.goodStockPc ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'inventory', focusMetric: 'initialStock' });
                          }}
                          title="查看良品庫存批號"
                        >
                          {fmtNum(item.goodStockPc)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['goodStockKg'] !== false && (
                      <td data-col="goodStockKg" data-value={String(item.goodStockKg ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'inventory', focusMetric: 'initialStock' });
                          }}
                          title="查看良品庫存批號"
                        >
                          {fmtNum(item.goodStockKg, 2)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['badStockPc'] !== false && (
                      <td data-col="badStockPc" data-value={String(item.badStockPc ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'inventory', focusMetric: 'badStock' });
                          }}
                          title="查看不良庫存批號"
                        >
                          {fmtNum(item.badStockPc)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['badStockKg'] !== false && (
                      <td data-col="badStockKg" data-value={String(item.badStockKg ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'inventory', focusMetric: 'badStock' });
                          }}
                          title="查看不良庫存批號"
                        >
                          {fmtNum(item.badStockKg, 2)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['avgWeeklyUsage'] !== false && (
                      <td data-col="avgWeeklyUsage" data-value={String(item.avgWeeklyUsage ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'calculation', focusMetric: 'avgWeeklyUsage' });
                          }}
                          title="查看平均用量計算來源"
                        >
                          {fmtNum(item.avgWeeklyUsage, 1)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['stockWeeks'] !== false && (
                      <td data-col="stockWeeks" data-value={String(item.stockWeeks ?? '')} className="text-right font-mono text-xs">
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700"
                          onClick={(event) => {
                            event.stopPropagation();
                            openUsageDetail(item, { initialTab: 'calculation', focusMetric: 'stockWeeks' });
                          }}
                          title="查看庫存週數計算來源"
                        >
                          {fmtNum(item.stockWeeks, 1)}
                        </button>
                      </td>
                    )}
                    {colVis.visibility['purchaseLeadWeeks'] !== false && (
                      <td
                        data-col="purchaseLeadWeeks"
                        data-value={item.purchaseLeadWeeksConfigured === false ? '' : String(item.purchaseLeadWeeks ?? '')}
                        className="text-center text-xs"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ComponentWeeklyLeadTimeButton
                          summary={item}
                          onClick={() => openUsageDetail(item, { initialTab: 'calculation', focusMetric: 'purchaseLeadWeeks' })}
                        />
                      </td>
                    )}
                    {colVis.visibility['shortageStartWeek'] !== false && (
                      <td
                        data-col="shortageStartWeek"
                        data-value={item.shortageStartWeek != null ? String(item.shortageStartWeek) : ''}
                        className="text-center text-xs"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ComponentWeeklyShortageButton
                          summary={item}
                          onClick={() => openUsageDetail(item, {
                            weekIndex: item.shortageStartWeek,
                            weekLabel: item.shortageStartWeek === 0
                              ? '前期'
                              : item.shortageStartWeek === null
                                ? '全部週期'
                                : `W${item.shortageStartWeek}`,
                            initialTab: 'calculation',
                            focusMetric: 'shortageStartWeek',
                          })}
                        />
                      </td>
                    )}
                    {colVis.visibility['weeksUntilOrder'] !== false && (
                      <td
                        data-col="weeksUntilOrder"
                        data-value={item.weeksUntilOrder != null ? String(item.weeksUntilOrder) : ''}
                        className="text-center text-xs"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ComponentWeeklyPurchaseActionButton
                          summary={item}
                          onClick={() => openPurchaseActionDetail(item)}
                        />
                      </td>
                    )}
                  </tr>

                  {/* Expanded period detail */}
                  {expandedRowKey === rowKey && (
                    <tr key={`${rowKey}-detail`} data-detail="true">
                      <td colSpan={colSpan} className="bg-slate-50 p-4">
                        {/* Header info */}
                        <div className="mb-3 p-3 bg-white border border-slate-200 rounded-lg text-xs grid grid-cols-2 md:grid-cols-4 gap-2">
                          <div><span className="text-slate-500">MRP版本: </span><span className="font-mono font-medium text-blue-700">{runVersionCode || '—'}</span></div>
                          <div><span className="text-slate-500">跑表日期: </span><span className="font-medium">{runDate || '—'}</span></div>
                          <div><span className="text-slate-500">料號: </span><span className="font-mono font-medium text-blue-600">{item.materialPartNo}</span></div>
                          <div><span className="text-slate-500">類型: </span><span className="font-medium">{MRP_TYPE_LABELS[mrpType]}</span></div>
                          <div><span className="text-slate-500">單位: </span><span className="font-medium">{item.unit || '—'}</span></div>
                          <div><span className="text-slate-500">良品庫存: </span><span className="font-mono font-bold">{item.unit?.toUpperCase() === 'KG' ? fmtNum(item.goodStockKg, 2) + ' kg' : fmtNum(item.goodStockPc) + ' pc'}</span></div>
                          <div><span className="text-slate-500">平均用量/週: </span><span className="font-mono">{fmtNum(item.avgWeeklyUsage, 1)}</span></div>
                          <div><span className="text-slate-500">庫存週數: </span><span className="font-mono">{fmtNum(item.stockWeeks, 1)}</span></div>
                          <div><span className="text-slate-500">採購前置期: </span><span className="font-medium">{formatComponentWeeklyLeadTime(item)}</span></div>
                          <div>
                            <span className="text-slate-500">缺貨: </span>
                            <span className={shortagePresentation.tone === 'safe' ? 'font-bold text-green-600' : 'font-bold text-red-600'}>
                              {shortagePresentation.label}{shortagePresentation.detail ? `／${shortagePresentation.detail}` : ''}
                            </span>
                          </div>
                          <div><span className="text-slate-500">採購處置: </span><span className="font-semibold">{purchasePresentation.label}{purchasePresentation.detail ? `／${purchasePresentation.detail}` : ''}</span></div>
                        </div>

                        {/* 28-week period table */}
                        <WeeklyPeriodTable
                          periods={periodData}
                          onOpenDetail={(period, initialTab, focusMetric) => {
                            openUsageDetail(item, {
                              weekIndex: period.weekIndex,
                              weekLabel: period.weekLabel || `W${period.weekIndex}`,
                              initialTab,
                              focusMetric,
                            });
                          }}
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
      {usageDetailTarget && (
        <ComponentWeeklyUsageDrawer
          target={usageDetailTarget}
          onClose={() => setUsageDetailTarget(null)}
        />
      )}
    </div>
  );
}

function UsageWarningBanner({ warnings }: { warnings: UsageWarnings }) {
  const [open, setOpen] = useState(false);
  const hasWarnings = warnings.count > 0;
  const blockingCount = warnings.blockingCount ?? warnings.count;
  const reviewCount = warnings.reviewCount ?? 0;
  const hasIncompleteSources = (warnings.incompleteSources || 0) > 0;
  const showSource = warnings.items.some((item) => item.dbSource);
  if (!hasWarnings && !hasIncompleteSources) return null;

  return (
    <div data-usage-warning className="border border-amber-300 bg-amber-50 text-amber-950 rounded-md overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-1 px-3 py-1 text-xs">
        <div>
          {hasWarnings && (
            <span className="font-medium">
              資料異常：
              {blockingCount > 0 && `${blockingCount.toLocaleString()} 筆無法確認剩餘用量，未納入需求計算。`}
              {reviewCount > 0 && `${reviewCount.toLocaleString()} 筆主子表狀態不一致，仍依領料子表計算。`}
            </span>
          )}
          {hasIncompleteSources && (
            <span className={hasWarnings ? 'ml-2 text-amber-800' : 'font-medium'}>
              {warnings.incompleteSources} 個資料來源無法讀取異常明細。
            </span>
          )}
        </div>
        {warnings.items.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="font-medium text-amber-900 underline decoration-dotted underline-offset-2 hover:text-amber-700"
          >
            {open ? '隱藏明細' : `查看明細 (${Math.min(warnings.items.length, 50)})`}
          </button>
        )}
      </div>
      {open && warnings.items.length > 0 && (
        <div className="max-h-64 overflow-auto border-t border-amber-200 bg-white">
          <table className="w-full text-xs border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-amber-100 text-amber-950">
              <tr>
                {showSource && <th className="px-3 py-1.5 text-left border-b border-amber-200">來源</th>}
                <th className="px-3 py-1.5 text-left border-b border-amber-200">工令單</th>
                <th className="px-3 py-1.5 text-left border-b border-amber-200">元件料號</th>
                <th className="px-3 py-1.5 text-right border-b border-amber-200">原工令用量</th>
                <th className="px-3 py-1.5 text-left border-b border-amber-200">原因</th>
              </tr>
            </thead>
            <tbody>
              {warnings.items.map((item, index) => {
                const href = buildSourceRecordUrl('work-order-bom', item.sourceRecordId);
                return (
                  <tr key={`${item.dbSource || 'local'}-${item.sourceRecordId || index}`} className="odd:bg-white even:bg-amber-50/40">
                    {showSource && <td className="px-3 py-1.5 border-b border-amber-100">{item.dbSource || '—'}</td>}
                    <td className="px-3 py-1.5 border-b border-amber-100 font-mono whitespace-nowrap">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                          {item.woNumber || '開啟 BOM 紀錄'}
                        </a>
                      ) : item.woNumber || '—'}
                    </td>
                    <td className="px-3 py-1.5 border-b border-amber-100 font-mono whitespace-nowrap">{item.componentNo || '—'}</td>
                    <td className="px-3 py-1.5 border-b border-amber-100 text-right tabular-nums whitespace-nowrap">
                      {Number(item.plannedUsage).toLocaleString()} {item.unit || ''}
                    </td>
                    <td className="px-3 py-1.5 border-b border-amber-100">{usageWarningLabel(item.reason)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {warnings.count > warnings.items.length && (
            <div className="px-3 py-2 text-[11px] text-amber-800">
              僅顯示前 {warnings.items.length} 筆，共 {warnings.count.toLocaleString()} 筆。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function usageWarningLabel(reason: string | null): string {
  if (reason && reason in ISSUED_QTY_ERROR_LABELS) {
    return ISSUED_QTY_ERROR_LABELS[reason as IssuedQtyError];
  }
  return reason || '無法確認領料資料';
}

// ============================================================
// Weekly Period Breakdown Component
// ============================================================

function WeeklyPeriodTable({
  periods,
  onOpenDetail,
}: {
  periods: PeriodDetail[];
  onOpenDetail: (
    period: PeriodDetail,
    initialTab: ComponentWeeklyUsageDetailTab,
    focusMetric: ComponentWeeklyUsageMetric,
  ) => void;
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
                {p.weekLabel || `W${p.weekIndex}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Remaining Stock row stays first in the synthetic weekly layout. */}
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
                      className="w-full text-right underline decoration-emerald-500 decoration-dotted underline-offset-2 hover:text-blue-700"
                      onClick={() => onOpenDetail(p, 'calculation', 'remainingStock')}
                      title="查看剩餘庫存計算來源"
                    >
                      {fmtVal(p.remainingStock) || '0'}
                    </button>
                  )}
                </td>
              );
            })}
          </tr>

          {/* Usage row */}
          <tr>
            <td className={`px-2 py-1 font-medium ${ROW_COLORS.usage.bg} ${ROW_COLORS.usage.text} sticky left-0 z-10 border border-slate-200`}>
              {ROW_COLORS.usage.label}
            </td>
            {periods.map((p) => (
              <td key={p.weekIndex} className="px-2 py-1 text-right font-mono border border-slate-200 bg-orange-50">
                <button
                  type="button"
                  className="w-full text-right underline decoration-orange-400 decoration-dotted underline-offset-2 hover:text-blue-700"
                  onClick={() => onOpenDetail(p, 'work-orders', 'usage')}
                  title="查看工令用料來源"
                >
                  {fmtVal(p.usage) || '0'}
                </button>
              </td>
            ))}
          </tr>

          {/* Receipts row */}
          <tr>
            <td className={`px-2 py-1 font-medium ${ROW_COLORS.receipts.bg} ${ROW_COLORS.receipts.text} sticky left-0 z-10 border border-slate-200`}>
              {ROW_COLORS.receipts.label}
            </td>
            {periods.map((p) => (
              <td key={p.weekIndex} className="px-2 py-1 text-right font-mono border border-slate-200 bg-green-50">
                <button
                  type="button"
                  className="w-full text-right underline decoration-green-500 decoration-dotted underline-offset-2 hover:text-blue-700"
                  onClick={() => onOpenDetail(p, 'supply', 'receipts')}
                  title="查看預納／進貨來源"
                >
                  {fmtVal(p.receipts) || '0'}
                </button>
              </td>
            ))}
          </tr>
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
