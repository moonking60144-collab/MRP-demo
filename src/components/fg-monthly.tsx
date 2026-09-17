'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { AlertTriangle, ChevronRight, ExternalLink, RotateCw, X } from 'lucide-react';
import { TraditionalView, FG_MAX_FROZEN } from './fg-monthly-traditional';
import { FgMaterialReminderPanel, MaterialReminderButton, useMaterialReminders } from './fg-material-reminder';
import {
  useColumnVisibility,
  useRunCustomerCodeColumns,
  useTableFiltering,
  useTablePresets,
  useTableSorting,
} from './data-table/hooks';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { useToast } from './toast';
import { useConfirm } from './confirm-dialog';
import { friendlyTransferError } from '@/lib/transfer-error';
import { TRANSFER_STATUS, isTransferBlocked, type TransferStatus } from '@/lib/transfer-state';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheSet, cacheIsFresh, cacheInvalidate } from '@/lib/swr-cache';
import { ListRequestError } from './ui/list-request-error';
import { useReportPage } from './ui/use-report-page';
import { useReportScroll } from './ui/use-report-scroll';

interface FgListCache { items: FgMonthlyItem[]; total: number; runVersionCode: string | null; runDate: string | null; sources: DbSource[] }
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { loadColumnFilterOptions } from './data-table/column-filter-options-client';
import { MachineFilter } from './fg-monthly-machine-filter';
import {
  FG_MONTHLY_DETAILED_COLUMNS,
  FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
  FG_TRAD_WAREHOUSE,
} from './data-table/column-defs/fg-monthly-columns';
import type { QuickFilterOption, TablePreset } from './data-table/types';
import { TextSizeControl, TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { FrozenColsControl } from './ui/frozen-cols-control';
import { usePersistedState } from './ui/use-persisted-state';
import { TablePagination } from './ui/table-pagination';
import { KeyboardScrollHelp } from './ui/keyboard-scroll-help';
import { DbSourceBadge } from './ui/db-source-badge';
import { FgMonthlySourcePanel } from './fg-monthly-source-panel';
import { TransferReconciliationControls } from './transfer-reconciliation-controls';
import {
  ProductionPlanWorkOrderAction,
  type ProductionPlanWorkOrderUpdate,
} from './production-plan-work-order-action';
import type { WorkOrderStatus } from '@/lib/work-order-state';
import { SharedBalanceValue, SharedErpLegend } from './shared-erp-indicator';
import {
  StockCalculationDrawer,
  StockCalculationValue,
} from './fg-stock-calculation-drawer';
import {
  buildStockCalculationDetail,
  type StockBalanceKind,
  type StockCalculationDetail,
} from '@/lib/mrp/fg-stock-calculation';
import {
  FG_MONTHLY_COLUMN_VISIBILITY_KEY,
  migrateFgMonthlyColumnVisibility,
} from '@/lib/mrp/fg-monthly-column-visibility';
import {
  canAutoRecalculatePlanQty,
  computeFulfillmentPlanQty,
  computeMaterialKg,
} from '@/lib/mrp/fg-plan-suggestion';
import { parsePositivePlanQty } from '@/lib/mrp/fg-plan-input';
import {
  WarehouseStockDrawer,
  WarehouseStockValue,
  type WarehouseStockRequest,
} from './warehouse-stock-detail';
import {
  WAREHOUSE_STOCK_GROUPS,
  type WarehouseStockFilter,
  type WarehouseStockGroup,
} from '@/lib/mrp/warehouse-stock';
import {
  FG_MONTHLY_ORDER_ATTRIBUTION_LABELS,
  FG_MONTHLY_SOURCE_METRIC_LABELS,
  fgMonthlyDemandExplanation,
  fgMonthlySourcePeriod,
  fgMonthlySourceTypes,
  type FgMonthlyPeriodSourceRequest,
  type FgMonthlyOrderAttribution,
  type FgMonthlySourceMetric,
  type FgMonthlySummarySourceMetric,
  type FgMonthlySourceType,
} from '@/lib/mrp/fg-monthly-source-detail';
import {
  fetchFgMonthlyMembersByIdentity,
  fetchFgMonthlyPeriodsByIdentity,
  fgMonthlyPeriodsCacheKey,
} from '@/lib/mrp/fg-monthly-period-client';
import { hasCompletePeriodMap } from '@/lib/mrp/list-periods-contract';
import { buildRagicRecordUrl, type RagicRecordType } from '@/lib/ragic-record-links';
import {
  ORDER_DEMAND_ANOMALY_LABELS,
  ORDER_DEMAND_BASIS_LABELS,
  type OrderDemandAnomaly,
  type OrderDemandContribution,
  type OrderDemandSummary,
} from '@/lib/mrp/order-demand-contract';

const FG_MONTHLY_PERSONALIZATION_COLUMN_IDS = new Set(
  [...FG_MONTHLY_DETAILED_COLUMNS, ...FG_MONTHLY_TRADITIONAL_ALL_COLUMNS]
    .map((column) => column.id),
);

interface DbSource {
  mode: string;
  runVersionCode: string;
  runDate: string;
  runId: number;
}

interface FgMonthlyItem {
  materialReminderDbSource?: string;
  id: number;
  mrpRunId: number;
  partVersion: string;
  customerPartNo: string | null;
  customerCode: string | null;
  erpPartNo: string | null;
  sharedErpCount: number;
  usesSharedErpPool: boolean;
  forgingMachine: string | null;
  firstProcess: string | null;
  surfaceTreatment: string | null;
  forgingParent: string | null;
  processBomVersion: string | null;
  productStatus: string | null;
  stockPeriods: number | null;
  sortGroup: number | null;
  unitWeightG: number;
  mainMaterialKg: number;
  currentStockPc: number;
  wfgStockPc: number | null;
  ye1StockPc: number | null;
  inventoryValidationAvailable: boolean;
  inventoryAnomalyCount: number;
  wfgInventoryAnomalyCount: number;
  ye1InventoryAnomalyCount: number;
  inventoryAnomalyDiffPc: number;
  inventoryAnomalyErpPartNos: string[];
  badStockPc: number;
  skipFgInventory: boolean;
  woScheduled: number;
  woUnscheduled: number;
  woTotal: number;
  planReportedQty: number;
  planClosedQty: number;
  priorPlanQty: number;
  shortageStartPeriod: number | null;
  shortageStartPeriodNoPlan: number | null;
  missingForecastPeriods: number;
  shouldPlanProduction: boolean;
  priorUnshippedQty: number;
  totalUnshippedQty: number;
  totalPlanSupply: number;
  lastPeriodRemainingNoPlan: number | null;
  dbSource?: string;
  /** True when this row is a 主件聚合 grouped result. */
  isAggregated?: boolean;
  /** part_versions of the variants merged into this aggregated row (only set when isAggregated). */
  aggregatedMembers?: string[];
}

interface PeriodDetail {
  periodIndex: number;
  periodLabel: string;
  periodStart?: string;
  remainingStock: number;
  remainingNoPlan: number;
  demandIntegrated: number;
  ordersUnshipped: number;
  ordersTotal: number;
  forecastQty: number;
  plannedOutput: number;
}

/**
 * 合計列資料 —— server 對「整個篩選結果」做的 SUM（不只當前頁）。
 * 此型別是單一來源；fg-monthly-traditional.tsx 以 `import type` 取用。
 * 數值已在 API 端轉成 number（見 normalizeFgMonthlyDecimals / numOrNull）。
 */
export interface FgMonthlyTotals {
  preperiod: Record<string, number | null>;
  periods: Array<Record<string, number | null>>;
}

interface PlanSuggestion {
  planSequence: number;
  targetStartPeriod: number;
  fulfillToPeriod: number;
  suggestedQty: number;
  completionDate: string;
  materialWeightKg: number;
  bufferPct: number;
  useManualQty: boolean;
  isTransferred: boolean;
  transferStatus?: TransferStatus;
  transferError?: string | null;
  ragicPlanNo?: string | null;
  ragicUrl?: string | null;
  transferId?: number | null;
  ragicRecordId?: string | null;
  workOrderStatus?: WorkOrderStatus | null;
  workOrderError?: string | null;
  workOrderCompletedAt?: string | null;
}

interface FgMonthlySourceSection {
  type: FgMonthlySourceType;
  records: Record<string, unknown>[];
  priorRecords: Record<string, unknown>[];
  total: number;
  contractVersion?: string;
  summary?: OrderDemandSummary;
  priorSummary?: OrderDemandSummary;
}

type FgMonthlyPeriodSourceMetric = Extract<FgMonthlySourceMetric, keyof PeriodDetail>;

function isFgMonthlySourceMetric(
  value: keyof PeriodDetail,
): value is FgMonthlyPeriodSourceMetric {
  return value === 'demandIntegrated'
    || value === 'ordersUnshipped'
    || value === 'forecastQty'
    || value === 'plannedOutput'
    || value === 'ordersTotal';
}

function FgMonthlySummarySourceValue({
  item,
  metric,
  onOpen,
}: {
  item: FgMonthlyItem;
  metric: FgMonthlySummarySourceMetric;
  onOpen: (request: FgMonthlyPeriodSourceRequest) => void;
}) {
  const value = Number(item[metric]) || 0;
  const label = FG_MONTHLY_SOURCE_METRIC_LABELS[metric];
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen({
          partVersion: item.partVersion,
          memberPartVersions: item.isAggregated ? item.aggregatedMembers : undefined,
          mrpRunId: item.mrpRunId,
          dbSource: item.dbSource,
          metric,
          period: fgMonthlySourcePeriod(metric, value, null, label),
        });
      }}
      className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
        value === 0 ? 'text-slate-300' : ''
      }`}
      title={`查看${label}來源明細`}
    >
      {value.toLocaleString()}
    </button>
  );
}

type ViewMode = 'detailed' | 'traditional';

// ============================================================
// Color scheme from Ragic Form 22:
//   黃(生產計畫) - Yellow for Production Plans
//   紫(整合需求) - Purple for Integrated Demand
//   深綠(剩餘庫存) - Dark Green for Remaining Stock
//   藍(預示量) - Blue for Forecast
//   淺綠(訂單未銷) - Light Green for Unshipped Orders
//   灰(訂單總量) - Gray for recognized order demand
// ============================================================
const ROW_COLORS = {
  remainingStock: { bg: 'bg-emerald-800', text: 'text-white', label: '剩餘庫存' },
  demandIntegrated: { bg: 'bg-purple-600', text: 'text-white', label: '[需求整合]' },
  ordersUnshipped: { bg: 'bg-green-200', text: 'text-green-900', label: '[訂單未結]' },
  forecastQty: { bg: 'bg-blue-500', text: 'text-white', label: '[預示量]' },
  plannedOutput: { bg: 'bg-yellow-300', text: 'text-yellow-900', label: '[計畫前期產出]' },
  ordersTotal: { bg: 'bg-gray-300', text: 'text-gray-800', label: '[訂單總量]' },
  remainingNoPlan: { bg: 'bg-teal-700', text: 'text-white', label: '剩餘庫存(無計劃量)' },
};

// Default buffer % — will be configurable from Settings later
const DEFAULT_BUFFER_PCT = 10;

const MACHINE_FILTER_OPTIONS: QuickFilterOption[] = [
  { value: 'all', label: '全部' },
  { value: 'internal', label: '自製' },
  { value: 'supplier', label: '外製 []' },
];

export function FgMonthlyClient() {
  const { selectedRunId, isLoading: versionLoading } = useMrpVersion();
  const [items, setItems] = useState<FgMonthlyItem[]>([]);
  const materialReminders = useMaterialReminders(items);
  const [total, setTotal] = useState(0);
  const [totalsResult, setTotalsResult] = useState<{ key: string; data: FgMonthlyTotals } | null>(null);
  const [shortageOnly, setShortageOnly] = usePersistedState('mrp_shortageOnly_fg', false);
  const [showIgnored, setShowIgnored] = usePersistedState('mrp_showIgnored_fg', false);
  const [excludeTestErp, setExcludeTestErp] = usePersistedState('mrp_excludeTestErp_fg', true);
  // 方向鍵捲動表格的步長（px）— 靈敏度
  const [kbScrollStep, setKbScrollStep] = usePersistedState('mrp_kbScrollStep_fg', 120);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const [periodData, setPeriodData] = useState<PeriodDetail[]>([]);
  const [suggestions, setSuggestions] = useState<PlanSuggestion[]>([]);
  // key 用 _v2 —— 移除「簡易」view 後，舊 localStorage 可能存著失效的 'simple'，
  // 換 key 直接讓既有使用者回到預設 'traditional'。
  const [viewMode, setViewMode] = usePersistedState<ViewMode>('mrp_viewMode_fg_v2', 'traditional');
  const [textSize, setTextSize] = usePersistedState('mrp_textSize_fg', 0);
  // Default 4 (客戶代碼/客料版本/客戶料號/ERP料號) — narrowest viable on 1366-wide
  // screens. Higher values quickly eat horizontal space because frozen columns
  // are 80–220 px each. Existing users still see their persisted value (e.g. 8 or
  // 12) until they manually adjust or clear localStorage.mrp_frozenCols_fg.
  const [frozenCols, setFrozenCols] = usePersistedState('mrp_frozenCols_fg', 4);
  const [currentStockPc, setCurrentStockPc] = useState(0);
  const [warehouseStockRequest, setWarehouseStockRequest] = useState<WarehouseStockRequest | null>(null);
  const [displayMonths, setDisplayMonths] = usePersistedState('mrp_displayMonths_fg', 12);
  const [runVersionCode, setRunVersionCode] = useState<string | null>(null);
  const [runDate, setRunDate] = useState<string | null>(null);
  const [machineCategory, setMachineCategory] = usePersistedState('mrp_machineCategory_fg', 'all');
  const [activeMachine, setActiveMachine] = usePersistedState<string | null>('mrp_activeMachine_fg', null);
  const [machines, setMachines] = useState<string[]>([]);
  // 合併 DB 開關移到「設定」頁；此處僅讀取
  const [mergeDb] = usePersistedState('mrp_mergeDb', false);
  const [aggregated, setAggregated] = usePersistedState('mrp_aggregated_fg', false);
  // 傳統 view 樣式切換：'classic' = 既有版面；'ragic' = 比照 Ragic 條件式格式
  // （斑馬紋 + 不良品庫存 > 0 紅 + 開始缺貨期數 cell 按值分級染色）。純前端 UI，
  // 不影響業務數值。lift up 到這層是為了讓 toolbar 切換器放主視圖區（與「視圖」並排）。
  const [tableStyle, setTableStyle] = usePersistedState<'classic' | 'ragic'>('mrp_trad_style', 'classic');
  // 製程版本樹: when on, render an extra leftmost column in 傳統 view that
  // visualises each row's process_bom_version step path, with shared steps
  // between adjacent rows in the same 鍛造母件 group rendered as thin trunk
  // lines and divergence steps rendered as solid coloured boxes — making
  // the lineage of each part visible at a glance.
  const [showTree, setShowTree] = usePersistedState('mrp_showTree_fg', false);
  const [sources, setSources] = useState<DbSource[]>([]);
  const [mergedCustomerCodes, setMergedCustomerCodes] = useState<string[]>([]);
  // machineFilter is what gets sent to the API
  const machineFilter = activeMachine || machineCategory;

  // Toolbar responsive chrome: secondary controls collapse into a 更多 popover
  // below `xl`; the colour legend collapses on narrow screens too.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

  // 每頁筆數 — 上限 200，避免一次撈太多影響效能
  const [limit, setLimit] = usePersistedState('mrp_pageSize_fg', 50);

  // Column definitions depend on view mode
  const baseColumns = viewMode === 'traditional'
    ? FG_MONTHLY_TRADITIONAL_ALL_COLUMNS
    : FG_MONTHLY_DETAILED_COLUMNS;
  const columns = useRunCustomerCodeColumns(
    baseColumns,
    selectedRunId,
    mergeDb ? mergedCustomerCodes : undefined,
    true,
  );
  const tableId = viewMode === 'traditional'
    ? 'fg_monthly_traditional'
    : 'fg_monthly_detailed';

  const sorting = useTableSorting([
    { id: 'forgingParent', direction: 'asc', label: '鍛造母件' },
    { id: 'customerPartNo', direction: 'asc', label: '客戶料號' },
    { id: 'erpPartNo', direction: 'asc', label: 'ERP料號' },
  ], 'mrp_sort_fg', FG_MONTHLY_PERSONALIZATION_COLUMN_IDS);
  const traditionalSortFieldIds = useMemo(
    () => sorting.sortState.fields.map((field) => field.id),
    [sorting.sortState.fields],
  );
  const filtering = useTableFiltering(
    undefined,
    'mrp_filter_fg',
    FG_MONTHLY_PERSONALIZATION_COLUMN_IDS,
  );
  useLayoutEffect(() => {
    migrateFgMonthlyColumnVisibility(window.localStorage);
  }, []);
  const colVis = useColumnVisibility(columns, FG_MONTHLY_COLUMN_VISIBILITY_KEY, {
    defaultAllVisible: true,
    persistHiddenOnly: true,
  });
  const freezeToFgColumn = useCallback((columnId: string) => {
    const visibleColumns = FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.filter(
      (column) => !column.id.startsWith('period.')
        && !FG_TRAD_WAREHOUSE.some((warehouseColumn) => warehouseColumn.key === column.id)
        && colVis.visibility[column.id] !== false,
    );
    const index = visibleColumns.findIndex((column) => column.id === columnId);
    if (index >= 0) setFrozenCols(Math.min(index + 1, FG_MAX_FROZEN));
  }, [colVis.visibility, setFrozenCols]);
  const columnHeader = useTableColumnHeaderMenu({
    columnFilters: filtering.filterState.columnFilters,
    sortFields: sorting.sortState.fields,
    onSetFilter: filtering.setColumnFilter,
    onRemoveFilter: filtering.removeColumnFilter,
    onPrioritizeSort: sorting.prioritizeSort,
    onRemoveSort: sorting.removeSort,
    onToggleColumn: colVis.toggleColumn,
    onFreezeToColumn: freezeToFgColumn,
    canFreezeColumn: (columnId) => (
      !columnId.startsWith('period.')
      && !FG_TRAD_WAREHOUSE.some((column) => column.key === columnId)
    ),
    optionContext: {
      tableId,
      runId: selectedRunId,
      mergeDb,
      globalSearch: filtering.queryGlobalSearch,
      columnFilters: filtering.filterState.columnFilters,
      fixedScope: {
        shortageOnly,
        includeIgnored: showIgnored,
        excludeTest: excludeTestErp,
        machineFilter,
        aggregated,
      },
    },
    loadOptions: loadColumnFilterOptions,
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

  const { page, setPage, queryReady } = useReportPage('mrp_page_fg', JSON.stringify([
    selectedRunId, mergeDb, filtering.queryGlobalSearch, filtering.filterQueryParams,
    sorting.sortQueryParam, machineFilter, shortageOnly, showIgnored, excludeTestErp, aggregated, limit,
  ]), !versionLoading && filtering.hydrated && sorting.hydrated);

  // 方向鍵捲動表格 — 焦點不在輸入框時，直接捲動目前 view 的表格容器（data-mrp-scroll）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const el = document.querySelector('[data-mrp-scroll]');
      if (!el) return;
      e.preventDefault();
      if (k === 'ArrowUp') el.scrollBy({ top: -kbScrollStep });
      else if (k === 'ArrowDown') el.scrollBy({ top: kbScrollStep });
      else if (k === 'ArrowLeft') el.scrollBy({ left: -kbScrollStep });
      else el.scrollBy({ left: kbScrollStep });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbScrollStep]);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);

  // 與 fetchData 共用的 cache key（= fetch URL，含所有 filter/sort/page/runId）。抽出來
  // 確保 seed 與 fetch 用同一字串、不漂移。
  const buildListKey = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filtering.queryGlobalSearch) params.set('search', filtering.queryGlobalSearch);
    if (shortageOnly) params.set('shortageOnly', 'true');
    if (showIgnored) params.set('includeIgnored', 'true');
    if (excludeTestErp) params.set('excludeTest', 'true');
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (machineFilter !== 'all') params.set('machineFilter', machineFilter);
    if (mergeDb) params.set('merge', 'true');
    if (aggregated) params.set('aggregated', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    if (viewMode === 'traditional' && !mergeDb) params.set('includePeriods', '1');
    for (const [k, v] of Object.entries(filtering.filterQueryParams)) params.set(k, v);
    return `/api/fg-monthly?${params}`;
  }, [page, limit, filtering.queryGlobalSearch, filtering.filterQueryParams, sorting.sortQueryParam, shortageOnly, showIgnored, excludeTestErp, machineFilter, mergeDb, aggregated, selectedRunId, viewMode]);

  const listPending = !queryReady || loadedListKey !== buildListKey();
  useReportScroll('mrp_scroll_fg-monthly', buildListKey(), !loading && !listPending);

  // 切頁回來時在 paint 前先鋪上快取 stale → 零 spinner 空窗。merge 模式不快取（無 run 維度、無從失效）。
  useLayoutEffect(() => {
    fetchAbortRef.current?.abort();
    if (!queryReady) return;
    setListError(null);
    const cached = !mergeDb ? cachePeek<FgListCache>(buildListKey()) : undefined;
    if (cached) {
      setItems(cached.items);
      setLoadedListKey(buildListKey());
      setTotal(cached.total);
      if (cached.runVersionCode) setRunVersionCode(cached.runVersionCode);
      if (cached.runDate) setRunDate(cached.runDate);
      setSources(cached.sources);
      setLoading(false);
    } else {
      setTotal(0);
      setLoading(true);
    }
  }, [buildListKey, mergeDb, queryReady]);

  const fetchData = useCallback(async () => {
    if (!queryReady) return;
    // 取消上一個還沒回來的請求，避免快速切 filter/翻頁時舊回應蓋掉新資料
    fetchAbortRef.current?.abort();
    const ac = new AbortController();
    fetchAbortRef.current = ac;
    setListError(null);
    const key = buildListKey();
    const cached = !mergeDb ? cachePeek<FgListCache>(key) : undefined;
    if (cached) {
      // 已有 stale（layout effect 已鋪）→ 夠新就不打網路；過期則靜默 revalidate（不顯 spinner）
      if (cacheIsFresh(key)) { if (fetchAbortRef.current === ac) setLoading(false); return; }
    } else {
      setLoading(true); // 真 miss 才顯 spinner
    }
    try {
      const res = await fetch(key, { signal: ac.signal });
      const json = await res.json();
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      if (!res.ok) throw new Error(json.error || `成品月推資料讀取失敗 (${res.status})`);
      const responseItems = (json.items || []) as FgMonthlyItem[];
      if (
        !mergeDb
        && hasCompletePeriodMap(responseItems.map((item) => item.partVersion), json.periods)
      ) {
        const periodsKey = fgMonthlyPeriodsCacheKey(responseItems, aggregated);
        if (periodsKey) cacheSet(periodsKey, json.periods);
      }
      setItems(responseItems);
      setLoadedListKey(key);
      setTotal(json.total || 0);
      if (json.runVersionCode) setRunVersionCode(json.runVersionCode);
      if (json.runDate) setRunDate(json.runDate);
      setSources(json.sources || []);
      if (mergeDb) setMergedCustomerCodes(json.filterOptions?.customerCode || []);
      if (!mergeDb) {
        cacheSet<FgListCache>(key, {
          items: json.items || [], total: json.total || 0,
          runVersionCode: json.runVersionCode ?? null, runDate: json.runDate ?? null,
          sources: json.sources || [],
        });
      }
    } catch (err) {
      if (ac.signal.aborted || fetchAbortRef.current !== ac) return;
      setListError(err instanceof Error ? err.message : '成品月推資料讀取失敗');
    } finally {
      if (!ac.signal.aborted && fetchAbortRef.current === ac) setLoading(false);
    }
  }, [aggregated, buildListKey, mergeDb, queryReady]);

  useEffect(() => {
    fetchData();
    return () => fetchAbortRef.current?.abort();
  }, [fetchData]);

  // 合計列(totals)獨立抓 —— 依篩選、不依排序或分頁。所以排序／翻頁不會重抓 totals；
  // 且只在傳統 view 抓（詳細 view 沒有合計列）。見 code review item 1。
  const totalsAbortRef = useRef<AbortController | null>(null);
  const totalsKey = useMemo(() => {
    const params = new URLSearchParams(buildListKey().split('?')[1]);
    for (const name of ['sortFields', 'includePeriods', 'merge']) params.delete(name);
    params.set('totals', 'true');
    params.set('page', '1');
    params.set('limit', '1');
    params.sort();
    return `/api/fg-monthly?${params}`;
  }, [buildListKey]);
  const totalsEnabled = queryReady && viewMode === 'traditional' && !mergeDb;
  const totals = totalsEnabled && totalsResult?.key === totalsKey ? totalsResult.data : null;

  useLayoutEffect(() => {
    totalsAbortRef.current?.abort();
    const cached = totalsEnabled && selectedRunId && cacheIsFresh(totalsKey) ? cachePeek<FgMonthlyTotals>(totalsKey) : undefined;
    setTotalsResult(cached ? { key: totalsKey, data: cached } : null);
  }, [totalsEnabled, totalsKey, selectedRunId]);

  const fetchTotals = useCallback(async () => {
    totalsAbortRef.current?.abort();
    const ac = new AbortController();
    totalsAbortRef.current = ac;
    if (selectedRunId && cacheIsFresh(totalsKey)) {
      const cached = cachePeek<FgMonthlyTotals>(totalsKey);
      if (cached) { setTotalsResult({ key: totalsKey, data: cached }); return; }
    }
    try {
      const res = await fetch(totalsKey, { signal: ac.signal });
      const json = await res.json();
      if (ac.signal.aborted || totalsAbortRef.current !== ac) return;
      if (!res.ok || !json.totals) throw new Error('成品合計讀取失敗');
      if (selectedRunId) cacheSet<FgMonthlyTotals>(totalsKey, json.totals);
      setTotalsResult({ key: totalsKey, data: json.totals });
    } catch {
      if (ac.signal.aborted || totalsAbortRef.current !== ac) return;
      setTotalsResult(null);
    }
  }, [totalsKey, selectedRunId]);

  useEffect(() => {
    if (totalsEnabled) {
      fetchTotals();
      return () => totalsAbortRef.current?.abort();
    }
    totalsAbortRef.current?.abort();
    setTotalsResult(null);
  }, [fetchTotals, totalsEnabled]);

  // Whenever the user expands a part in 詳細 view (either by toggling here OR by clicking
  // the 詳細 icon in 傳統 view), scroll the matching row into view. We retry across several
  // delays because the row may not exist yet when the effect first fires (data still loading).
  useEffect(() => {
    if (!expandedPart || viewMode === 'traditional') return;
    const timers = [50, 200, 500, 1000, 1500].map((d) =>
      setTimeout(() => {
        const el = document.querySelector(`[data-row-pv="${CSS.escape(expandedPart)}"]`);
        if (el) (el as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, d),
    );
    return () => timers.forEach(clearTimeout);
  }, [expandedPart, viewMode, items.length]);

  // Fetch ALL items (no pagination) for export
  const fetchAllForExport = useCallback(async (): Promise<FgMonthlyItem[]> => {
    const params = new URLSearchParams({ page: '1', limit: '100000' });
    if (filtering.filterState.globalSearch) params.set('search', filtering.filterState.globalSearch);
    if (shortageOnly) params.set('shortageOnly', 'true');
    if (showIgnored) params.set('includeIgnored', 'true');
    if (excludeTestErp) params.set('excludeTest', 'true');
    if (sorting.sortQueryParam) params.set('sortFields', sorting.sortQueryParam);
    if (machineFilter !== 'all') params.set('machineFilter', machineFilter);
    if (mergeDb) params.set('merge', 'true');
    if (aggregated) params.set('aggregated', 'true');
    if (selectedRunId && !mergeDb) params.set('runId', String(selectedRunId));
    for (const [key, val] of Object.entries(filtering.filterQueryParams)) {
      params.set(key, val);
    }
    const res = await fetch(`/api/fg-monthly?${params}`);
    const json = await res.json();
    return json.items || [];
  }, [filtering.filterState.globalSearch, filtering.filterQueryParams, sorting.sortQueryParam, shortageOnly, showIgnored, excludeTestErp, machineFilter, mergeDb, aggregated, selectedRunId]);

  // Fetch distinct machine values on mount
  useEffect(() => {
    fetch('/api/fg-monthly/machines')
      .then((res) => res.json())
      .then((json) => setMachines(json.machines || []))
      .catch(() => {});
  }, []);

  const handleCategoryChange = useCallback((value: string) => {
    setActiveMachine(null);
    setMachineCategory(value);
  }, [setActiveMachine, setMachineCategory]);

  const handleMachineChange = useCallback((machine: string | null) => {
    setActiveMachine(machine);
  }, [setActiveMachine]);

  const [expandedItem, setExpandedItem] = useState<FgMonthlyItem | null>(null);
  const [openMaterialReminder, setOpenMaterialReminder] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailReqSeq = useRef(0);
  const [periodSourceRequest, setPeriodSourceRequest] = useState<FgMonthlyPeriodSourceRequest | null>(null);
  const [periodSourceSections, setPeriodSourceSections] = useState<FgMonthlySourceSection[]>([]);
  const [periodSourceLoading, setPeriodSourceLoading] = useState(false);
  const [periodSourceError, setPeriodSourceError] = useState<string | null>(null);
  const periodSourceReqSeq = useRef(0);

  const closePeriodSource = useCallback(() => {
    periodSourceReqSeq.current++;
    setPeriodSourceRequest(null);
    setPeriodSourceSections([]);
    setPeriodSourceLoading(false);
    setPeriodSourceError(null);
  }, []);

  const openPeriodSource = useCallback(async (request: FgMonthlyPeriodSourceRequest) => {
    const seq = ++periodSourceReqSeq.current;
    setPeriodSourceRequest(request);
    setPeriodSourceSections([]);
    setPeriodSourceLoading(true);
    setPeriodSourceError(null);
    try {
      const sourceTypes = fgMonthlySourceTypes(request.metric);
      const sections = await Promise.all(sourceTypes.map(async (type) => {
        const params = new URLSearchParams({
          runId: String(request.mrpRunId),
          type,
          metric: request.metric,
        });
        if (request.period.periodIndex !== null) {
          params.set('periodIndex', String(request.period.periodIndex));
        }
        if (request.dbSource) params.set('dbSource', request.dbSource);
        for (const memberPartVersion of request.memberPartVersions ?? []) {
          params.append('partVersion', memberPartVersion);
        }
        const response = await fetch(
          `/api/fg-monthly/${encodeURIComponent(request.partVersion)}/source-records?${params}`,
        );
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.error || `來源明細讀取失敗 (${response.status})`);
        }
        if (
          json.runId !== request.mrpRunId
          || json.periodIndex !== request.period.periodIndex
          || (json.dbSource ?? undefined) !== request.dbSource
        ) {
          throw new Error('來源明細回應與選取的 MRP Run／期間不一致');
        }
        return {
          type,
          records: json.records || [],
          priorRecords: json.priorRecords || [],
          total: json.total || 0,
          contractVersion: json.contractVersion,
          summary: json.summary,
          priorSummary: json.priorSummary,
        };
      }));
      if (seq !== periodSourceReqSeq.current) return;
      setPeriodSourceSections(sections);
    } catch (error) {
      if (seq !== periodSourceReqSeq.current) return;
      setPeriodSourceError(error instanceof Error ? error.message : '來源明細讀取失敗');
    } finally {
      if (seq === periodSourceReqSeq.current) setPeriodSourceLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (item: FgMonthlyItem, showMaterialReminder = false) => {
    const seq = ++detailReqSeq.current;
    setExpandedPart(item.partVersion);
    setExpandedItem(item);
    setOpenMaterialReminder(showMaterialReminder);
    setCurrentStockPc(Number(item.currentStockPc));
    setPeriodData([]);
    setSuggestions([]);
    setDetailLoading(true);
    try {
      const periodParams = new URLSearchParams();
      periodParams.set('runId', String(item.mrpRunId));
      if (item.dbSource) periodParams.set('dbSource', item.dbSource);
      if (aggregated) periodParams.set('aggregated', 'true');
      const qs = periodParams.toString() ? `?${periodParams}` : '';
      const res = await fetch(`/api/fg-monthly/${encodeURIComponent(item.partVersion)}/periods${qs}`);
      const json = await res.json();
      if (seq !== detailReqSeq.current) return;
      if (!res.ok) {
        throw new Error(json.error || `月推期間資料讀取失敗 (${res.status})`);
      }
      if (
        json.runId !== item.mrpRunId
        || (json.dbSource ?? undefined) !== item.dbSource
      ) {
        throw new Error('月推期間回應與選取的 MRP Run／資料庫來源不一致');
      }
      setPeriodData(json.periods || []);
      setSuggestions(json.suggestions || []);
    } catch {
      if (seq !== detailReqSeq.current) return;
      setPeriodData([]);
      setSuggestions([]);
    } finally {
      if (seq === detailReqSeq.current) setDetailLoading(false);
    }
  }, [aggregated]);

  const toggleExpand = useCallback((item: FgMonthlyItem) => {
    if (expandedPart === item.partVersion) {
      detailReqSeq.current++;
      setExpandedPart(null);
      setExpandedItem(null);
      setDetailLoading(false);
      return;
    }
    void openDetail(item);
  }, [expandedPart, openDetail]);

  const onShowDetailForTraditional = openDetail;

  const openWarehouseStock = useCallback((
    item: FgMonthlyItem,
    warehouseGroup: WarehouseStockGroup,
    initialFilter?: WarehouseStockFilter,
  ) => {
    setWarehouseStockRequest({
      runId: item.mrpRunId,
      partVersion: item.partVersion,
      aggregated: Boolean(item.isAggregated),
      warehouseGroup,
      initialFilter,
      dbSource: item.dbSource === 'local' || item.dbSource === 'docker' || item.dbSource === 'remote'
        ? item.dbSource
        : undefined,
    });
  }, []);

  const closeWarehouseStock = useCallback(() => {
    setWarehouseStockRequest(null);
  }, []);

  const fetchMembersForTraditional = useCallback(async (item: FgMonthlyItem) => (
    fetchFgMonthlyMembersByIdentity<FgMonthlyItem>(item, {
      sortFields: sorting.sortQueryParam,
      excludeTest: excludeTestErp,
    })
  ), [sorting.sortQueryParam, excludeTestErp]);

  const closeDetail = useCallback(() => {
    detailReqSeq.current++;
    setExpandedPart(null);
    setExpandedItem(null);
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    if (!expandedPart) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expandedPart, closeDetail]);

  const totalPages = Math.ceil(total / limit);
  const dataTableColumnCount = 1 + columns.filter((column) => colVis.isVisible(column.id)).length;

  // Slice periods based on displayMonths setting
  const visiblePeriods = periodData.slice(0, displayMonths);

  // Secondary toolbar controls — rendered inline when the toolbar itself is
  // wide enough, otherwise inside the 更多 popover.
  const secondaryControls = (
    <>
      <label className="flex items-center gap-1.5 text-xs text-slate-600" title="暫時顯示忽略清單裡的客戶代碼料件（清單在「設定」頁維護）">
        <input
          type="checkbox"
          checked={showIgnored}
          onChange={(e) => setShowIgnored(e.target.checked)}
          className="rounded"
        />
        顯示被忽略
      </label>
      <label className="flex items-center gap-1.5 text-xs text-slate-600" title="隱藏 ERP料號包含 TEST 的資料，不分英文大小寫">
        <input
          type="checkbox"
          checked={excludeTestErp}
          onChange={(e) => setExcludeTestErp(e.target.checked)}
          className="rounded"
        />
        排除 TEST 資料
      </label>
      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        月數:
        <select
          value={displayMonths}
          onChange={(e) => setDisplayMonths(parseInt(e.target.value, 10))}
          className="px-1.5 py-1 border border-slate-300 rounded text-xs"
        >
          {[3, 6, 9, 12].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      {viewMode === 'traditional' && (
        <FrozenColsControl value={frozenCols} max={FG_MAX_FROZEN} onChange={setFrozenCols} />
      )}
      <TextSizeControl value={textSize} onChange={setTextSize} />
      {/* 視圖: 按版本 / 按主件聚合 */}
      <div className="flex items-center gap-1 text-xs">
        <label className="flex items-center gap-1 text-slate-600">
          視圖:
          <select
            value={aggregated ? 'agg' : 'version'}
            onChange={(e) => setAggregated(e.target.value === 'agg')}
            className="px-1.5 py-1 border border-slate-300 rounded text-xs"
            title="按主件聚合：把同一主件的客戶料號 (含 -D7/-D9/-CD#) 與 SY/RD 變體合併計算 — 訂單與預示量加總，庫存依 ERP 唯一去重"
          >
            <option value="version">按版本</option>
            <option value="agg">按主件聚合</option>
          </select>
        </label>
        {viewMode === 'traditional' && (
          <label className="flex items-center gap-1 text-slate-600">
            樣式:
            <select
              value={tableStyle}
              onChange={(e) => setTableStyle(e.target.value as 'classic' | 'ragic')}
              className="px-1.5 py-1 border border-slate-300 rounded text-xs"
              title="切換表格樣式（純前端 UI，不影響業務數值）"
            >
              <option value="classic">原本</option>
              <option value="ragic">Ragic 風</option>
            </select>
          </label>
        )}
        {viewMode === 'traditional' && (
          <button
            type="button"
            onClick={() => {
              const next = !showTree;
              setShowTree(next);
              // When turning the tree on, re-order the sort so siblings under
              // the same 鍛造母件 cluster by their 成品製程版本 — that's what
              // makes shared trunks long and divergence points visible. We
              // preserve any further sort fields the user added.
              if (next) {
                const others = sorting.sortState.fields.filter(
                  (f) => f.id !== 'forgingParent' && f.id !== 'processBomVersion',
                );
                sorting.setSort([
                  { id: 'forgingParent', direction: 'asc', label: '鍛造母件' },
                  { id: 'processBomVersion', direction: 'asc', label: '成品製程版本' },
                  ...others,
                ]);
              }
            }}
            className={`px-2 py-0.5 rounded border ${
              showTree ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
            title="顯示成品製程版本樹 — 同一鍛造母件下的零件依製程版本分支顯示，方便比對製程差異點"
          >
            製程版本樹
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="h-full flex flex-col px-6 pt-6 pb-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <h2 className="text-2xl font-bold text-slate-800">成品月推移 (FG Monthly)</h2>
        <div className="flex items-center gap-2">
          <KeyboardScrollHelp
            step={kbScrollStep}
            onStepChange={setKbScrollStep}
            extraSection={viewMode === 'traditional' ? (
              <>
                {tableStyle === 'ragic' ? (
                  <>
                    <div className="font-semibold text-slate-700 mb-1">Ragic 風樣式條件</div>
                    <ul className="mt-1 space-y-0.5 text-slate-500 list-disc list-inside">
                      <li>偶數列淡灰（斑馬紋）</li>
                      <li>開始缺貨期數 第 1-2 期 → 淡粉列 + 深粉格；第 3-4 期 → 淡橘列 + 橘黃格；第 5-6 期 → 淡黃列 + 黃格</li>
                      <li>不良品庫存 &gt; 0 → 該格紅</li>
                      <li>剩餘庫存（含無計劃量）某期 &lt; 0 → 該格紅（蓋過列警示色）</li>
                    </ul>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-slate-700 mb-1">傳統 view 分群規則</div>
                    <p className="leading-relaxed text-slate-500">
                      主排序為「鍛造母件」時，列會依鍛造母件分群：
                    </p>
                    <ul className="mt-1 space-y-0.5 text-slate-500 list-disc list-inside">
                      <li>白 / 淡藍交錯底色 = 不同鍛造母件群組</li>
                      <li>同一群組（同底色）內客戶料號不同 → 該列上方畫粗線分隔</li>
                    </ul>
                  </>
                )}
                <div className="font-semibold text-slate-700 mt-3 mb-1">框選加總</div>
                <p className="leading-relaxed text-slate-500">
                  在表格資料格上按住滑鼠左鍵拖曳，框出矩形範圍；上方 Legend 列
                  即時顯示合計 / 格數 / 平均（只計數字格）。按 Esc 或「清除」取消。
                </p>
              </>
            ) : undefined}
          />
          <TablePagination
            page={page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            onPageChange={setPage}
            onLimitChange={setLimit}
          />
        </div>
      </div>

      {/* Toolbar + Quick filters */}
      <div className="fg-monthly-toolbar">
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
            <div className="fg-monthly-toolbar-extras flex shrink-0 flex-wrap items-center gap-2">
              <MachineFilter
                options={MACHINE_FILTER_OPTIONS}
                activeCategory={machineCategory}
                onCategoryChange={handleCategoryChange}
                machines={machines}
                activeMachine={activeMachine}
                onMachineChange={handleMachineChange}
              />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={shortageOnly}
                  onChange={(e) => setShortageOnly(e.target.checked)}
                  className="rounded"
                />
                僅顯示缺料
              </label>
              <div className="flex items-center border border-slate-300 rounded-md p-0.5">
                {(['detailed', 'traditional'] as ViewMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === mode
                        ? 'bg-blue-500 text-white'
                        : 'text-slate-600 hover:text-slate-800'
                    }`}
                  >
                    {mode === 'detailed' ? '詳細' : '傳統'}
                  </button>
                ))}
              </div>
              {/* 依工具列實際寬度判斷，避免側欄壓縮內容時仍誤判為寬螢幕。 */}
              <div className="fg-monthly-toolbar-secondary hidden items-center gap-2">
                {secondaryControls}
              </div>
              {/* 筆電尺寸的次要控制項收進「更多」 */}
              <div className="fg-monthly-toolbar-more relative" ref={moreRef}>
                <button
                  type="button"
                  onClick={() => setMoreOpen((o) => !o)}
                  className={`flex items-center gap-1 rounded border px-2.5 py-1 text-xs ${
                    moreOpen
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  ⋯ 更多
                </button>
                {moreOpen && (
                  <div className="absolute right-0 z-[60] mt-1 flex w-max flex-col gap-2.5 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
                    {secondaryControls}
                  </div>
                )}
              </div>
            </div>
          }
        />
        <ColumnHeaderMenu controller={columnHeader.menuController} />
      </div>

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

      {/* Color Legend — inline on xl+, collapsible toggle below xl */}
      {(viewMode === 'detailed') && (
        <>
          <div className="hidden xl:flex items-center gap-3 text-xs flex-wrap">
            <span className="font-semibold text-slate-500">圖例：</span>
            {Object.entries(ROW_COLORS).map(([key, c]) => (
              <span key={key} className={`${c.bg} ${c.text} px-2 py-0.5 rounded`}>
                {c.label}
              </span>
            ))}
            <SharedErpLegend />
          </div>
          <div className="text-xs xl:hidden">
            <button
              type="button"
              onClick={() => setLegendOpen((o) => !o)}
              className="font-semibold text-slate-500"
            >
              {legendOpen ? '▾' : '▸'} 圖例
            </button>
            {legendOpen && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {Object.entries(ROW_COLORS).map(([key, c]) => (
                  <span key={key} className={`${c.bg} ${c.text} px-2 py-0.5 rounded`}>
                    {c.label}
                  </span>
                ))}
                <SharedErpLegend />
              </div>
            )}
          </div>
        </>
      )}

      {listError && <ListRequestError message={listError} onRetry={fetchData} />}

      {/* Traditional View */}
      {viewMode === 'traditional' && (
        <>
          {loading && listPending && <Loader label="讀取成品月推資料" className="flex-1" />}
          <div className={listPending ? 'hidden' : 'contents'}>
          <TraditionalView
            items={materialReminders.items}
            active={!listPending}
            totals={totals}
            displayMonths={displayMonths}
            columnVisibility={colVis.visibility}
            textSize={textSize}
            frozenCount={frozenCols}
            fetchAllForExport={fetchAllForExport}
            aggregated={aggregated}
            showTree={showTree}
            tableStyle={tableStyle}
            columnFilters={filtering.filterState.columnFilters}
            onSetColumnFilter={filtering.setColumnFilter}
            onRemoveColumnFilter={filtering.removeColumnFilter}
            sortFields={sorting.sortState.fields}
            onAddSort={sorting.prioritizeSort}
            onRemoveSort={sorting.removeSort}
            onToggleColumn={colVis.toggleColumn}
            onFreezeToColumn={freezeToFgColumn}
            onRestoreGrouping={sorting.resetSort}
            columnHeaderController={columnHeader.menuController}
            columnHeaderColumns={columns}
            sortFieldIds={traditionalSortFieldIds}
            onShowDetail={onShowDetailForTraditional}
            onShowWarehouseStock={openWarehouseStock}
            onShowPeriodSource={openPeriodSource}
            fetchMembers={fetchMembersForTraditional}
          />
          </div>
        </>
      )}

      {/* Data Table (Simple / Detailed) — consumes the remaining vertical
          space and owns its internal scroll. */}
      {viewMode !== 'traditional' && (
      <div data-mrp-scroll className="flex-1 min-h-0 bg-white border border-t-0 border-slate-200 rounded-b-lg overflow-auto">
        <table className="w-full mrp-table" style={{ zoom: TEXT_ZOOM_LEVELS[textSize] || 1 }}>
          <thead>
            <tr>
              <th className="w-8" style={{ minWidth: 32 }}></th>
              {colVis.isVisible('partVersion') && <ColumnHeaderCell column={columns.find((column) => column.id === 'partVersion')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('customerPartNo') && <ColumnHeaderCell column={columns.find((column) => column.id === 'customerPartNo')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('customerCode') && <ColumnHeaderCell column={columns.find((column) => column.id === 'customerCode')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('erpPartNo') && <ColumnHeaderCell column={columns.find((column) => column.id === 'erpPartNo')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('forgingMachine') && <ColumnHeaderCell column={columns.find((column) => column.id === 'forgingMachine')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('forgingParent') && <ColumnHeaderCell column={columns.find((column) => column.id === 'forgingParent')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('sortGroup') && <ColumnHeaderCell column={columns.find((column) => column.id === 'sortGroup')!} controller={columnHeader.menuController} />}
              {viewMode === 'detailed' && (
                <>
                  {colVis.isVisible('firstProcess') && <ColumnHeaderCell column={columns.find((column) => column.id === 'firstProcess')!} controller={columnHeader.menuController} />}
                  {colVis.isVisible('productStatus') && <ColumnHeaderCell column={columns.find((column) => column.id === 'productStatus')!} controller={columnHeader.menuController} />}
                  {colVis.isVisible('stockPeriods') && <ColumnHeaderCell column={columns.find((column) => column.id === 'stockPeriods')!} controller={columnHeader.menuController} />}
                </>
              )}
              {viewMode === 'detailed' && (
                <>
                  {colVis.isVisible('unitWeightG') && <ColumnHeaderCell column={columns.find((column) => column.id === 'unitWeightG')!} controller={columnHeader.menuController} />}
                  {colVis.isVisible('mainMaterialKg') && <ColumnHeaderCell column={columns.find((column) => column.id === 'mainMaterialKg')!} controller={columnHeader.menuController} />}
                </>
              )}
              {colVis.isVisible('currentStockPc') && <ColumnHeaderCell column={columns.find((column) => column.id === 'currentStockPc')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('inventoryAnomalyCount') && <ColumnHeaderCell column={columns.find((column) => column.id === 'inventoryAnomalyCount')!} controller={columnHeader.menuController} />}
              {viewMode === 'detailed' && colVis.isVisible('badStockPc') && (
                <ColumnHeaderCell column={columns.find((column) => column.id === 'badStockPc')!} controller={columnHeader.menuController} />
              )}
              {colVis.isVisible('woScheduled') && <ColumnHeaderCell column={columns.find((column) => column.id === 'woScheduled')!} controller={columnHeader.menuController} className="bg-green-100" title="未結案 HF01 鍛造工令中已有正式工單代碼的數量" />}
              {colVis.isVisible('woUnscheduled') && <ColumnHeaderCell column={columns.find((column) => column.id === 'woUnscheduled')!} controller={columnHeader.menuController} className="bg-red-50" title="未結案 HF01 鍛造工令中尚未排定的數量" />}
              {colVis.isVisible('woTotal') && <ColumnHeaderCell column={columns.find((column) => column.id === 'woTotal')!} controller={columnHeader.menuController} className="bg-green-100" title="鍛造已排加鍛造待排；僅供進度參考，不參與剩餘庫存計算" />}
              {viewMode === 'detailed' && (
                <>
                  {colVis.isVisible('planReportedQty') && <ColumnHeaderCell column={columns.find((column) => column.id === 'planReportedQty')!} controller={columnHeader.menuController} className="bg-blue-50" title="生產計畫累計報工，僅供參考" />}
                  {colVis.isVisible('planClosedQty') && <ColumnHeaderCell column={columns.find((column) => column.id === 'planClosedQty')!} controller={columnHeader.menuController} className="bg-orange-50" title="生產計畫累計結案入庫，僅供參考" />}
                  {colVis.isVisible('priorPlanQty') && <ColumnHeaderCell column={columns.find((column) => column.id === 'priorPlanQty')!} controller={columnHeader.menuController} className="bg-yellow-50" />}
                </>
              )}
              {viewMode === 'detailed' && colVis.isVisible('priorUnshippedQty') && (
                <ColumnHeaderCell column={columns.find((column) => column.id === 'priorUnshippedQty')!} controller={columnHeader.menuController} className="bg-green-50" />
              )}
              {colVis.isVisible('totalUnshippedQty') && <ColumnHeaderCell column={columns.find((column) => column.id === 'totalUnshippedQty')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('shouldPlanProduction') && <ColumnHeaderCell column={columns.find((column) => column.id === 'shouldPlanProduction')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('shortageStartPeriod') && <ColumnHeaderCell column={columns.find((column) => column.id === 'shortageStartPeriod')!} controller={columnHeader.menuController} />}
              {colVis.isVisible('shortageStartPeriodNoPlan') && <ColumnHeaderCell column={columns.find((column) => column.id === 'shortageStartPeriodNoPlan')!} controller={columnHeader.menuController} />}
              {viewMode === 'detailed' && colVis.isVisible('missingForecastPeriods') && (
                <ColumnHeaderCell column={columns.find((column) => column.id === 'missingForecastPeriods')!} controller={columnHeader.menuController} />
              )}
              {colVis.isVisible('wfgStockPc') && <ColumnHeaderCell column={columns.find((column) => column.id === 'wfgStockPc')!} controller={columnHeader.menuController} className="bg-sky-50" />}
              {colVis.isVisible('ye1StockPc') && <ColumnHeaderCell column={columns.find((column) => column.id === 'ye1StockPc')!} controller={columnHeader.menuController} className="bg-sky-50" />}
              {colVis.isVisible('lastPeriodRemainingNoPlan') && <ColumnHeaderCell column={columns.find((column) => column.id === 'lastPeriodRemainingNoPlan')!} controller={columnHeader.menuController} className="bg-teal-50" />}
              {colVis.isVisible('materialReminder') && <ColumnHeaderCell column={columns.find(column => column.id === 'materialReminder')!} controller={columnHeader.menuController} />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={dataTableColumnCount}><Loader /></td>
              </tr>
            ) : listPending ? null : items.length === 0 ? (
              <tr>
                <td colSpan={dataTableColumnCount} className="text-center py-8 text-slate-400">
                  查無資料，請先執行 MRP。
                </td>
              </tr>
            ) : (
              materialReminders.items.map((item) => (
                  <tr
                    key={item.id}
                    data-row-pv={item.partVersion}
                    className={expandedPart === item.partVersion ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-slate-50'}
                  >
                    <td
                      className="text-center text-slate-400 cursor-pointer hover:text-blue-600"
                      onClick={() => toggleExpand(item)}
                      title="顯示明細"
                    >
                      {expandedPart === item.partVersion ? '▼' : '▶'}
                    </td>
                    {colVis.isVisible('partVersion') && (
                      <td className="font-mono text-xs font-medium">
                        {mergeDb && item.dbSource && <DbSourceBadge source={item.dbSource} />}{' '}
                        {item.partVersion}
                        {aggregated && (item.aggregatedMembers?.length ?? 0) > 1 && (
                          <span
                            className="ml-1.5 inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold bg-indigo-600 text-white rounded shadow-sm align-middle"
                            title={`聚合 ${item.aggregatedMembers!.length} 個來源:\n${item.aggregatedMembers!.join('\n')}`}
                          >
                            聚合 ×{item.aggregatedMembers!.length}
                          </span>
                        )}
                      </td>
                    )}
                    {colVis.isVisible('customerPartNo') && <td className="text-xs">{item.customerPartNo || '—'}</td>}
                    {colVis.isVisible('customerCode') && <td className="text-xs">{item.customerCode || '—'}</td>}
                    {colVis.isVisible('erpPartNo') && (
                      <td className="text-xs font-mono">
                        <span className="whitespace-nowrap">{item.erpPartNo || '—'}</span>
                      </td>
                    )}
                    {colVis.isVisible('forgingMachine') && <td className="text-xs">{item.forgingMachine || '—'}</td>}
                    {colVis.isVisible('forgingParent') && <td className="text-xs">{item.forgingParent || '—'}</td>}
                    {colVis.isVisible('sortGroup') && <td className="text-xs text-center">{item.sortGroup ?? '—'}</td>}
                    {viewMode === 'detailed' && (
                      <>
                        {colVis.isVisible('firstProcess') && <td className="text-xs">{item.firstProcess || '—'}</td>}
                        {colVis.isVisible('productStatus') && <td className="text-xs">{item.productStatus || '—'}</td>}
                        {colVis.isVisible('stockPeriods') && <td className="text-xs text-center">{item.stockPeriods ?? '—'}</td>}
                      </>
                    )}
                    {viewMode === 'detailed' && (
                      <>
                        {colVis.isVisible('unitWeightG') && <td className="text-right font-mono text-xs">
                          {Number(item.unitWeightG).toFixed(1)}
                        </td>}
                        {colVis.isVisible('mainMaterialKg') && <td className="text-right font-mono text-xs">
                          {Number(item.mainMaterialKg).toFixed(3)}
                        </td>}
                      </>
                    )}
                    {colVis.isVisible('currentStockPc') && (
                      <td className="text-right font-mono text-xs">
                        <SharedBalanceValue
                          value={Number(item.currentStockPc)}
                          label="可用成品庫存pc"
                          sharedErpCount={item.sharedErpCount}
                          erpPartNo={item.erpPartNo}
                          warning={item.inventoryAnomalyCount > 0
                            ? `${item.inventoryAnomalyCount} 筆庫存批號可能尚未同步；MRP 仍採 Ragic 原值`
                            : undefined}
                        />
                      </td>
                    )}
                    {colVis.isVisible('inventoryAnomalyCount') && (
                      <td className="text-center text-xs">
                        {!item.inventoryValidationAvailable ? (
                          <span className="text-slate-400" title="此歷史 Run 尚無庫存批號數量驗證">未驗證</span>
                        ) : item.inventoryAnomalyCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => openWarehouseStock(
                              item,
                              item.wfgInventoryAnomalyCount > 0 ? 'INTERNAL' : 'YE1',
                              'ANOMALY',
                            )}
                            className="inline-flex items-center gap-1 border border-amber-500 bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-950 hover:bg-amber-200"
                            title="查看可能未同步的 Ragic 庫存批號"
                          >
                            <AlertTriangle size={11} aria-hidden="true" />待確認 {item.inventoryAnomalyCount}
                          </button>
                        ) : (
                          <span className="text-emerald-600">正常</span>
                        )}
                      </td>
                    )}
                    {viewMode === 'detailed' && colVis.isVisible('badStockPc') && (
                      <td className="text-right font-mono text-xs">
                        <SharedBalanceValue
                          value={Number(item.badStockPc)}
                          label="不良品庫存pc"
                          sharedErpCount={item.sharedErpCount}
                          erpPartNo={item.erpPartNo}
                        />
                      </td>
                    )}
                    {colVis.isVisible('woScheduled') && <td className="text-right font-mono text-xs bg-green-50">
                      <FgMonthlySummarySourceValue item={item} metric="woScheduled" onOpen={openPeriodSource} />
                    </td>}
                    {colVis.isVisible('woUnscheduled') && <td className="text-right font-mono text-xs bg-red-50">
                      <FgMonthlySummarySourceValue item={item} metric="woUnscheduled" onOpen={openPeriodSource} />
                    </td>}
                    {colVis.isVisible('woTotal') && <td className="text-right font-mono text-xs bg-green-50">
                      <FgMonthlySummarySourceValue item={item} metric="woTotal" onOpen={openPeriodSource} />
                    </td>}
                    {viewMode === 'detailed' && (
                      <>
                        {colVis.isVisible('planReportedQty') && <td className="text-right font-mono text-xs bg-blue-50">
                          <FgMonthlySummarySourceValue item={item} metric="planReportedQty" onOpen={openPeriodSource} />
                        </td>}
                        {colVis.isVisible('planClosedQty') && <td className="text-right font-mono text-xs bg-orange-50">
                          <FgMonthlySummarySourceValue item={item} metric="planClosedQty" onOpen={openPeriodSource} />
                        </td>}
                        {colVis.isVisible('priorPlanQty') && <td className="text-right font-mono text-xs bg-yellow-50">
                          <button
                            type="button"
                            onClick={() => openPeriodSource({
                              partVersion: item.partVersion,
                              memberPartVersions: item.isAggregated ? item.aggregatedMembers : undefined,
                              mrpRunId: item.mrpRunId,
                              dbSource: item.dbSource,
                              metric: 'plannedOutput',
                              period: fgMonthlySourcePeriod(
                                'plannedOutput',
                                Number(item.priorPlanQty) || 0,
                                -1,
                                '前期未結生產計畫',
                              ),
                            })}
                            className={`font-mono underline decoration-dotted underline-offset-1 hover:decoration-solid ${
                              Number(item.priorPlanQty) === 0 ? 'text-slate-300' : ''
                            }`}
                            title="查看前期未結生產計畫來源明細"
                          >
                            {Number(item.priorPlanQty).toLocaleString()}
                          </button>
                        </td>}
                      </>
                    )}
                    {viewMode === 'detailed' && colVis.isVisible('priorUnshippedQty') && (
                      <td className="text-right font-mono text-xs bg-green-50">
                        <button
                          type="button"
                          onClick={() => openPeriodSource({
                            partVersion: item.partVersion,
                            memberPartVersions: item.isAggregated ? item.aggregatedMembers : undefined,
                            mrpRunId: item.mrpRunId,
                            dbSource: item.dbSource,
                            metric: 'ordersUnshipped',
                            period: fgMonthlySourcePeriod(
                              'ordersUnshipped',
                              Number(item.priorUnshippedQty) || 0,
                              -1,
                              '前期 MRP 未出庫需求',
                            ),
                          })}
                          className={`font-mono underline decoration-dotted underline-offset-1 hover:decoration-solid ${
                            Number(item.priorUnshippedQty) === 0 ? 'text-slate-300' : ''
                          }`}
                          title="查看前期 MRP 未出庫需求來源明細"
                        >
                          {Number(item.priorUnshippedQty).toLocaleString()}
                        </button>
                      </td>
                    )}
                    {colVis.isVisible('totalUnshippedQty') && <td className="text-right font-mono text-xs">
                      {Number(item.totalUnshippedQty).toLocaleString()}
                    </td>}
                    {colVis.isVisible('shouldPlanProduction') && <td className="text-center text-xs">
                      {item.shouldPlanProduction ? (
                        <span className="text-green-600 font-bold text-base" title="應安排生產計畫">✓</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>}
                    {colVis.isVisible('shortageStartPeriod') && <td>
                      {item.shortageStartPeriod !== null ? (
                        <span className="badge badge-danger">
                          M{item.shortageStartPeriod + 1}
                        </span>
                      ) : (
                        <span className="badge badge-success">OK</span>
                      )}
                    </td>}
                    {colVis.isVisible('shortageStartPeriodNoPlan') && <td>
                      {item.shortageStartPeriodNoPlan !== null ? (
                        <span className="badge badge-warning">
                          M{item.shortageStartPeriodNoPlan + 1}
                        </span>
                      ) : (
                        <span className="badge badge-success">OK</span>
                      )}
                    </td>}
                    {viewMode === 'detailed' && colVis.isVisible('missingForecastPeriods') && (
                      <td className="text-xs text-center">
                        {Number(item.missingForecastPeriods) > 0 ? (
                          <span className="badge badge-info">{item.missingForecastPeriods}</span>
                        ) : '—'}
                      </td>
                    )}
                    {colVis.isVisible('wfgStockPc') && (
                      <td className="bg-sky-50 text-right font-mono text-xs">
                        <WarehouseStockValue
                          value={item.wfgStockPc}
                          warehouseGroup="INTERNAL"
                          hasInventoryAnomaly={item.wfgInventoryAnomalyCount > 0}
                          inventoryAnomalyCount={item.wfgInventoryAnomalyCount}
                          onOpen={() => openWarehouseStock(item, 'INTERNAL')}
                        />
                      </td>
                    )}
                    {colVis.isVisible('ye1StockPc') && (
                      <td className="bg-sky-50 text-right font-mono text-xs">
                        <WarehouseStockValue
                          value={item.ye1StockPc}
                          warehouseGroup="YE1"
                          hasInventoryAnomaly={item.ye1InventoryAnomalyCount > 0}
                          inventoryAnomalyCount={item.ye1InventoryAnomalyCount}
                          onOpen={() => openWarehouseStock(item, 'YE1')}
                        />
                      </td>
                    )}
                    {/* [期末]剩餘庫存(無計劃量) — last period's remainingNoPlan */}
                    {colVis.isVisible('lastPeriodRemainingNoPlan') && <td className={`text-right font-mono text-xs ${
                      item.lastPeriodRemainingNoPlan !== null && Number(item.lastPeriodRemainingNoPlan) < 0
                        ? 'bg-red-100 text-red-800 font-bold'
                        : 'bg-teal-50 text-teal-800'
                    }`}>
                      <SharedBalanceValue
                        value={item.lastPeriodRemainingNoPlan}
                        label="[期末]剩餘庫存(無計劃量)"
                        sharedErpCount={item.sharedErpCount}
                        erpPartNo={item.erpPartNo}
                      />
                    </td>}
                    {colVis.isVisible('materialReminder') && <td><MaterialReminderButton reminder={item.materialReminder} error={item.materialReminderError} onClick={() => openDetail(item, true)} /></td>}
                  </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      {/* 明細 modal — 點 ▶ 開啟。版面比照「開單規劃」的明細視窗。 */}
      {expandedPart && expandedItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8">
          <div className="absolute inset-0 bg-black/40" onClick={closeDetail} />
          <div
            className="relative w-[95vw] max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sticky header — metadata 橫排。z-40 蓋過內部 PeriodDetailViewDetailed
                 的 sticky 第一欄/thead（mrp-table thead 是 z-30），避免左捲時 row label
                 漂到 header 區遮住 partVersion 標題。 */}
            <div className="sticky top-0 z-40 bg-white border-b border-slate-200 px-5 py-3 flex items-start gap-4">
              <button
                onClick={closeDetail}
                className="mt-0.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
              >
                ← 返回列表
              </button>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-slate-800 truncate">
                  {expandedItem.partVersion}
                </h3>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 mt-1">
                  <span>MRP版本: <b className="text-blue-700 font-mono">{runVersionCode || '—'}</b></span>
                  <span>跑表日期: <b className="text-slate-700">{runDate || '—'}</b></span>
                  <span>客戶料號: <b className="text-slate-700">{expandedItem.customerPartNo || '—'}</b></span>
                  <span>ERP料號: <b className="text-slate-700 font-mono whitespace-nowrap">{expandedItem.erpPartNo || '—'}</b></span>
                  <span>機台: <b className="text-slate-700">{expandedItem.forgingMachine || '—'}</b></span>
                  <span>製程1: <b className="text-slate-700">{expandedItem.firstProcess || '—'}</b></span>
                  <span>客戶代碼: <b className="text-slate-700">{expandedItem.customerCode || '—'}</b></span>
                  <span className="inline-flex items-center gap-1">
                    可用成品庫存pc:
                    <b className="text-slate-700 font-mono">
                      <SharedBalanceValue
                        value={Number(expandedItem.currentStockPc)}
                        label="可用成品庫存pc"
                        sharedErpCount={expandedItem.sharedErpCount}
                        erpPartNo={expandedItem.erpPartNo}
                        warning={expandedItem.inventoryAnomalyCount > 0
                          ? `${expandedItem.inventoryAnomalyCount} 筆庫存批號可能尚未同步；MRP 仍採 Ragic 原值`
                          : undefined}
                      />
                    </b>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {WAREHOUSE_STOCK_GROUPS.INTERNAL.label}:
                    <WarehouseStockValue
                      value={expandedItem.wfgStockPc}
                      warehouseGroup="INTERNAL"
                      hasInventoryAnomaly={expandedItem.wfgInventoryAnomalyCount > 0}
                      inventoryAnomalyCount={expandedItem.wfgInventoryAnomalyCount}
                      onOpen={() => openWarehouseStock(expandedItem, 'INTERNAL')}
                    />
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {WAREHOUSE_STOCK_GROUPS.YE1.label}:
                    <WarehouseStockValue
                      value={expandedItem.ye1StockPc}
                      warehouseGroup="YE1"
                      hasInventoryAnomaly={expandedItem.ye1InventoryAnomalyCount > 0}
                      inventoryAnomalyCount={expandedItem.ye1InventoryAnomalyCount}
                      onOpen={() => openWarehouseStock(expandedItem, 'YE1')}
                    />
                  </span>
                  <span>單位重g: <b className="text-slate-700 font-mono">{Number(expandedItem.unitWeightG).toFixed(1)}</b></span>
                  <span>[成品料號]主要用料kg: <b className="text-slate-700 font-mono">{Number(expandedItem.mainMaterialKg).toFixed(3)}</b></span>
                  <span>備庫件數: <b className="text-slate-700">{expandedItem.stockPeriods ?? '—'}</b></span>
                  <span>MRP排序群組: <b className="text-slate-700">{expandedItem.sortGroup ?? '—'}</b></span>
                  <span>版本狀態: <b className="text-slate-700">{expandedItem.productStatus || '—'}</b></span>
                  {expandedItem.processBomVersion && (
                    <span>成品製程版本: <b className="text-slate-700 font-mono">{expandedItem.processBomVersion}</b></span>
                  )}
                </div>
                {expandedItem.inventoryAnomalyCount > 0 && (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-950"
                    role="alert"
                    data-inventory-anomaly-detail
                  >
                    <AlertTriangle size={15} className="shrink-0 text-amber-700" aria-hidden="true" />
                    <b>庫存資料待確認：{expandedItem.inventoryAnomalyCount} 筆批號</b>
                    <span className="text-amber-800">
                      差異絕對值合計 {expandedItem.inventoryAnomalyDiffPc.toLocaleString()} pc，MRP 仍採 Ragic 原值。
                    </span>
                    <span className="flex-1" />
                    {expandedItem.wfgInventoryAnomalyCount > 0 && (
                      <button
                        type="button"
                        onClick={() => openWarehouseStock(expandedItem, 'INTERNAL', 'ANOMALY')}
                        className="inline-flex items-center gap-1 border border-amber-500 bg-white px-2 py-1 font-semibold text-amber-900 hover:bg-amber-100"
                      >
                        查看廠內異常 {expandedItem.wfgInventoryAnomalyCount}
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    )}
                    {expandedItem.ye1InventoryAnomalyCount > 0 && (
                      <button
                        type="button"
                        onClick={() => openWarehouseStock(expandedItem, 'YE1', 'ANOMALY')}
                        className="inline-flex items-center gap-1 border border-amber-500 bg-white px-2 py-1 font-semibold text-amber-900 hover:bg-amber-100"
                      >
                        查看 YE1 異常 {expandedItem.ye1InventoryAnomalyCount}
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="p-5 space-y-4">
              {detailLoading ? (
                <div className="py-12 text-center text-sm text-slate-400">載入期間資料...</div>
              ) : (
                <>
                  {aggregated && (expandedItem.aggregatedMembers?.length ?? 0) > 1 && (
                    <AggregatedSourcesBanner
                      partVersion={expandedItem.partVersion}
                      members={expandedItem.aggregatedMembers ?? []}
                      runId={expandedItem.mrpRunId}
                      dbSource={expandedItem.dbSource}
                      excludeTestErp={excludeTestErp}
                    />
                  )}
                  <FgMaterialReminderPanel item={expandedItem} initiallyOpen={openMaterialReminder} />
                  <FgMonthlySourcePanel
                    partVersion={expandedItem.partVersion}
                    runId={expandedItem.mrpRunId}
                    dbSource={expandedItem.dbSource}
                    aggregatedMembers={expandedItem.isAggregated
                      ? expandedItem.aggregatedMembers
                      : undefined}
                  />
                  <PeriodDetailViewDetailed
                    periods={visiblePeriods}
                    suggestions={suggestions}
                    partVersion={expandedItem.partVersion}
                    currentStockPc={currentStockPc}
                    inventoryAnomalyCount={expandedItem.inventoryAnomalyCount}
                    inventoryAnomalyDiffPc={expandedItem.inventoryAnomalyDiffPc}
                    priorUnshippedQty={expandedItem.priorUnshippedQty}
                    priorPlanQty={expandedItem.priorPlanQty}
                    erpPartNo={expandedItem.erpPartNo}
                    sharedErpCount={expandedItem.sharedErpCount}
                    usesSharedErpPool={expandedItem.usesSharedErpPool}
                    isAggregated={expandedItem.isAggregated}
                    mainMaterialKg={expandedItem.mainMaterialKg ?? 0}
                    unitWeightG={expandedItem.unitWeightG ?? 0}
                    onSuggestionsUpdate={setSuggestions}
                    aggregated={aggregated}
                    aggregatedMembers={aggregated ? expandedItem.aggregatedMembers ?? null : null}
                    runId={expandedItem.mrpRunId}
                    dbSource={expandedItem.dbSource}
                    excludeTestErp={excludeTestErp}
                    onShowPeriodSource={openPeriodSource}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {warehouseStockRequest && (
        <WarehouseStockDrawer request={warehouseStockRequest} onClose={closeWarehouseStock} />
      )}

      {periodSourceRequest && (
        <FgMonthlyPeriodSourceDrawer
          request={periodSourceRequest}
          sections={periodSourceSections}
          loading={periodSourceLoading}
          error={periodSourceError}
          onRetry={() => openPeriodSource(periodSourceRequest)}
          onClose={closePeriodSource}
        />
      )}

      {/* 頁碼移到最上方標題列（每頁筆數 + ‹ x / y ›），不再佔底部一整列 */}
    </div>
  );
}

// ============================================================
// Aggregated sources banner — shown above the part-info block when this row
// represents a 主件聚合 group. Lists every constituent variant's customer 料號 and ERP料號
// (deduped + grouped by ERP) so users can immediately see what was merged.
// ============================================================
function AggregatedSourcesBanner({
  partVersion,
  members,
  runId,
  dbSource,
  excludeTestErp,
}: {
  partVersion: string;
  members: string[];
  runId: number;
  dbSource?: string;
  excludeTestErp: boolean;
}) {
  type SrcRow = {
    partVersion: string;
    customerCode: string | null;
    customerPartNo: string | null;
    erpPartNo: string | null;
  };
  const [rows, setRows] = useState<SrcRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (members.length === 0) return;
    const controller = new AbortController();
    setLoading(true);
    setRows(null);
    setError(null);
    fetchFgMonthlyMembersByIdentity<SrcRow>({
      partVersion,
      mrpRunId: runId,
      dbSource,
      aggregatedMembers: members,
    }, {
      excludeTest: excludeTestErp,
      signal: controller.signal,
    })
      .then((items) => {
        items.sort((a, b) => (a.partVersion || '').localeCompare(b.partVersion || ''));
        setRows(items);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setRows(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [partVersion, members, runId, dbSource, excludeTestErp]);

  // Group by ERP for compact display
  const byErp = useMemo(() => {
    if (!rows) return [];
    const m = new Map<string, SrcRow[]>();
    for (const r of rows) {
      const k = r.erpPartNo || '(無 ERP)';
      const arr = m.get(k);
      if (arr) arr.push(r); else m.set(k, [r]);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <div className="mb-3 p-3 bg-indigo-50 border-2 border-indigo-300 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-bold bg-indigo-600 text-white rounded shadow-sm">
          主件聚合 ×{members.length}
        </span>
        <span className="text-[11px] text-indigo-900 font-medium">
          以下顯示的所有數值為聚合結果：訂單／預示量加總，庫存／工令／生產計畫依 ERP料號 唯一去重。
        </span>
        {byErp.length > 4 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="ml-auto text-[10px] px-2 py-0.5 bg-white text-indigo-700 border border-indigo-300 rounded hover:bg-indigo-100"
          >
            {showAll ? '收合' : `顯示全部 (${byErp.length})`}
          </button>
        )}
      </div>
      {loading && <div className="text-[11px] italic text-indigo-700">載入聚合來源中...</div>}
      {error && <div className="text-[11px] text-red-700">聚合來源載入失敗：{error}</div>}
      {rows && rows.length === 0 && (
        <div className="text-[11px] italic text-indigo-700">（無聚合來源資料）</div>
      )}
      {byErp.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
          {(showAll ? byErp : byErp.slice(0, 4)).map(([erp, variants]) => (
            <div
              key={erp}
              className="bg-white border border-indigo-200 rounded px-2 py-1.5 text-[10px] leading-tight min-w-0"
            >
              <div className="flex items-baseline gap-1.5">
                <span className="text-indigo-500 font-semibold">ERP</span>
                <span className="font-mono font-medium text-slate-800 truncate" title={erp}>
                  {erp}
                </span>
                {variants.length > 1 && (
                  <span className="ml-auto text-[9px] bg-indigo-100 text-indigo-700 px-1 rounded shrink-0">
                    ×{variants.length}
                  </span>
                )}
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {variants.map((v) => (
                  <li key={v.partVersion} className="pl-2 truncate text-slate-600" title={`${v.customerCode || '?'} · ${v.customerPartNo || '?'} · ${v.partVersion}`}>
                    <span className="text-slate-400">·</span>{' '}
                    <span className="font-semibold text-slate-700">{v.customerCode || '—'}</span>
                    <span className="text-slate-300"> · </span>
                    <span className="font-mono">{v.customerPartNo || '—'}</span>
                    <span className="text-slate-300"> · </span>
                    <span className="font-mono text-slate-500 text-[9px]">{v.partVersion}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!showAll && byErp.length > 4 && (
            <div className="text-[10px] italic text-indigo-700 col-span-full">
              還有 {byErp.length - 4} 個 ERP 群組未顯示...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Detailed view: horizontal 12-month grid matching Ragic Form 22
// ============================================================
function PeriodDetailViewDetailed({
  periods,
  suggestions,
  partVersion,
  currentStockPc,
  inventoryAnomalyCount,
  inventoryAnomalyDiffPc,
  priorUnshippedQty,
  priorPlanQty,
  erpPartNo,
  sharedErpCount,
  usesSharedErpPool,
  isAggregated,
  mainMaterialKg,
  unitWeightG,
  onSuggestionsUpdate,
  aggregated = false,
  aggregatedMembers = null,
  runId = null,
  dbSource,
  excludeTestErp = true,
  onShowPeriodSource,
}: {
  periods: PeriodDetail[];
  suggestions: PlanSuggestion[];
  partVersion: string;
  currentStockPc: number;
  inventoryAnomalyCount: number;
  inventoryAnomalyDiffPc: number;
  priorUnshippedQty: number;
  priorPlanQty: number;
  erpPartNo: string | null;
  sharedErpCount: number;
  usesSharedErpPool: boolean;
  isAggregated?: boolean;
  mainMaterialKg: number;
  unitWeightG: number;
  onSuggestionsUpdate: (s: PlanSuggestion[]) => void;
  /** When true, the displayed periods are the aggregated 主件聚合 totals; row labels become
   *  expandable to reveal each member variant's individual contribution. */
  aggregated?: boolean;
  aggregatedMembers?: string[] | null;
  runId?: number | null;
  dbSource?: string;
  excludeTestErp?: boolean;
  onShowPeriodSource: (request: FgMonthlyPeriodSourceRequest) => void;
}) {
  const { isLatestSelected, setBusy } = useMrpVersion();
  const isReadOnly = !isLatestSelected;
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const autoRecalculatePlanQty = canAutoRecalculatePlanQty(usesSharedErpPool);
  const [stockCalculation, setStockCalculation] = useState<StockCalculationDetail | null>(null);
  const closeStockCalculation = useCallback(() => setStockCalculation(null), []);
  const openStockCalculation = useCallback((periodIndex: number, balanceKind: StockBalanceKind) => {
    setStockCalculation(buildStockCalculationDetail({
      partVersion,
      erpPartNo,
      periodIndex,
      balanceKind,
      currentStockPc,
      priorUnshippedQty,
      priorPlanQty,
      periods,
      usesSharedErpPool,
      sharedErpCount,
      isAggregated,
    }));
  }, [
    currentStockPc, erpPartNo, isAggregated, partVersion, periods,
    priorPlanQty, priorUnshippedQty, sharedErpCount, usesSharedErpPool,
  ]);

  // ── Member drill-down state (only relevant when `aggregated` is true) ──
  type MemberItem = {
    id: number;
    partVersion: string;
    mrpRunId: number;
    dbSource?: string;
    customerCode: string | null;
    customerPartNo: string | null;
    erpPartNo: string | null;
  };
  // Set so multiple metric drill-downs can be open at once — comparing
  // MRP 未出庫需求與預示量並排是常用的判讀流程。
  const [expandedMetrics, setExpandedMetrics] = useState<Set<keyof PeriodDetail>>(() => new Set());
  const [memberItems, setMemberItems] = useState<MemberItem[] | null>(null);
  const [memberPeriods, setMemberPeriods] = useState<Record<string, PeriodDetail[]>>({});
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Reset member drill-down state when the part being viewed changes (so old members don't leak).
  useEffect(() => {
    setExpandedMetrics(new Set());
    setMemberItems(null);
    setMemberPeriods({});
  }, [partVersion, aggregated]);

  const ensureMemberData = useCallback(async () => {
    if (!aggregated || !aggregatedMembers || aggregatedMembers.length === 0 || !runId) return;
    if (memberItems) return; // already loaded
    setLoadingMembers(true);
    try {
      const items = await fetchFgMonthlyMembersByIdentity<MemberItem>({
        partVersion,
        mrpRunId: runId,
        dbSource,
        aggregatedMembers,
      }, {
        excludeTest: excludeTestErp,
      });
      setMemberItems(items);
      if (items.length > 0) {
        const periods = await fetchFgMonthlyPeriodsByIdentity<PeriodDetail>(items, false);
        setMemberPeriods(periods);
      }
    } finally {
      setLoadingMembers(false);
    }
  }, [aggregated, aggregatedMembers, memberItems, partVersion, runId, dbSource, excludeTestErp]);

  const toggleMetric = useCallback(
    (metric: keyof PeriodDetail) => {
      if (!aggregated || !aggregatedMembers || aggregatedMembers.length === 0) return;
      const wasOpen = expandedMetrics.has(metric);
      setExpandedMetrics((prev) => {
        const next = new Set(prev);
        if (wasOpen) next.delete(metric);
        else next.add(metric);
        return next;
      });
      if (!wasOpen) ensureMemberData();
    },
    [aggregated, aggregatedMembers, expandedMetrics, ensureMemberData],
  );

  /** Render the inline drill-down rows beneath a metric.
   *  Members are grouped by `erpPartNo` (same ERP = shared physical production),
   *  with a primary row per ERP showing the SUMMED metric value across that ERP's
   *  variants, and a compact list of constituent customer-part-versions beneath. */
  const renderMemberDrilldown = (
    metric: keyof PeriodDetail,
    cellBgClass: string,
  ): React.ReactNode => {
    if (!expandedMetrics.has(metric)) return null;
    if (!aggregated || !aggregatedMembers || aggregatedMembers.length === 0) return null;
    if (loadingMembers) {
      return (
        <tr className="border-b border-slate-200">
          <td
            className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-[11px] italic text-slate-400 border-r-2 border-slate-300"
          >
            載入聚合成員中...
          </td>
          <td colSpan={periods.length} className="bg-slate-50" />
        </tr>
      );
    }
    if (!memberItems || memberItems.length === 0) {
      return (
        <tr className="border-b border-slate-200">
          <td
            className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-[11px] italic text-slate-400 border-r-2 border-slate-300"
          >
            （無聚合成員資料）
          </td>
          <td colSpan={periods.length} className="bg-slate-50" />
        </tr>
      );
    }

    // Group members by ERP. Variants without an ERP fall into their own "none" bucket.
    const groupsByErp = new Map<string, MemberItem[]>();
    for (const m of memberItems) {
      const k = m.erpPartNo || '(無 ERP)';
      const arr = groupsByErp.get(k);
      if (arr) arr.push(m);
      else groupsByErp.set(k, [m]);
    }
    const erpKeys = Array.from(groupsByErp.keys()).sort();

    return erpKeys.flatMap((erp, ei) => {
      const variants = groupsByErp.get(erp)!;
      const isLastErp = ei === erpKeys.length - 1;
      // Sum each period's metric value across this ERP's variants
      const erpTotalsByPeriod = new Map<number, number>();
      for (const v of variants) {
        const vp = memberPeriods[v.partVersion] || [];
        for (const pd of vp) {
          const cur = erpTotalsByPeriod.get(pd.periodIndex) || 0;
          erpTotalsByPeriod.set(pd.periodIndex, cur + (Number(pd[metric] as number) || 0));
        }
      }
      // The primary ERP row gets the indigo cap when (a) it's the last ERP AND (b) it has no
      // per-variant breakdown beneath it (single variant case). Otherwise dashed separator.
      const erpRowBorder = isLastErp && variants.length === 1
        ? 'border-b-2 border-indigo-200'
        : 'border-b border-dashed border-slate-300';

      return [
        // Primary row per ERP — bold label + summed values. The constituent customer-part-versions
        // are shown beneath as their own rows (no inline list here, otherwise the sticky first
        // column gets pushed too wide).
        <tr
          key={`drill-${metric}-erp-${erp}`}
          className={erpRowBorder}
        >
          <td
            className="sticky left-0 z-10 bg-slate-100 border-r-2 border-slate-300 px-3 py-1.5 text-[10px] leading-tight whitespace-nowrap"
            style={{ width: 220, minWidth: 220, maxWidth: 220 }}
          >
            <div className="flex items-baseline gap-1">
              <span className="text-slate-400 text-[9px]">└</span>
              <span className="font-semibold text-slate-700">ERP</span>
              <span
                className="font-mono text-slate-700 truncate inline-block max-w-[150px] align-bottom"
                title={erp}
              >
                {erp}
              </span>
              {variants.length > 1 && (
                <span className="text-[8px] bg-indigo-100 text-indigo-700 px-1 rounded">
                  ×{variants.length}
                </span>
              )}
            </div>
          </td>
          {periods.map((p) => {
            const v = erpTotalsByPeriod.get(p.periodIndex) || 0;
            return (
              <td
                key={`${metric}-erp-${erp}-${p.periodIndex}`}
                className={`px-2 py-1.5 text-right font-mono text-[11px] border-r border-slate-200 ${cellBgClass}`}
              >
                {runId && isFgMonthlySourceMetric(metric) ? (
                  <button
                    type="button"
                    onClick={() => onShowPeriodSource({
                      partVersion: variants[0]?.partVersion || partVersion,
                      memberPartVersions: variants.map((variant) => variant.partVersion),
                      mrpRunId: runId,
                      dbSource,
                      metric,
                      period: { ...p, [metric]: v },
                    })}
                    className={`font-mono underline decoration-dotted underline-offset-1 hover:decoration-solid ${
                      v === 0 ? 'text-slate-300' : 'font-medium text-slate-700'
                    }`}
                    title={`查看 ERP ${erp} 的${FG_MONTHLY_SOURCE_METRIC_LABELS[metric]}來源明細`}
                  >
                    {v.toLocaleString()}
                  </button>
                ) : v === 0 ? <span className="text-slate-300">0</span> : (
                  <span className="font-medium text-slate-700">{v.toLocaleString()}</span>
                )}
              </td>
            );
          })}
        </tr>,
        // If multiple variants share this ERP, list their per-variant breakdown beneath
        // (lighter weight, so the ERP-level total stays the visual anchor).
        ...(variants.length > 1
          ? variants.map((m, vi) => {
              const mPeriods = memberPeriods[m.partVersion] || [];
              const isLastVariant = vi === variants.length - 1;
              return (
                <tr
                  key={`drill-${metric}-erp-${erp}-v-${m.id}`}
                  className={
                    isLastVariant && isLastErp
                      ? 'border-b-2 border-indigo-200'
                      : isLastVariant
                        ? 'border-b border-slate-300'
                        : 'border-b border-dotted border-slate-200'
                  }
                >
                  <td
                    className="sticky left-0 z-10 bg-slate-50 border-r-2 border-slate-300 px-3 py-1 text-[10px] leading-tight text-slate-500 whitespace-nowrap"
                    style={{ width: 220, minWidth: 220, maxWidth: 220 }}
                  >
                    <div className="flex items-baseline gap-1 pl-3">
                      <span className="text-slate-300 text-[9px]">·</span>
                      <span className="font-semibold">{m.customerCode || '—'}</span>
                      <span className="text-slate-300">·</span>
                      <span
                        className="font-mono text-[9px] truncate inline-block max-w-[160px] align-bottom"
                        title={m.partVersion}
                      >
                        {m.partVersion}
                      </span>
                    </div>
                  </td>
                  {periods.map((p) => {
                    const mp = mPeriods.find((x) => x.periodIndex === p.periodIndex);
                    const v = mp ? Number(mp[metric] as number) || 0 : 0;
                    return (
                      <td
                        key={`${metric}-${m.id}-${p.periodIndex}`}
                        className={`px-2 py-1 text-right font-mono text-[10px] border-r border-slate-200 bg-slate-50`}
                      >
                        {runId && isFgMonthlySourceMetric(metric) ? (
                          <button
                            type="button"
                            onClick={() => onShowPeriodSource({
                              partVersion: m.partVersion,
                              mrpRunId: runId,
                              dbSource,
                              metric,
                              period: mp ?? { ...p, [metric]: v },
                            })}
                            className={`font-mono underline decoration-dotted underline-offset-1 hover:decoration-solid ${
                              v === 0 ? 'text-slate-300' : 'text-slate-500'
                            }`}
                            title={`查看 ${m.partVersion} 的${FG_MONTHLY_SOURCE_METRIC_LABELS[metric]}來源明細`}
                          >
                            {v.toLocaleString()}
                          </button>
                        ) : v === 0 ? <span className="text-slate-300">0</span> : (
                          <span className="text-slate-500">{v.toLocaleString()}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          : isLastErp
            ? []
            : []),
      ];
    });
  };

  const isMetricExpandable = aggregated && (aggregatedMembers?.length ?? 0) > 0;
  const metricLabelClass = isMetricExpandable ? 'cursor-pointer hover:opacity-90 select-none' : '';
  const metricChevron = (metric: keyof PeriodDetail) => {
    if (!isMetricExpandable) return null;
    const isOpen = expandedMetrics.has(metric);
    return (
      <span className={`inline-block transition-transform mr-1 text-[10px] ${isOpen ? 'rotate-90' : ''}`}>
        ▸
      </span>
    );
  };

  // Plan editing state — each plan has editable fields matching Ragic Form 22
  // 'saved' means user pressed Save (read-only until transferred)
  // 'transferred' means Ragic 生產計畫已建立 (locked)
  const [planEdits, setPlanEdits] = useState<Record<number, {
    startPeriod: string;
    fulfillPeriod: string;
    qty: string;
    completionDate: string;
    materialKg: string;
    bufferPct: string;
    isSaved: boolean;
    isTransferred: boolean;
    transferStatus: TransferStatus;
    transferError?: string | null;
    ragicPlanNo?: string | null;
    ragicUrl?: string | null;
    transferId?: number | null;
    ragicRecordId?: string | null;
    workOrderStatus?: WorkOrderStatus | null;
    workOrderError?: string | null;
  }>>({});
  const [savingPlan, setSavingPlan] = useState<number | null>(null);
  // 建立生產計畫中的 seq（null = 沒在處理）+ 已等待秒數 + 防關分頁
  const [transferringSeq, setTransferringSeq] = useState<number | null>(null);
  const [transferElapsed, setTransferElapsed] = useState(0);

  const handleWorkOrderChange = (
    seq: number,
    update: ProductionPlanWorkOrderUpdate,
  ) => {
    setPlanEdits((current) => ({
      ...current,
      [seq]: { ...current[seq]!, ...update },
    }));
    onSuggestionsUpdate(suggestions.map((suggestion) => (
      suggestion.planSequence === seq ? { ...suggestion, ...update } : suggestion
    )));
  };

  useEffect(() => {
    if (transferringSeq === null) { setTransferElapsed(0); return; }
    const t = setInterval(() => setTransferElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [transferringSeq]);

  useEffect(() => {
    if (transferringSeq === null) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [transferringSeq]);

  // 轉單中 / 儲存中 / 有未存的規劃編輯 → 回報忙碌，延後「自動切換到最新 MRP」
  const hasUnsavedEdits = Object.values(planEdits).some(
    (e) => e && !e.isSaved && !e.isTransferred && e.qty,
  );
  useEffect(() => {
    setBusy('fg-plan-editor', transferringSeq !== null || savingPlan !== null || hasUnsavedEdits);
    return () => setBusy('fg-plan-editor', false);
  }, [transferringSeq, savingPlan, hasUnsavedEdits, setBusy]);

  // Plan validation: enforce ordering & fulfill >= start
  const { planErrors, planErrorFields } = useMemo(() => {
    const errors: Record<number, string[]> = { 1: [], 2: [], 3: [] };
    const fields: Record<number, Set<string>> = { 1: new Set(), 2: new Set(), 3: new Set() };
    for (let seq = 1; seq <= 3; seq++) {
      const edit = planEdits[seq];
      if (!edit) continue;
      const sp = parseFloat(edit.startPeriod) || 0;
      const fp = parseFloat(edit.fulfillPeriod) || 0;
      if (edit.qty !== '' && parsePositivePlanQty(edit.qty) === null) {
        errors[seq].push('生產計畫量必須大於 0');
        fields[seq].add('qty');
      }
      if (sp <= 0 && fp <= 0) continue;
      if (fp > 0 && sp > 0 && fp < sp) {
        errors[seq].push(`滿足至?期數 (${fp}) 必須 ≥ 目標開始期 (${sp})`);
        fields[seq].add('fulfillPeriod');
      }
      if (seq > 1) {
        const prev = planEdits[seq - 1];
        if (prev) {
          const prevSp = parseFloat(prev.startPeriod) || 0;
          const prevFp = parseFloat(prev.fulfillPeriod) || 0;
          if (sp > 0 && prevSp > 0 && sp <= prevSp) {
            errors[seq].push(`目標開始期 (${sp}) 必須 > 規劃#${seq - 1} (${prevSp})`);
            fields[seq].add('startPeriod');
          }
          if (fp > 0 && prevFp > 0 && fp <= prevFp) {
            errors[seq].push(`滿足至?期數 (${fp}) 必須 > 規劃#${seq - 1} (${prevFp})`);
            fields[seq].add('fulfillPeriod');
          }
        }
      }
    }
    return { planErrors: errors, planErrorFields: fields };
  }, [planEdits]);

  // Initialize plan edits from suggestions — preserve unsaved local edits
  const [suggestionsInitialized, setSuggestionsInitialized] = useState(false);
  useEffect(() => {
    setPlanEdits((prev) => {
      const edits: typeof prev = {};
      for (const s of suggestions) {
        const existing = prev[s.planSequence];
        // Keep unsaved local edits if we already initialized once
        if (existing && !existing.isSaved && !existing.isTransferred && suggestionsInitialized) {
          edits[s.planSequence] = existing;
        } else {
          edits[s.planSequence] = {
            startPeriod: String(s.targetStartPeriod),
            fulfillPeriod: String(s.fulfillToPeriod),
            qty: String(s.suggestedQty),
            completionDate: s.completionDate ? s.completionDate.split('T')[0] : '',
            materialKg: String(s.materialWeightKg),
            bufferPct: String((Number(s.bufferPct) * 100).toFixed(0)),
            isSaved: s.useManualQty,
            isTransferred: s.isTransferred,
            transferStatus: s.isTransferred
              ? TRANSFER_STATUS.SUCCEEDED
              : s.transferStatus ?? TRANSFER_STATUS.IDLE,
            transferError: s.transferError,
            ragicPlanNo: s.ragicPlanNo,
            ragicUrl: s.ragicUrl,
            transferId: s.transferId,
            ragicRecordId: s.ragicRecordId,
            workOrderStatus: s.workOrderStatus,
            workOrderError: s.workOrderError,
          };
        }
      }
      for (let seq = 1; seq <= 3; seq++) {
        if (!edits[seq]) {
          const existing = prev[seq];
          if (existing && !existing.isSaved && !existing.isTransferred && suggestionsInitialized) {
            edits[seq] = existing;
          } else {
            edits[seq] = {
              startPeriod: '', fulfillPeriod: '', qty: '', completionDate: '',
              materialKg: '', bufferPct: String(DEFAULT_BUFFER_PCT),
              isSaved: false, isTransferred: false,
              transferStatus: TRANSFER_STATUS.IDLE,
            };
          }
        }
      }
      return edits;
    });
    setSuggestionsInitialized(true);
  }, [suggestions, suggestionsInitialized]);

  // Save a single plan — returns true on success
  const savePlan = async (seq: number): Promise<boolean> => {
    const edit = planEdits[seq];
    if (!edit || !edit.qty) return false;
    const bufferDecimal = (parseFloat(edit.bufferPct) || 0) / 100;
    const qty = parsePositivePlanQty(edit.qty);
    if (qty === null) return false;
    const res = await fetch(
      `/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          planSequence: seq,
          suggestedQty: qty,
          completionDate: edit.completionDate,
          targetStartPeriod: parseInt(edit.startPeriod) || 0,
          fulfillToPeriod: parseFloat(edit.fulfillPeriod) || 0,
          materialWeightKg: computeMaterialKg(qty, mainMaterialKg, unitWeightG),
          bufferPct: bufferDecimal,
        }),
      },
    );
    if (!res.ok) return false;
    setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, isSaved: true } }));
    // 存計畫改了 qty → 砍主列表/開單規劃快取，下次切回不顯示舊值
    cacheInvalidate((k) => k.startsWith('/api/fg-monthly') || k.startsWith('/api/plan-management'));
    return true;
  };

  const refreshAfterSave = async () => {
    const periodsRes = await fetch(`/api/fg-monthly/${encodeURIComponent(partVersion)}/periods?runId=${runId}`);
    const periodsJson = await periodsRes.json();
    onSuggestionsUpdate(periodsJson.suggestions || []);
  };

  const handlePlanSave = async (seq: number) => {
    if (isReadOnly) return;
    setSavingPlan(seq);
    try {
      const ok = await savePlan(seq);
      if (ok) await refreshAfterSave();
    } catch (err) {
      console.error('Failed to save plan:', err);
    } finally {
      setSavingPlan(null);
    }
  };

  // Save All — saves all unsaved plans with values, in order
  const handleSaveAll = async () => {
    if (isReadOnly) return;
    setSavingPlan(-1);
    try {
      for (let seq = 1; seq <= 3; seq++) {
        const edit = planEdits[seq];
        if (!edit || edit.isSaved || edit.isTransferred) continue;
        if (!edit.qty || planErrors[seq].length > 0) continue;
        const ok = await savePlan(seq);
        if (!ok) break;
      }
      await refreshAfterSave();
    } catch (err) {
      console.error('Failed to save plans:', err);
    } finally {
      setSavingPlan(null);
    }
  };

  const handleTransfer = async (seq: number) => {
    if (isReadOnly) return;
    const edit = planEdits[seq];
    if (!edit) return;
    if (isTransferBlocked(edit.transferStatus)) {
      showToast({ type: 'info', message: edit.transferStatus === TRANSFER_STATUS.UNKNOWN
        ? '前次轉單結果待確認，為避免重複建單已暫停重試。'
        : '此規劃正在轉單，請勿重複送出。' });
      return;
    }

    const inventoryWarning = inventoryAnomalyCount > 0
      ? `\n\n注意：此料號有 ${inventoryAnomalyCount} 筆庫存批號可能尚未同步，差異絕對值合計 ${inventoryAnomalyDiffPc.toLocaleString()} pc。MRP 仍採 Ragic 原值。`
      : '';
    const ok = await confirmDialog({
      title: inventoryAnomalyCount > 0 ? '確認庫存異常後建立生產計畫' : '建立生產計畫',
      message: `確定要在 Ragic 建立規劃#${seq}的生產計畫？\n數量: ${edit.qty}\n完成日: ${edit.completionDate || '—'}${inventoryWarning}\n\n此步驟不會產生工令單；建立完成後再由使用者確認並執行。`,
      confirmText: '建立生產計畫',
    });
    if (!ok) return;

    setSavingPlan(seq);
    setTransferringSeq(seq);
    try {
      const res = await fetch(
        `/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            planSequence: seq,
            isTransferred: true,
            returnSuggestions: true,
            inventoryAnomalyAcknowledged: inventoryAnomalyCount > 0,
          }),
        },
      );
      const resJson = await res.json();

      if (res.ok) {
        const t = resJson.transfer;
        // 轉單改變狀態 + 新增生產計畫列 → 砍相關快取，切回看到最新
        cacheInvalidate((k) =>
          k.startsWith('/api/fg-monthly') || k.startsWith('/api/plan-management') || k.startsWith('/api/production-plans'),
        );
        setPlanEdits((prev) => ({
          ...prev,
          [seq]: {
            ...prev[seq]!,
            isTransferred: true,
            isSaved: true,
            transferStatus: TRANSFER_STATUS.SUCCEEDED,
            transferError: null,
            ragicPlanNo: t?.ragicPlanNo || null,
            ragicUrl: t?.ragicUrl || null,
          },
        }));
        const planLabel = t?.ragicPlanNo ? ` ${t.ragicPlanNo}` : '';
        const recordTag = t?.ragicRecordId ? `（Record ${t.ragicRecordId}）` : '';
        showToast({
          type: 'success',
          message: `生產計畫建立成功！${planLabel}${recordTag}`,
          action: t?.ragicUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(t.ragicUrl, '_blank') }
            : undefined,
        });

        // PATCH 已帶回刷新後的 suggestions，直接用，省掉第二次 GET /periods。
        // 萬一未帶（相容性）才 fallback GET，失敗只提示手動刷新、不影響已成功的轉單。
        if (Array.isArray(resJson.suggestions)) {
          onSuggestionsUpdate(resJson.suggestions);
        } else {
          try {
            const periodsRes = await fetch(`/api/fg-monthly/${encodeURIComponent(partVersion)}/periods`);
            const periodsJson = await periodsRes.json();
            onSuggestionsUpdate(periodsJson.suggestions || []);
          } catch {
            showToast({ type: 'info', message: '生產計畫已建立，但畫面同步失敗，請手動刷新頁面確認。' });
          }
        }
      } else {
        if (resJson.code === 'INVENTORY_ANOMALY_CONFIRMATION_REQUIRED') {
          showToast({ type: 'error', message: `${resJson.error} 請重新整理後確認最新庫存警告。` });
          return;
        }
        const status = resJson.transferStatus as TransferStatus | undefined;
        const nextStatus = status ?? TRANSFER_STATUS.UNKNOWN;
        setPlanEdits((prev) => ({
          ...prev,
          [seq]: { ...prev[seq]!, transferStatus: nextStatus, transferError: resJson.error || null },
        }));
        showToast({
          type: isTransferBlocked(nextStatus) ? 'info' : 'error',
          message: !status
            ? '伺服器未能確認轉單結果；請重新整理後確認狀態，勿直接重試。'
            : isTransferBlocked(nextStatus)
            ? friendlyTransferError(resJson.error)
            : `轉單失敗：${friendlyTransferError(resJson.error)}`,
        });
      }
    } catch (err) {
      console.error('Failed to transfer plan:', err);
      setPlanEdits((prev) => ({
        ...prev,
        [seq]: {
          ...prev[seq]!,
          transferStatus: TRANSFER_STATUS.UNKNOWN,
          transferError: err instanceof Error ? err.message : '網路錯誤',
        },
      }));
      showToast({ type: 'info', message: '連線中斷，轉單結果待確認；請重新整理後確認狀態，勿直接重試。' });
    } finally {
      setSavingPlan(null);
      setTransferringSeq(null);
    }
  };

  const ClickableCell = ({
    value,
    metric,
    period,
  }: {
    value: number;
    metric: FgMonthlySourceMetric;
    period: PeriodDetail;
  }) => {
    if (!runId) {
      return (
        <span className={`font-mono text-xs ${value === 0 ? 'opacity-40' : ''}`}>
          {value.toLocaleString()}
        </span>
      );
    }
    return (
      <button
        type="button"
        className={`font-mono text-xs underline decoration-dotted underline-offset-1 hover:decoration-solid cursor-pointer ${
          value === 0 ? 'opacity-40' : ''
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onShowPeriodSource({
            partVersion,
            memberPartVersions: aggregated ? aggregatedMembers ?? undefined : undefined,
            mrpRunId: runId,
            dbSource,
            metric,
            period,
          });
        }}
        title={`查看${FG_MONTHLY_SOURCE_METRIC_LABELS[metric]} ${period.periodLabel}來源明細`}
      >
        {value.toLocaleString()}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {/* ===== Horizontal month grid matching Ragic Form 22 ===== */}
      <div className="overflow-x-auto border border-slate-300 rounded-lg">
        <table className="text-xs border-collapse w-full" style={{ minWidth: `${140 + periods.length * 85}px` }}>
          <thead>
            <tr className="bg-slate-100 border-b-2 border-slate-400">
              <th className="sticky left-0 z-20 bg-slate-100 px-3 py-2 text-left font-bold text-slate-700 border-r-2 border-slate-400 w-40 whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  可用成品庫存pc:
                  <SharedBalanceValue
                    value={Number(currentStockPc)}
                    label="可用成品庫存pc"
                    sharedErpCount={sharedErpCount}
                    erpPartNo={erpPartNo}
                  />
                </span>
              </th>
              {periods.map((p) => (
                <th
                  key={p.periodIndex}
                  className="px-2 py-2 text-center font-bold text-slate-700 border-r border-slate-300 min-w-[80px] whitespace-nowrap"
                >
                  Mth#{p.periodIndex + 1}
                  <div className="font-normal text-slate-500">{p.periodLabel}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 剩餘庫存 — Dark Green (no hover color change) */}
            <tr className="border-b border-slate-200">
              <td className="sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-emerald-800 text-white whitespace-nowrap">
                剩餘庫存
              </td>
              {periods.map((p) => {
                const val = Number(p.remainingStock);
                return (
                  <td
                    key={p.periodIndex}
                    className={`px-2 py-1.5 text-right font-mono border-r border-slate-200 ${
                      val < 0 ? 'bg-red-100 text-red-800 font-bold' : 'bg-emerald-50 text-emerald-900'
                    }`}
                  >
                    <StockCalculationValue
                      value={val}
                      label={`剩餘庫存 ${p.periodLabel}`}
                      sharedErpCount={sharedErpCount}
                      erpPartNo={erpPartNo}
                      onExplain={() => openStockCalculation(p.periodIndex, 'withPlan')}
                    />
                  </td>
                );
              })}
            </tr>

            {/* [需求整合] — Purple */}
            <tr className="border-b border-slate-200">
              <td className="sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-purple-600 text-white whitespace-nowrap">
                [需求整合]
              </td>
              {periods.map((p) => (
                <td key={p.periodIndex} className="px-2 py-1.5 text-right font-mono border-r border-slate-200 bg-purple-50 text-purple-900">
                  <ClickableCell
                    value={Number(p.demandIntegrated)}
                    metric="demandIntegrated"
                    period={p}
                  />
                </td>
              ))}
            </tr>

            {/* [訂單未結] — Light Green */}
            <tr className="border-b border-slate-200">
              <td
                className={`sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-green-200 text-green-900 whitespace-nowrap ${metricLabelClass}`}
                onClick={() => toggleMetric('ordersUnshipped')}
                title={isMetricExpandable ? '展開／收起聚合來源' : undefined}
              >
                {metricChevron('ordersUnshipped')}[訂單未結]
              </td>
              {periods.map((p) => (
                <td key={p.periodIndex} className="px-2 py-1.5 text-right border-r border-slate-200 bg-green-50">
                  <ClickableCell
                    value={Number(p.ordersUnshipped)}
                    metric="ordersUnshipped"
                    period={p}
                  />
                </td>
              ))}
            </tr>
            {renderMemberDrilldown('ordersUnshipped', 'bg-green-50/60')}

            {/* [預示量] — Blue */}
            <tr className="border-b border-slate-200">
              <td
                className={`sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-blue-500 text-white whitespace-nowrap ${metricLabelClass}`}
                onClick={() => toggleMetric('forecastQty')}
                title={isMetricExpandable ? '展開／收起聚合來源' : undefined}
              >
                {metricChevron('forecastQty')}[預示量]
              </td>
              {periods.map((p) => (
                <td key={p.periodIndex} className="px-2 py-1.5 text-right border-r border-slate-200 bg-blue-50">
                  <ClickableCell
                    value={Number(p.forecastQty)}
                    metric="forecastQty"
                    period={p}
                  />
                </td>
              ))}
            </tr>
            {renderMemberDrilldown('forecastQty', 'bg-blue-50/60')}

            {/* [計畫前期產出] — Yellow */}
            <tr className="border-b border-slate-200">
              <td
                className={`sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-yellow-300 text-yellow-900 whitespace-nowrap ${metricLabelClass}`}
                onClick={() => toggleMetric('plannedOutput')}
                title={isMetricExpandable ? '展開／收起聚合來源' : undefined}
              >
                {metricChevron('plannedOutput')}[計畫前期產出]
              </td>
              {periods.map((p) => (
                <td key={p.periodIndex} className="px-2 py-1.5 text-right border-r border-slate-200 bg-yellow-50">
                  <ClickableCell
                    value={Number(p.plannedOutput)}
                    metric="plannedOutput"
                    period={p}
                  />
                </td>
              ))}
            </tr>
            {renderMemberDrilldown('plannedOutput', 'bg-yellow-50/60')}

            {/* [訂單總量] — Gray */}
            <tr className="border-b border-slate-200">
              <td
                className={`sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-gray-300 text-gray-800 whitespace-nowrap ${metricLabelClass}`}
                onClick={() => toggleMetric('ordersTotal')}
                title={isMetricExpandable ? '展開／收起聚合來源' : undefined}
              >
                {metricChevron('ordersTotal')}[訂單總量]
              </td>
              {periods.map((p) => (
                <td key={p.periodIndex} className="px-2 py-1.5 text-right font-mono border-r border-slate-200 bg-gray-50 text-gray-700">
                  <ClickableCell
                    value={Number(p.ordersTotal)}
                    metric="ordersTotal"
                    period={p}
                  />
                </td>
              ))}
            </tr>
            {renderMemberDrilldown('ordersTotal', 'bg-gray-50/60')}

            {/* 剩餘庫存(無計劃量) — Dark teal */}
            <tr className="border-b-2 border-slate-400">
              <td className="sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-teal-700 text-white whitespace-nowrap">
                剩餘庫存(無計劃量)
              </td>
              {periods.map((p) => {
                const val = Number(p.remainingNoPlan);
                return (
                  <td
                    key={p.periodIndex}
                    className={`px-2 py-1.5 text-right font-mono border-r border-slate-200 ${
                      val < 0 ? 'bg-red-100 text-red-800 font-bold' : 'bg-teal-50 text-teal-900'
                    }`}
                  >
                    <StockCalculationValue
                      value={val}
                      label={`剩餘庫存(無計劃量) ${p.periodLabel}`}
                      sharedErpCount={sharedErpCount}
                      erpPartNo={erpPartNo}
                      onExplain={() => openStockCalculation(p.periodIndex, 'withoutPlan')}
                    />
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ===== [生產計畫] 開單規劃 — matching Ragic Form 22 exactly ===== */}
      <div className="border border-yellow-400 rounded-lg bg-yellow-50/50">
        <div className="px-4 py-2 bg-yellow-200 border-b border-yellow-400 font-bold text-sm text-yellow-900 rounded-t-lg flex items-center justify-between">
          <span>[生產計畫] 開單規劃</span>
          {(() => {
            const saveable = [1, 2, 3].filter((s) => {
              const e = planEdits[s];
              return e && !e.isSaved && !e.isTransferred && e.qty && planErrors[s].length === 0;
            });
            return saveable.length > 0 ? (
              <button onClick={handleSaveAll} disabled={savingPlan !== null || isReadOnly}
                className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed">
                {savingPlan === -1 ? '儲存中...' : `全部儲存 (${saveable.length})`}
              </button>
            ) : null;
          })()}
        </div>
        <div className="p-4 space-y-4">
          {[1, 2, 3].map((seq) => {
            const edit = planEdits[seq];
            const isSaving = savingPlan === seq || savingPlan === -1;
            const transferBlocked = isTransferBlocked(edit?.transferStatus);
            const isLocked = edit?.isSaved || edit?.isTransferred || transferBlocked || isReadOnly;
            const isTransferred = edit?.isTransferred;
            // Enforce save order: #N can only save if all prior plans are saved
            const priorUnsaved = seq > 1 && [1, 2, 3].slice(0, seq - 1).some((s) => {
              const pe = planEdits[s];
              return pe && !pe.isSaved && !pe.isTransferred && (pe.qty || pe.startPeriod);
            });

            return (
              <div key={seq} className={`border rounded-lg p-3 ${
                isTransferred ? 'bg-green-50 border-green-300' :
                edit?.isSaved ? 'bg-blue-50 border-blue-200' :
                'bg-white border-slate-200'
              }`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-bold text-sm text-slate-700">規劃#{seq}</span>
                  {isTransferred && (
                    edit?.ragicUrl ? (
                      <a href={edit.ragicUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700 transition-colors">
                        生產計畫{edit.ragicPlanNo ? `（${edit.ragicPlanNo}）` : ''}
                      </a>
                    ) : (
                      <span className="text-xs bg-green-600 text-white px-2 py-0.5 rounded">已建立生產計畫</span>
                    )
                  )}
                  {edit?.isSaved && !isTransferred && edit.transferStatus === TRANSFER_STATUS.IDLE && (
                    <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">已儲存</span>
                  )}
                  {edit?.transferStatus === TRANSFER_STATUS.PENDING && (
                    <span className="text-xs bg-amber-500 text-white px-2 py-0.5 rounded">轉單處理中</span>
                  )}
                  {edit?.transferStatus === TRANSFER_STATUS.UNKNOWN && (
                    <span className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded">轉單結果待確認</span>
                  )}
                  {edit?.transferStatus === TRANSFER_STATUS.FAILED && (
                    <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">前次轉單失敗，可重試</span>
                  )}
                </div>

                {edit?.transferStatus === TRANSFER_STATUS.UNKNOWN && runId !== null && (
                  <TransferReconciliationControls
                    key={`${runId}:${partVersion}:${seq}`}
                    runId={runId}
                    partVersion={partVersion}
                    planSequence={seq}
                    disabled={isReadOnly}
                    onResolved={refreshAfterSave}
                  />
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 text-xs">
                  {/* #N目標開始期(完成日) */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">#{seq}目標開始期</label>
                    <input
                      type="number"
                      min="0"
                      max="12"
                      value={edit?.startPeriod || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        const periodNum = parseInt(val, 10);
                        // Completion date = 1st of target month − 7 days
                        let autoDate = edit?.completionDate || '';
                        if (periodNum > 0 && periodNum <= periods.length) {
                          const p = periods[periodNum - 1];
                          if (p?.periodLabel) {
                            const [y, m] = p.periodLabel.split('/').map(Number);
                            const d = new Date(y, m - 1, 1);
                            d.setDate(d.getDate() - 7);
                            autoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                          }
                        }
                        setPlanEdits((prev) => ({
                          ...prev,
                          [seq]: { ...prev[seq]!, startPeriod: val, completionDate: autoDate },
                        }));
                      }}
                      disabled={isLocked}
                      className={`w-full px-2 py-1.5 border rounded text-xs font-mono disabled:bg-slate-100 disabled:text-slate-500 ${planErrorFields[seq].has('startPeriod') ? 'bg-red-100 border-red-400' : 'border-slate-300'}`}
                      placeholder="期數"
                    />
                  </div>

                  {/* #N滿足至?期數(數量) */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">#{seq}滿足至?期數</label>
                    <input
                      type="number"
                      min="0"
                      max="12"
                      step="0.5"
                      value={edit?.fulfillPeriod || ''}
                      title={!autoRecalculatePlanQty ? '共用 ERP 庫存規劃保留共享池建議量；請手動確認數量' : undefined}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!autoRecalculatePlanQty) {
                          setPlanEdits((prev) => ({
                            ...prev,
                            [seq]: { ...prev[seq]!, fulfillPeriod: val },
                          }));
                          return;
                        }
                        const fp = parseFloat(val) || 0;
                        const bp = parseFloat(edit?.bufferPct || '0') || 0;
                        // Sum qty from earlier plans
                        let priorQty = 0;
                        for (let s = 1; s < seq; s++) {
                          priorQty += parseFloat(planEdits[s]?.qty || '0') || 0;
                        }
                        const autoQty = computeFulfillmentPlanQty(periods, fp, bp, priorQty);
                        setPlanEdits((prev) => {
                          const next = {
                            ...prev,
                            [seq]: { ...prev[seq]!, fulfillPeriod: val, qty: String(autoQty || '') },
                          };
                          // Cascade recalculate subsequent plans
                          for (let s = seq + 1; s <= 3; s++) {
                            const plan = next[s];
                            if (!plan || (parseFloat(plan.fulfillPeriod || '0') || 0) <= 0) continue;
                            const sFp = parseFloat(plan.fulfillPeriod || '0') || 0;
                            const sBp = parseFloat(plan.bufferPct || '0') || 0;
                            let sPrior = 0;
                            for (let p = 1; p < s; p++) sPrior += parseFloat(next[p]?.qty || '0') || 0;
                            next[s] = { ...plan, qty: String(computeFulfillmentPlanQty(periods, sFp, sBp, sPrior) || '') };
                          }
                          return next;
                        });
                      }}
                      disabled={isLocked}
                      className={`w-full px-2 py-1.5 border rounded text-xs font-mono disabled:bg-slate-100 disabled:text-slate-500 ${planErrorFields[seq].has('fulfillPeriod') ? 'bg-red-100 border-red-400' : 'border-slate-300'}`}
                      placeholder="期數"
                    />
                  </div>

                  {/* [規劃#N]生產計畫量 */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]生產計畫量</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={edit?.qty || ''}
                      onChange={(e) => {
                        const newQty = e.target.value;
                        if (!autoRecalculatePlanQty) {
                          setPlanEdits((prev) => ({
                            ...prev,
                            [seq]: { ...prev[seq]!, qty: newQty },
                          }));
                          return;
                        }
                        setPlanEdits((prev) => {
                          const next = {
                            ...prev,
                            [seq]: { ...prev[seq]!, qty: newQty },
                          };
                          // Cascade recalculate subsequent plans
                          for (let s = seq + 1; s <= 3; s++) {
                            const plan = next[s];
                            if (!plan || (parseFloat(plan.fulfillPeriod || '0') || 0) <= 0) continue;
                            const sFp = parseFloat(plan.fulfillPeriod || '0') || 0;
                            const sBp = parseFloat(plan.bufferPct || '0') || 0;
                            let sPrior = 0;
                            for (let p = 1; p < s; p++) sPrior += parseFloat(next[p]?.qty || '0') || 0;
                            next[s] = { ...plan, qty: String(computeFulfillmentPlanQty(periods, sFp, sBp, sPrior) || '') };
                          }
                          return next;
                        });
                      }}
                      disabled={isLocked}
                      className={`w-full px-2 py-1.5 border rounded text-xs font-mono disabled:bg-slate-100 disabled:text-slate-500 ${planErrorFields[seq].has('qty') ? 'bg-red-100 border-red-400' : 'border-slate-300'}`}
                      placeholder="數量"
                    />
                  </div>

                  {/* [規劃#N]完成日期 */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]完成日期</label>
                    <input
                      type="date"
                      value={edit?.completionDate || ''}
                      onChange={(e) =>
                        setPlanEdits((prev) => ({
                          ...prev,
                          [seq]: { ...prev[seq]!, completionDate: e.target.value },
                        }))
                      }
                      disabled={isLocked}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs disabled:bg-slate-100 disabled:text-slate-500"
                    />
                  </div>

                  {/* [規劃#N]預計用料重kg — read-only, computed from qty */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]預計用料重kg</label>
                    <input
                      type="text"
                      value={(() => {
                        const q = parseFloat(edit?.qty || '0') || 0;
                        const kg = computeMaterialKg(q, mainMaterialKg, unitWeightG);
                        return kg > 0 ? kg.toFixed(3) : '';
                      })()}
                      readOnly
                      className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs font-mono bg-slate-50 text-slate-500"
                      placeholder="kg"
                    />
                  </div>

                  {/* 加量% — Buffer percentage */}
                  <div>
                    <label className="block text-slate-500 mb-1 whitespace-nowrap">加量%</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={edit?.bufferPct || ''}
                        title={!autoRecalculatePlanQty ? '共用 ERP 庫存規劃保留共享池建議量；請手動確認數量' : undefined}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (!autoRecalculatePlanQty) {
                            setPlanEdits((prev) => ({
                              ...prev,
                              [seq]: { ...prev[seq]!, bufferPct: val },
                            }));
                            return;
                          }
                          const bp = parseFloat(val) || 0;
                          const fp = parseFloat(edit?.fulfillPeriod || '0') || 0;
                          let priorQty = 0;
                          for (let s = 1; s < seq; s++) {
                            priorQty += parseFloat(planEdits[s]?.qty || '0') || 0;
                          }
                          const autoQty = fp > 0 ? computeFulfillmentPlanQty(periods, fp, bp, priorQty) : 0;
                          setPlanEdits((prev) => {
                            const next = {
                              ...prev,
                              [seq]: {
                                ...prev[seq]!,
                                bufferPct: val,
                                ...(fp > 0 ? { qty: String(autoQty || '') } : {}),
                              },
                            };
                            // Cascade recalculate subsequent plans
                            for (let s = seq + 1; s <= 3; s++) {
                              const plan = next[s];
                              if (!plan || (parseFloat(plan.fulfillPeriod || '0') || 0) <= 0) continue;
                              const sFp = parseFloat(plan.fulfillPeriod || '0') || 0;
                              const sBp = parseFloat(plan.bufferPct || '0') || 0;
                              let sPrior = 0;
                              for (let p = 1; p < s; p++) sPrior += parseFloat(next[p]?.qty || '0') || 0;
                              next[s] = { ...plan, qty: String(computeFulfillmentPlanQty(periods, sFp, sBp, sPrior) || '') };
                            }
                            return next;
                          });
                        }}
                        disabled={isLocked}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs font-mono disabled:bg-slate-100 disabled:text-slate-500"
                        placeholder="%"
                      />
                      <span className="text-slate-400">%</span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-end gap-2 col-span-1">
                    {!isTransferred && !edit?.isSaved && (
                      <button
                        onClick={() => handlePlanSave(seq)}
                        disabled={isSaving || !edit?.qty || planErrors[seq].length > 0 || priorUnsaved || isReadOnly}
                        title={priorUnsaved ? `請先儲存規劃#${seq - 1}` : undefined}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {isSaving ? '...' : '儲存'}
                      </button>
                    )}
                    {edit?.isSaved && !isTransferred && !transferBlocked && (
                      <>
                        <button
                          onClick={() =>
                            setPlanEdits((prev) => ({
                              ...prev,
                              [seq]: { ...prev[seq]!, isSaved: false },
                            }))
                          }
                          disabled={isReadOnly}
                          className="px-3 py-1.5 border border-slate-400 text-slate-600 rounded text-xs hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          編輯#{seq}
                        </button>
                        <button
                          onClick={() => handleTransfer(seq)}
                          disabled={isSaving || isReadOnly}
                          className="px-3 py-1.5 bg-amber-500 text-white rounded text-xs hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed whitespace-nowrap"
                          title="在 Ragic 建立生產計畫"
                        >
                          {transferringSeq === seq ? `建立中 ${transferElapsed}s` : isSaving ? '...' : `建立生產計畫#${seq}`}
                        </button>
                      </>
                    )}
                    {isTransferred && (
                      edit?.ragicUrl ? (
                        <a href={edit.ragicUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-green-700 font-semibold py-1.5 underline hover:text-green-900">
                          生產計畫{edit.ragicPlanNo ? `（${edit.ragicPlanNo}）` : ''}
                        </a>
                      ) : (
                        <span className="text-xs text-green-700 font-semibold py-1.5">已建立生產計畫</span>
                      )
                    )}
                    {isTransferred && (
                      <ProductionPlanWorkOrderAction
                        transferId={edit?.transferId}
                        ragicRecordId={edit?.ragicRecordId}
                        ragicPlanNo={edit?.ragicPlanNo}
                        ragicUrl={edit?.ragicUrl}
                        initialStatus={edit?.workOrderStatus}
                        initialError={edit?.workOrderError}
                        disabled={isReadOnly}
                        onChange={(update) => handleWorkOrderChange(seq, update)}
                      />
                    )}
                  </div>
                </div>
                {planErrors[seq].length > 0 && (
                  <div className="mt-1.5 text-xs text-red-600">
                    {planErrors[seq].map((err, i) => <div key={i}>{err}</div>)}
                  </div>
                )}
                {priorUnsaved && !isLocked && edit?.qty && (
                  <div className="mt-1.5 text-xs text-amber-600">請先儲存規劃#{seq - 1}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {stockCalculation && (
        <StockCalculationDrawer
          detail={stockCalculation}
          onClose={closeStockCalculation}
        />
      )}
    </div>
  );
}

function FgMonthlyPeriodSourceDrawer({
  request,
  sections,
  loading,
  error,
  onRetry,
  onClose,
}: {
  request: FgMonthlyPeriodSourceRequest;
  sections: FgMonthlySourceSection[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const metricLabel = FG_MONTHLY_SOURCE_METRIC_LABELS[request.metric];
  const value = Number(request.period[request.metric]) || 0;
  const demandExplanation = request.metric === 'demandIntegrated'
    ? fgMonthlyDemandExplanation(
      request.period,
      (request.memberPartVersions?.length ?? 0) > 0,
    )
    : null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/30 p-3 sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="fg-monthly-source-title"
        className="relative flex h-full max-h-[calc(100dvh-1.5rem)] w-full max-w-[1180px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
        data-fg-monthly-period-source-drawer
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3">
          <div className="min-w-0">
            <h3 id="fg-monthly-source-title" className="text-base font-bold text-slate-900">
              成品月推數字來源明細
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">{request.partVersion}</span>
              <span>{request.period.periodLabel}</span>
              <span>Run #{request.mrpRunId}</span>
              {request.dbSource && <span>來源：{request.dbSource}</span>}
              {(request.memberPartVersions?.length ?? 0) > 1 && (
                <span>聚合成員：{request.memberPartVersions!.length}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="關閉成品月推來源明細"
            title="關閉"
          >
            <X size={16} />
          </button>
        </header>

        <section className="border-b border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-xs text-slate-500">{metricLabel}</div>
          <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-slate-900">
            {value.toLocaleString()}
          </div>
          {demandExplanation?.kind === 'formula' && (
            <div className="mt-2 rounded border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-950">
              <div className="font-semibold">需求整合公式</div>
              <div className="mt-1 font-mono">
                max(預示量 {request.period.forecastQty.toLocaleString()}，訂單總量 {request.period.ordersTotal.toLocaleString()})
                {' − '}預示抵扣基礎 {demandExplanation.shippedQty.toLocaleString()}
                {' = '}{demandExplanation.demandIntegrated.toLocaleString()}
              </div>
              <div className="mt-1 text-purple-700">
                預示抵扣基礎 = max(0, 訂單總量 − 訂單未結)；此處兩個訂單數字皆依該 Run 的 MRP 契約認列，一般訂單沿用未出庫量，v2 人工結案只認列實際已出庫量。
              </div>
            </div>
          )}
          {demandExplanation?.kind === 'aggregated' && (
            <div className="mt-2 rounded border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-950">
              <div className="font-semibold">聚合需求整合</div>
              <div className="mt-1">
                各成員先分別套用需求整合公式，再加總為{' '}
                <span className="font-mono font-semibold">
                  {demandExplanation.demandIntegrated.toLocaleString()}
                </span>
                。
              </div>
              <div className="mt-1 text-purple-700">
                聚合列不會對加總後的訂單與預示量重新套用 max。
              </div>
            </div>
          )}
        </section>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {loading ? (
            <div className="flex h-48 items-center justify-center"><Loader label="讀取月推來源明細" /></div>
          ) : error ? (
            <div className="flex h-48 flex-col items-center justify-center gap-3 text-center">
              <AlertTriangle size={22} className="text-amber-600" />
              <p className="text-sm text-slate-700">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <RotateCw size={14} />
                重新讀取
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {sections.map((section) => (
                <section key={section.type} className="overflow-hidden rounded border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-2 text-xs">
                    <h4 className="font-semibold text-slate-700">
                      {section.type === 'orders'
                        ? '訂單明細'
                        : section.type === 'forecasts'
                          ? '預示量明細'
                          : section.type === 'work_orders'
                            ? '鍛造工令明細'
                            : '生產計畫明細'}
                    </h4>
                    <span className="text-slate-500">{section.total} 筆</span>
                  </div>
                  {section.type === 'orders' && section.summary && (
                    <div className="grid grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-4">
                      {[
                        ['訂單總量（MRP認列）', section.summary.recognizedOrderQty, 0],
                        ['訂單未結（MRP認列）', section.summary.outstandingOrderQty, 0],
                        ['預示抵扣基礎', section.summary.demandResolvedQty, 0],
                        ['結案未履行', section.summary.closedUnfulfilledQty, section.summary.unknownClosedUnfulfilledCount],
                      ].map(([label, quantity, unknownCount], index) => (
                        <div
                          key={String(label)}
                          className={`px-3 py-2 ${index > 0 ? 'border-l border-slate-200' : ''}`}
                        >
                          <div className="text-[10px] font-medium text-slate-500">{label}</div>
                          <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-slate-900">
                            {summaryQuantity(Number(quantity), Number(unknownCount))}
                          </div>
                        </div>
                      ))}
                      <div className="col-span-2 border-t border-slate-200 px-3 py-1.5 text-[10px] text-slate-500 sm:col-span-4">
                        {section.contractVersion === 'order-demand-v2-manual-close'
                          ? 'v2：一般訂單以未出庫量承擔需求；人工結案只以實際已出庫量認列。'
                          : '歷史 v1：人工結案整筆排除，保留該 Run 當時的計算契約。'}
                      </div>
                    </div>
                  )}
                  {section.priorRecords.length > 0 && (
                    <div className="border-b border-amber-200 bg-amber-50 p-3">
                      <div className="mb-1 text-xs font-medium text-amber-800">
                        前期逾期：{section.priorRecords.length} 筆
                      </div>
                      <div className="overflow-x-auto">
                        <SourceRecordTable
                          type={section.type}
                          records={section.priorRecords}
                          orderSummary={section.priorSummary}
                        />
                      </div>
                    </div>
                  )}
                  <div className="overflow-x-auto p-3">
                    {section.records.length > 0 ? (
                      <SourceRecordTable
                        type={section.type}
                        records={section.records}
                        orderSummary={section.summary}
                      />
                    ) : (
                      <div className="py-6 text-center text-xs text-slate-400">此期間查無資料。</div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ============================================================
// Source record tables
// ============================================================
const FG_SOURCE_RAGIC_RECORD_TYPE: Record<FgMonthlySourceType, RagicRecordType> = {
  orders: 'order',
  forecasts: 'forecast',
  production_plans: 'production-plan',
  work_orders: 'work-order',
};

function SourceRecordLink({
  type,
  recordId,
}: {
  type: FgMonthlySourceType;
  recordId: unknown;
}) {
  const href = buildRagicRecordUrl(
    FG_SOURCE_RAGIC_RECORD_TYPE[type],
    recordId == null ? null : String(recordId),
  );
  if (!href) return <span className="text-slate-300">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono font-semibold text-blue-700 underline decoration-dotted underline-offset-2 hover:decoration-solid"
      title="在 Ragic 開啟來源紀錄"
    >
      {String(recordId)}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

function orderContribution(record: Record<string, unknown>): OrderDemandContribution | null {
  const value = record.orderDemandContribution;
  return value && typeof value === 'object'
    ? value as OrderDemandContribution
    : null;
}

function orderAttribution(record: Record<string, unknown>): FgMonthlyOrderAttribution | null {
  const value = record.orderDemandAttribution;
  return value && typeof value === 'object'
    ? value as FgMonthlyOrderAttribution
    : null;
}

function quantityText(value: unknown): React.ReactNode {
  if (value == null || value === '') return <span className="text-slate-300">—</span>;
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : <span className="text-slate-300">—</span>;
}

function stageQuantity(actual: unknown, remaining: number | null | undefined) {
  return (
    <div className="text-right font-mono tabular-nums">
      <div className="font-medium text-slate-800">{quantityText(actual)}</div>
      <div className="mt-0.5 text-[10px] text-slate-400">
        原始差額 {quantityText(remaining)}
      </div>
    </div>
  );
}

function orderBasisLabel(value: OrderDemandContribution['basis'] | undefined) {
  return value ? ORDER_DEMAND_BASIS_LABELS[value] : '—';
}

function summaryQuantity(value: number | undefined, unknownCount: number = 0) {
  if (value === undefined) return <span className="text-slate-300">—</span>;
  return (
    <span>
      {value.toLocaleString()}
      {unknownCount > 0 && <span className="ml-1 text-[10px] text-amber-700">+{unknownCount}筆未知</span>}
    </span>
  );
}

function SourceRecordTable({
  type,
  records,
  orderSummary,
}: {
  type: FgMonthlySourceType;
  records: Record<string, unknown>[];
  orderSummary?: OrderDemandSummary;
}) {
  if (records.length === 0) return null;

  if (type === 'orders') {
    return (
      <table className="w-full min-w-[1840px] table-fixed border-separate border-spacing-0 bg-white text-xs">
        <thead className="bg-slate-50">
          <tr className="text-slate-600">
            <th rowSpan={2} className="w-24 border-b border-slate-200 px-3 py-2 text-center font-semibold">Ragic ID</th>
            <th rowSpan={2} className="w-40 border-b border-slate-200 px-3 py-2 text-left font-semibold">訂單編號</th>
            <th rowSpan={2} className="w-44 border-b border-slate-200 px-3 py-2 text-left font-semibold">料號版本</th>
            <th rowSpan={2} className="w-28 border-b border-slate-200 px-3 py-2 text-center font-semibold">指定出貨日</th>
            <th rowSpan={2} className="w-20 border-b border-slate-200 px-3 py-2 text-center font-semibold">類型</th>
            <th rowSpan={2} className="w-28 border-b border-slate-200 px-3 py-2 text-right font-semibold">原始訂單</th>
            <th colSpan={3} className="border-b border-l border-slate-200 px-3 py-1.5 text-center font-semibold">流程實績／原始差額</th>
            <th rowSpan={2} className="w-28 border-b border-l border-slate-200 px-3 py-2 text-right font-semibold">已備未出庫</th>
            <th colSpan={4} className="border-b border-l border-slate-200 px-3 py-1.5 text-center font-semibold">MRP 判定</th>
            <th rowSpan={2} className="w-64 border-b border-l border-slate-200 px-3 py-2 text-left font-semibold">判定與狀態</th>
          </tr>
          <tr className="text-slate-500">
            <th className="w-32 border-b border-l border-slate-200 px-3 py-1.5 text-right font-medium">實際已備貨</th>
            <th className="w-32 border-b border-slate-200 px-3 py-1.5 text-right font-medium">實際已出庫</th>
            <th className="w-32 border-b border-slate-200 px-3 py-1.5 text-right font-medium">實際已銷貨</th>
            <th className="w-28 border-b border-l border-slate-200 px-3 py-1.5 text-right font-medium">計入訂單</th>
            <th className="w-28 border-b border-slate-200 px-3 py-1.5 text-right font-medium">未出庫需求</th>
            <th className="w-28 border-b border-slate-200 px-3 py-1.5 text-right font-medium">預示抵扣基礎</th>
            <th className="w-28 border-b border-slate-200 px-3 py-1.5 text-right font-medium">結案未履行</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r: Record<string, unknown>, i: number) => {
            const contribution = orderContribution(r);
            const attribution = orderAttribution(r);
            const manualClose = contribution?.isManualClose ?? false;
            return (
              <tr key={String(r.ragicRecordId ?? i)} className={manualClose ? 'bg-amber-50/40 hover:bg-amber-50' : 'hover:bg-blue-50/50'}>
                <td className="border-b border-slate-100 px-3 py-2 text-center"><SourceRecordLink type={type} recordId={r.ragicRecordId} /></td>
                <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.orderNo || '—')}</td>
                <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.partVersion || '—')}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-center">{r.designatedShipDate ? new Date(String(r.designatedShipDate)).toLocaleDateString('zh-TW') : '—'}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-center">{String(r.orderType || '—')}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{quantityText(r.orderQty)}</td>
                <td className="border-b border-l border-slate-100 px-3 py-2">{stageQuantity(r.preparedQty, contribution?.remainingToPrepareQty)}</td>
                <td className="border-b border-slate-100 px-3 py-2">{stageQuantity(r.shippedQty, contribution?.remainingToShipQty)}</td>
                <td className="border-b border-slate-100 px-3 py-2">{stageQuantity(r.soldQty, contribution?.remainingToSellQty)}</td>
                <td className="border-b border-l border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{quantityText(contribution?.preparedNotShippedQty)}</td>
                <td className="border-b border-l border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{quantityText(attribution?.recognizedOrderQty)}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{quantityText(attribution?.outstandingOrderQty)}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{quantityText(attribution?.demandResolvedQty)}</td>
                <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{quantityText(contribution?.closedUnfulfilledQty)}</td>
                <td className="border-b border-l border-slate-100 px-3 py-2">
                  <div className={manualClose ? 'font-medium text-amber-800' : 'font-medium text-slate-700'}>
                    {attribution
                      ? FG_MONTHLY_ORDER_ATTRIBUTION_LABELS[attribution.status]
                      : '月推歸屬未知'}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {orderBasisLabel(contribution?.basis)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    備 {String(r.prepStatus || '—')}／出 {String(r.shipmentStatus || '—')}／銷 {String(r.salesStatus || '—')}
                  </div>
                  {(contribution?.anomalies.length ?? 0) > 0 && (
                    <div className="mt-1 text-[10px] font-medium text-amber-700">
                      {contribution!.anomalies.map((anomaly) => (
                        ORDER_DEMAND_ANOMALY_LABELS[anomaly as OrderDemandAnomaly]
                      )).join('、')}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold text-slate-700">
            <td colSpan={5} className="border-t border-slate-300 px-3 py-2">合計 ({records.length})</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.rawOrderQty)}</td>
            <td className="border-t border-l border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.preparedQty, orderSummary?.unknownPreparedCount)}</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.shippedQty, orderSummary?.unknownShippedCount)}</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.soldQty, orderSummary?.unknownSoldCount)}</td>
            <td className="border-t border-l border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.preparedNotShippedQty, orderSummary?.unknownPreparedNotShippedCount)}</td>
            <td className="border-t border-l border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.recognizedOrderQty)}</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.outstandingOrderQty)}</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.demandResolvedQty)}</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">{summaryQuantity(orderSummary?.closedUnfulfilledQty, orderSummary?.unknownClosedUnfulfilledCount)}</td>
            <td className="border-t border-l border-slate-300 px-3 py-2 text-[10px] font-normal text-slate-500">
              已備貨與實際庫存仍在庫存側；預示抵扣基礎不等於可用庫存。
            </td>
          </tr>
        </tfoot>
      </table>
    );
  }

  if (type === 'forecasts') {
    return (
      <table className="mx-auto w-full max-w-[760px] table-fixed border-separate border-spacing-0 bg-white text-xs">
        <thead className="bg-slate-50">
          <tr className="text-slate-600">
            <th className="w-28 border-b border-slate-200 px-3 py-2 text-center font-semibold">Ragic ID</th>
            <th className="border-b border-slate-200 px-3 py-2 text-left font-semibold">料號版本</th>
            <th className="w-32 border-b border-slate-200 px-3 py-2 text-right font-semibold">預示數量</th>
            <th className="w-36 border-b border-slate-200 px-3 py-2 text-center font-semibold">起始日期</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r: Record<string, unknown>, i: number) => (
            <tr key={i} className="hover:bg-blue-50/50">
              <td className="border-b border-slate-100 px-3 py-2 text-center"><SourceRecordLink type={type} recordId={r.ragicRecordId} /></td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.partVersion || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-medium tabular-nums">{Number(r.forecastQty).toLocaleString()}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center">{r.forecastStart ? new Date(String(r.forecastStart)).toLocaleDateString('zh-TW') : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold text-slate-700">
            <td colSpan={2} className="border-t border-slate-300 px-3 py-2">合計 ({records.length})</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">
              {records.reduce((s: number, r: Record<string, unknown>) => s + Number(r.forecastQty), 0).toLocaleString()}
            </td>
            <td className="border-t border-slate-300"></td>
          </tr>
        </tfoot>
      </table>
    );
  }

  if (type === 'work_orders') {
    return (
      <table className="mx-auto w-full min-w-[980px] table-fixed border-separate border-spacing-0 bg-white text-xs">
        <thead className="bg-slate-50">
          <tr className="text-slate-600">
            <th className="w-24 border-b border-slate-200 px-3 py-2 text-center font-semibold">Ragic ID</th>
            <th className="w-36 border-b border-slate-200 px-3 py-2 text-left font-semibold">工令單號</th>
            <th className="w-44 border-b border-slate-200 px-3 py-2 text-left font-semibold">料號版本</th>
            <th className="border-b border-slate-200 px-3 py-2 text-left font-semibold">ERP料號</th>
            <th className="w-24 border-b border-slate-200 px-3 py-2 text-right font-semibold">工令數量</th>
            <th className="w-20 border-b border-slate-200 px-3 py-2 text-center font-semibold">工單代碼</th>
            <th className="w-20 border-b border-slate-200 px-3 py-2 text-center font-semibold">子製程</th>
            <th className="w-24 border-b border-slate-200 px-3 py-2 text-center font-semibold">狀態</th>
            <th className="w-28 border-b border-slate-200 px-3 py-2 text-center font-semibold">預計完成日</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r: Record<string, unknown>, i: number) => (
            <tr key={i} className="hover:bg-blue-50/50">
              <td className="border-b border-slate-100 px-3 py-2 text-center"><SourceRecordLink type={type} recordId={r.ragicRecordId} /></td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono font-medium">{String(r.woNumber || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.partVersion || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.erpPartNo || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-medium tabular-nums">{Number(r.woQty).toLocaleString()}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center font-mono">{String(r.jobOrderCode || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center font-mono">{String(r.subProcessCode || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center">{String(r.status || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center">{r.endDate ? new Date(String(r.endDate)).toLocaleDateString('zh-TW') : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold text-slate-700">
            <td colSpan={4} className="border-t border-slate-300 px-3 py-2">合計 ({records.length})</td>
            <td className="border-t border-slate-300 px-3 py-2 text-right font-mono tabular-nums">
              {records.reduce((sum, row) => sum + Number(row.woQty), 0).toLocaleString()}
            </td>
            <td colSpan={4} className="border-t border-slate-300"></td>
          </tr>
        </tfoot>
      </table>
    );
  }

  if (type === 'production_plans') {
    return (
      <table className="mx-auto w-full min-w-[920px] table-fixed border-separate border-spacing-0 bg-white text-xs">
        <thead className="bg-slate-50">
          <tr className="text-slate-600">
            <th className="w-24 border-b border-slate-200 px-3 py-2 text-center font-semibold">Ragic ID</th>
            <th className="w-48 border-b border-slate-200 px-3 py-2 text-left font-semibold">料號版本</th>
            <th className="border-b border-slate-200 px-3 py-2 text-left font-semibold">ERP料號</th>
            <th className="w-28 border-b border-slate-200 px-3 py-2 text-right font-semibold">計畫數量</th>
            <th className="w-24 border-b border-slate-200 px-3 py-2 text-right font-semibold">已報工</th>
            <th className="w-28 border-b border-slate-200 px-3 py-2 text-right font-semibold">已結案入庫</th>
            <th className="w-32 border-b border-slate-200 px-3 py-2 text-center font-semibold">完成日期</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r: Record<string, unknown>, i: number) => (
            <tr key={i} className="hover:bg-blue-50/50">
              <td className="border-b border-slate-100 px-3 py-2 text-center"><SourceRecordLink type={type} recordId={r.ragicRecordId} /></td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.partVersion || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 font-mono">{String(r.erpPartNo || '—')}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-medium tabular-nums">{Number(r.planQty).toLocaleString()}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{Number(r.reportedQty).toLocaleString()}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{Number(r.closedQty).toLocaleString()}</td>
              <td className="border-b border-slate-100 px-3 py-2 text-center">{r.completionDate ? new Date(String(r.completionDate)).toLocaleDateString('zh-TW') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Generic fallback
  return (
    <pre className="text-xs bg-white p-2 rounded overflow-auto max-h-40">
      {JSON.stringify(records, null, 2)}
    </pre>
  );
}
