'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, Fragment, memo } from 'react';
import type { ColumnVisibilityState, ColumnFilter, MrpColumnDef, SortField } from './data-table/types';
import { Loader } from './ui/loader';
import { MaterialReminderButton } from './fg-material-reminder';
import { MATERIAL_REMINDER_LABELS } from '@/lib/mrp/material-reminder';
import { cachePeek, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import type { FgMonthlyTotals } from './fg-monthly';
import {
  FG_TRAD_FROZEN, FG_TRAD_STATIC, FG_TRAD_WAREHOUSE, FG_TRAD_WO, FG_TRAD_STATUS,
  FG_TRAD_PLAN_PRIOR, FG_TRAD_ORDER_PRIOR,
  FG_TRAD_PERIOD_VISIBILITY_IDS,
  FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
  type FgTradCol,
} from './data-table/column-defs/fg-monthly-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import {
  ColumnHeaderButton,
  type ColumnHeaderMenuController,
} from './data-table/ui/column-header-menu';
import { TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { TruncatedText } from './ui/truncated-text';
import { exportToFile, type ExportFormat } from '@/lib/export-utils';
import { AlertTriangle } from 'lucide-react';
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
  buildSelectionRangeCss,
  buildSelectionClipboardText,
  computeSelectionStats,
  isCellInSelection,
  type BoxSelRect,
  type BoxSelTimelineColumn,
  type SelectionStatsArgs,
} from '@/lib/mrp/fg-monthly-selection';
import {
  ProcessTreeCell,
  parseProcessSteps,
  treeColumnWidth,
} from './fg-monthly-process-tree';
import { SharedBalanceValue, SharedErpLegend } from './shared-erp-indicator';
import { WarehouseStockValue } from './warehouse-stock-detail';
import {
  warehouseStockGroupForField,
  type WarehouseStockFilter,
  type WarehouseStockGroup,
} from '@/lib/mrp/warehouse-stock';
import {
  FG_MONTHLY_SOURCE_METRIC_LABELS,
  fgMonthlySourcePeriod,
  isFgMonthlySummarySourceMetric,
  type FgMonthlyPeriodSourceRequest,
  type FgMonthlySourceMetric,
} from '@/lib/mrp/fg-monthly-source-detail';
import {
  fetchFgMonthlyPeriodsByIdentity,
  fgMonthlyPeriodsCacheKey,
} from '@/lib/mrp/fg-monthly-period-client';
import {
  VirtualTableSpacer,
  useVirtualTableRowNodes,
} from './ui/virtual-table-rows';
import { useVirtualTableGroups } from './ui/virtual-table-groups';
import { buildFgRowGroups } from '@/lib/mrp/fg-row-groups';
import { useRafCellFocus } from './ui/use-raf-cell-focus';
import { FloatingSelectionSummary } from './ui/floating-selection-summary';

const CHECKBOX_COL_WIDTH = 24;
const DETAIL_COL_WIDTH = 36;

// Estimate render width: CJK chars ~14px, latin/digits ~7px. Used by the dynamic
// column-width calculator below so columns shrink to fit short content (e.g. all
// "0" in 不良品pc) and grow to fit long part numbers, without exceeding a hard cap.
function estimateWidth(s: string): number {
  let px = 0;
  for (const ch of s) px += /[一-龥]/.test(ch) ? 14 : 7;
  return px;
}
const COL_WIDTH_MIN = 40;
const COL_WIDTH_MAX = 220;
const COL_WIDTH_PADDING = 16;

// 框選座標：r = items 陣列 row index；c 先排 visiblePrePeriodCols，再排時間軸欄。
// 時間軸群組可先有一格「前期未結」，後面才是 M1..Mn，因此不能再用 groupIdx*月數推算。
type Cell = { r: number; c: number };

function cellsToRect(a: Cell, f: Cell): BoxSelRect {
  return {
    minR: Math.min(a.r, f.r), maxR: Math.max(a.r, f.r),
    minC: Math.min(a.c, f.c), maxC: Math.max(a.c, f.c),
  };
}

// 抽 module-level 的 pure render helper（無 state）— 避免 renderRow useCallback
// 內 reference 卻不入 deps 的 lint warning，順帶讓 ref 永遠 stable。
function numCell(val: number | null | undefined, negative?: boolean) {
  const n = Number(val) || 0;
  if (n === 0) return <span className="text-slate-300 font-mono">0</span>;
  return (
    <span className={`font-mono ${negative && n < 0 ? 'text-red-700 font-bold' : ''}`}>
      {n.toLocaleString()}
    </span>
  );
}

type FgMonthlyPeriodSourceMetric = Extract<FgMonthlySourceMetric, keyof PeriodDetail>;

function isSourceMetric(value: keyof PeriodDetail): value is FgMonthlyPeriodSourceMetric {
  return value === 'demandIntegrated'
    || value === 'ordersUnshipped'
    || value === 'ordersTotal'
    || value === 'forecastQty'
    || value === 'plannedOutput';
}

// ============================================================
// Types (matching fg-monthly.tsx)
// ============================================================
export interface FgMonthlyItem {
  materialReminder?: import('@/lib/mrp/material-reminder').MaterialReminder;
  materialReminderError?: string;
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
  isAggregated?: boolean;
  aggregatedMembers?: string[];
}

export interface PeriodDetail {
  periodIndex: number;
  periodLabel: string;
  remainingStock: number;
  remainingNoPlan: number;
  demandIntegrated: number;
  ordersUnshipped: number;
  ordersTotal: number;
  forecastQty: number;
  plannedOutput: number;
}

// ============================================================
// Column definitions
// 欄位單一來源在 data-table/column-defs/fg-monthly-columns.ts（FG_TRAD_*）—
// 此處只取別名供本檔渲染使用。期推移群組 PERIOD_GROUPS 是傳統 view 專屬
// （動態 per-month、不進 colVis），定義留在本檔。
// ============================================================
const FROZEN_COLS = FG_TRAD_FROZEN;
const STATIC_COLS = FG_TRAD_STATIC;
const WAREHOUSE_COLS = FG_TRAD_WAREHOUSE;
const WO_COLS = FG_TRAD_WO;
const STATUS_COLS = FG_TRAD_STATUS;

// Period column groups
interface PeriodGroupDef {
  key: keyof PeriodDetail;
  visibilityId: string;
  label: string;
  headerBg: string;
  cellBg: string;
  borderColor: string;
  prior?: FgTradCol;
}

type VisiblePeriodGroup = PeriodGroupDef & { showPrior: boolean };
type VisibleWarehouseCol = FgTradCol & { group: 'warehouse' };
type TimelineSection =
  | { kind: 'warehouse'; key: 'warehouse'; columns: VisibleWarehouseCol[] }
  | { kind: 'period'; key: keyof PeriodDetail; group: VisiblePeriodGroup };

const PERIOD_GROUPS: PeriodGroupDef[] = [
  { key: 'plannedOutput', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.plannedOutput, label: '[生產計畫]', headerBg: 'bg-yellow-300 text-yellow-900', cellBg: 'bg-yellow-50', borderColor: 'border-yellow-300', prior: FG_TRAD_PLAN_PRIOR },
  { key: 'demandIntegrated', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.demandIntegrated, label: '[需求整合]', headerBg: 'bg-purple-600 text-white', cellBg: 'bg-purple-50', borderColor: 'border-purple-300' },
  { key: 'remainingStock', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.remainingStock, label: '剩餘庫存', headerBg: 'bg-emerald-800 text-white', cellBg: 'bg-emerald-50', borderColor: 'border-emerald-300' },
  { key: 'forecastQty', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.forecastQty, label: '[預示量]', headerBg: 'bg-blue-500 text-white', cellBg: 'bg-blue-50', borderColor: 'border-blue-300' },
  { key: 'ordersUnshipped', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.ordersUnshipped, label: '[訂單未結]', headerBg: 'bg-green-200 text-green-900', cellBg: 'bg-green-50', borderColor: 'border-green-300', prior: FG_TRAD_ORDER_PRIOR },
  { key: 'ordersTotal', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.ordersTotal, label: '[訂單總量]', headerBg: 'bg-gray-300 text-gray-800', cellBg: 'bg-gray-50', borderColor: 'border-gray-300' },
  { key: 'remainingNoPlan', visibilityId: FG_TRAD_PERIOD_VISIBILITY_IDS.remainingNoPlan, label: '剩餘庫存(無計劃量)', headerBg: 'bg-teal-700 text-white', cellBg: 'bg-teal-50', borderColor: 'border-teal-300' },
];

const PERIOD_COL_WIDTH = 70;

// Frozen column constants (based on ALL columns, not filtered)
export const FG_DEFAULT_FROZEN = FROZEN_COLS.length;
export const FG_MAX_FROZEN = FROZEN_COLS.length + STATUS_COLS.length + STATIC_COLS.length + WO_COLS.length;

// ============================================================
// Traditional View Component
// ============================================================
export function TraditionalView({
  items,
  active = true,
  totals = null,
  displayMonths,
  columnVisibility = {},
  textSize = 0,
  frozenCount = FG_DEFAULT_FROZEN,
  fetchAllForExport,
  aggregated = false,
  showTree = false,
  tableStyle = 'classic',
  columnFilters = [],
  onSetColumnFilter,
  onRemoveColumnFilter,
  sortFields,
  onAddSort,
  onRemoveSort,
  onToggleColumn,
  onFreezeToColumn,
  onRestoreGrouping,
  columnHeaderController,
  columnHeaderColumns,
  sortFieldIds = [],
  onShowDetail,
  onShowWarehouseStock,
  onShowPeriodSource,
  fetchMembers,
  snapshot,
}: {
  items: FgMonthlyItem[];
  active?: boolean;
  /** 整個篩選結果的合計（server 端算）；null 時不顯示合計列（如合併 DB 模式）。 */
  totals?: FgMonthlyTotals | null;
  displayMonths: number;
  columnVisibility?: ColumnVisibilityState;
  textSize?: number;
  frozenCount?: number;
  fetchAllForExport?: () => Promise<FgMonthlyItem[]>;
  aggregated?: boolean;
  /** When true, show an extra leftmost column rendering each row's
      成品製程版本 path with shared steps merged into a trunk visual. */
  showTree?: boolean;
  /** 表格樣式：'classic' = 原本、'ragic' = 比照 Ragic 條件式格式。由父 component 控制
      （toolbar 切換器與「視圖」並排），純前端 UI，不影響業務數值。 */
  tableStyle?: 'classic' | 'ragic';
  /** 給 cell 右鍵 menu 用 — 父層 useTableFiltering 的 state + actions。傳空陣列/不傳
      action = 不啟用右鍵 menu。 */
  columnFilters?: ColumnFilter[];
  onSetColumnFilter?: (filter: ColumnFilter) => void;
  onRemoveColumnFilter?: (columnId: string) => void;
  /** phase C 加碼 menu items（排序/隱藏欄/凍結）— 父層傳才會在右鍵 menu 顯示 */
  sortFields?: SortField[];
  onAddSort?: (field: SortField) => void;
  onRemoveSort?: (fieldId: string) => void;
  onToggleColumn?: (columnId: string) => void;
  onFreezeToColumn?: (columnId: string) => void;
  onRestoreGrouping?: () => void;
  columnHeaderController: ColumnHeaderMenuController;
  columnHeaderColumns: MrpColumnDef[];
  /** Ordered current sort field ids — drives the 鍛造母件/客戶料號 分群線. */
  sortFieldIds?: string[];
  /** Called when the user clicks the leftmost 詳細 icon. Parent should switch to 詳細 view. */
  onShowDetail?: (item: FgMonthlyItem, showMaterialReminder?: boolean) => void;
  /** Opens the current Run's internal/YE1 lot snapshot without reading live Ragic. */
  onShowWarehouseStock?: (
    item: FgMonthlyItem,
    warehouseGroup: WarehouseStockGroup,
    initialFilter?: WarehouseStockFilter,
  ) => void;
  /** Opens the selected Run and month's raw source rows without changing table selection. */
  onShowPeriodSource?: (request: FgMonthlyPeriodSourceRequest) => void;
  /** In 主件聚合 mode, called when user expands an aggregated row to fetch its member variants. */
  fetchMembers?: (item: FgMonthlyItem) => Promise<FgMonthlyItem[]>;
  /** Supplied historical periods bypass all live loaders and their numeric-Run cache. */
  snapshot?: { periods: Record<string, PeriodDetail[]>; missingFields: string[]; label: string };
}) {
  const [livePeriodsMap, setPeriodsMap] = useState<Record<string, PeriodDetail[]>>({});
  const periodsMap = snapshot?.periods ?? livePeriodsMap;
  const columnHeaderById = useMemo(
    () => new Map(columnHeaderColumns.map((column) => [column.id, column])),
    [columnHeaderColumns],
  );
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const periodRequestSeq = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [stockCalculation, setStockCalculation] = useState<StockCalculationDetail | null>(null);
  const closeStockCalculation = useCallback(() => setStockCalculation(null), []);
  const openStockCalculation = useCallback((
    item: FgMonthlyItem,
    periods: PeriodDetail[],
    periodIndex: number,
    balanceKind: StockBalanceKind,
  ) => {
    setStockCalculation(buildStockCalculationDetail({
      partVersion: item.partVersion,
      erpPartNo: item.erpPartNo,
      periodIndex,
      balanceKind,
      currentStockPc: Number(item.currentStockPc) || 0,
      priorUnshippedQty: Number(item.priorUnshippedQty) || 0,
      priorPlanQty: Number(item.priorPlanQty) || 0,
      periods,
      usesSharedErpPool: item.usesSharedErpPool,
      sharedErpCount: item.sharedErpCount,
      isAggregated: item.isAggregated,
    }));
  }, []);

  // 月推移格資料的跨頁快取 key：含每列實際 Run／DB source，避免 merge 或歷史 Run 沿用錯誤快取。
  const periodsKey = snapshot ? null : fgMonthlyPeriodsCacheKey(items, aggregated);
  // 切頁回來時在 paint 前先鋪上快取的格資料 → 傳統 view 零 spinner（item 由父層 layout effect seed，
  // 連帶這裡也在同一 commit 週期 paint 前完成）。
  useLayoutEffect(() => {
    periodRequestSeq.current++;
    setPeriodsError(null);
    if (snapshot) { setLoading(false); return; }
    if (!periodsKey) {
      setPeriodsMap({});
      setLoading(false);
      return;
    }
    const cached = cachePeek<Record<string, PeriodDetail[]>>(periodsKey);
    if (cached) {
      setPeriodsMap(cached);
      setLoading(false);
    } else {
      setPeriodsMap({});
      setLoading(true);
    }
  }, [periodsKey, snapshot]);

  // Cell 右鍵 menu — 事件委派掛在 <table>，從 closest('td[data-col]') 找 cell。
  // 父層沒傳 setter 就提供 no-op (menu 內按鈕仍會 enabled，但點選沒副作用 —
  // 之後 phase B 把 7 頁都接上後可拿掉 no-op fallback)。
  // 釘選列：右鍵 menu「釘選此列到頂端」加入，PinnedBar 固定在表頭上方 floating。
  // 用 Set 存 item.id；items list 重抓時若 id 仍在就保留 pin。
  const [pinnedRowIds, setPinnedRowIds] = useState<Set<number>>(new Set());
  const pinRow = useCallback((id: number) => {
    setPinnedRowIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const unpinRow = useCallback((id: number) => {
    setPinnedRowIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const pinnedItems = useMemo(
    () => items.filter((it) => pinnedRowIds.has(it.id)),
    [items, pinnedRowIds],
  );
  const clearPins = useCallback(() => setPinnedRowIds(new Set()), []);

  // Layout uses parent flex column (h-full flex flex-col min-h-0) instead of
  // px-based height calc — useAutoTableHeight not needed here anymore.

  // Aggregated-row inline expansion state — Set so multiple rows can be open
  // simultaneously. Operators frequently want to compare member breakdowns
  // across two or three groups without losing context.
  const [expandedAggGroups, setExpandedAggGroups] = useState<Set<number>>(() => new Set());
  const [memberItemsByGroup, setMemberItemsByGroup] = useState<Record<number, FgMonthlyItem[]>>({});
  const [memberPeriodsByPv, setMemberPeriodsByPv] = useState<Record<string, PeriodDetail[]>>({});
  const [loadingMembers, setLoadingMembers] = useState<Record<number, boolean>>({});

  // 製程版本樹: precompute parsed step arrays + group boundaries + the max
  // depth across the whole visible page (so all tree cells line up). A row
  // is "first in its 鍛造母件 group" when the previous row's forging_parent
  // differs (relies on caller having sorted by forging_parent — the toggle
  // in the parent enforces this). Skipped when showTree is off so we don't
  // pay the parsing cost for nothing.
  const treeData = useMemo(() => {
    if (!showTree) return null;
    const stepsByRow = items.map((it) => parseProcessSteps(it.processBomVersion));
    let maxDepth = 0;
    for (const s of stepsByRow) if (s.length > maxDepth) maxDepth = s.length;
    const isFirstInGroup = items.map((it, i) =>
      i === 0 ? true : (items[i - 1].forgingParent || '') !== (it.forgingParent || ''),
    );
    const isLastInGroup = items.map((it, i) =>
      i === items.length - 1 ? true : (items[i + 1].forgingParent || '') !== (it.forgingParent || ''),
    );
    // For each row's elbow, walk back through the same 鍛造母件 group until we
    // hit the row that actually rendered the previous shared step as a solid
    // box (i.e. divergeIdx ≤ targetCol). That's how far the elbow needs to
    // extend vertically so it visually reaches the source step.
    const divergeIdxByRow = stepsByRow.map((s, i) => {
      if (isFirstInGroup[i]) return 0;
      const prev = stepsByRow[i - 1];
      let d = 0;
      while (d < s.length && d < prev.length && s[d] === prev[d]) d++;
      return d;
    });
    const rowsBackToSource = stepsByRow.map((_, i) => {
      if (isFirstInGroup[i]) return 0;
      const targetCol = divergeIdxByRow[i] - 1;
      if (targetCol < 0) return 1;
      let k = i - 1;
      while (k > 0 && !isFirstInGroup[k] && divergeIdxByRow[k] > targetCol) k--;
      return i - k;
    });
    // Capture the source row's id for each row so the elbow can find the
    // actual source TR via `data-row-id` lookup at render time. This survives
    // expansion of upstream aggregated rows (which insert extra DOM rows
    // that the static rowsBack count can't see).
    const sourceRowIdByRow = stepsByRow.map((_, i) => {
      if (isFirstInGroup[i]) return null;
      const back = rowsBackToSource[i];
      return items[i - back]?.id ?? null;
    });
    return {
      stepsByRow,
      maxDepth,
      isFirstInGroup,
      isLastInGroup,
      rowsBackToSource,
      sourceRowIdByRow,
    };
  }, [items, showTree]);

  // Bumps every time the set of currently-expanded aggregated groups
  // changes, signalling the tree cells to re-measure their elbows against
  // the new DOM layout.
  const treeRevision = useMemo(
    () => Array.from(expandedAggGroups).sort((a, b) => a - b)
      .map(id => `${id}:${memberItemsByGroup[id]?.length ?? 0}:${Boolean(loadingMembers[id])}`).join(','),
    [expandedAggGroups, memberItemsByGroup, loadingMembers],
  );
  const treeColW = treeData ? treeColumnWidth(treeData.maxDepth) : 0;

  // 分群線：依鍛造母件分群（白/淡藍交錯底色），同一母件群組內客戶料號換值時畫粗線。
  // 只有主排序為鍛造母件時才成立（否則同母件不相鄰，分群會散掉）；粗線只看
  // 客戶料號 — 只要同群內相鄰兩列客戶料號不同就畫，與次排序欄位無關。
  const groupLines = useMemo(() => {
    const byForging = sortFieldIds[0] === 'forgingParent';
    const forgingStart = items.map(
      (it, i) => byForging && i > 0 && (items[i - 1].forgingParent || '') !== (it.forgingParent || ''),
    );
    const customerStart = items.map(
      (it, i) =>
        byForging && i > 0 && !forgingStart[i] &&
        (items[i - 1].customerPartNo || '') !== (it.customerPartNo || ''),
    );
    // 每列所屬鍛造母件群組的奇偶 — 用來做逐組白/淡藍交錯底色
    const groupParity: number[] = [];
    let g = 0;
    for (let i = 0; i < items.length; i++) {
      if (forgingStart[i]) g++;
      groupParity.push(g % 2);
    }
    return { customerStart, byForging, groupParity };
  }, [items, sortFieldIds]);

  // Reset expansion state when items list changes (e.g. sort/filter change,
  // page change, switching off aggregated mode). Also clear cached member
  // items so the next open refetches in the new sort order — without this,
  // member sub-rows would render in whatever order they were originally
  // fetched and ignore the user's current 排序.
  useEffect(() => {
    setExpandedAggGroups(new Set());
    setMemberItemsByGroup({});
  }, [items, aggregated]);

  const handleToggleAggregated = useCallback(
    async (item: FgMonthlyItem) => {
      if (snapshot) return;
      if (!aggregated || !item.aggregatedMembers || item.aggregatedMembers.length === 0) return;
      const wasOpen = expandedAggGroups.has(item.id);
      setExpandedAggGroups((prev) => {
        const next = new Set(prev);
        if (wasOpen) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      if (wasOpen) return;
      if (memberItemsByGroup[item.id] || !fetchMembers) return;

      setLoadingMembers((m) => ({ ...m, [item.id]: true }));
      try {
        const members = await fetchMembers(item);
        setMemberItemsByGroup((m) => ({ ...m, [item.id]: members }));
        if (members.length > 0) {
          const periods = await fetchFgMonthlyPeriodsByIdentity<PeriodDetail>(members, false);
          setMemberPeriodsByPv((current) => ({ ...current, ...periods }));
        }
      } finally {
        setLoadingMembers((m) => ({ ...m, [item.id]: false }));
      }
    },
    [aggregated, expandedAggGroups, fetchMembers, memberItemsByGroup, snapshot],
  );

  const isVisible = (key: string) => columnVisibility[key] !== false;

  // Mount-only-grow: remember the widest each column has ever needed within this
  // component instance, so flipping pages with shorter values doesn't shrink the
  // column (and shift sticky offsets) — which would feel like the table jitters.
  const widthBoundsRef = useRef<Record<string, number>>({});

  // Per-render dynamic width: max(label, longest visible content) + padding,
  // clamped to [COL_WIDTH_MIN, COL_WIDTH_MAX]. Long values beyond MAX get
  // truncated by the existing `truncate` className + tooltip on each frozen cell.
  const dynamicWidths = useMemo(() => {
    const calcCol = (col: { key: string; label: string }) => {
      const labelW = estimateWidth(col.label);
      let contentW = 0;
      for (const item of items) {
        const v = (item as unknown as Record<string, unknown>)[col.key];
        const s = v == null ? '' : typeof v === 'number' ? v.toLocaleString() : String(v);
        const w = estimateWidth(s);
        if (w > contentW) contentW = w;
      }
      const ideal = Math.max(labelW, contentW) + COL_WIDTH_PADDING;
      return Math.max(COL_WIDTH_MIN, Math.min(COL_WIDTH_MAX, ideal));
    };
    const w: Record<string, number> = {};
    for (const c of FROZEN_COLS) w[c.key] = calcCol(c);
    for (const c of STATIC_COLS) w[c.key] = calcCol(c);
    for (const c of WAREHOUSE_COLS) w[c.key] = calcCol(c);
    for (const c of WO_COLS) w[c.key] = calcCol(c);
    return w;
  }, [items]);

  // Stable widths: never shrink mid-session. Read previous max from ref, take
  // max(prev, current), then write back so next render sees the updated bound.
  const stableWidths = useMemo(() => {
    const seen = widthBoundsRef.current;
    const result: Record<string, number> = {};
    for (const key in dynamicWidths) {
      result[key] = Math.max(seen[key] ?? 0, dynamicWidths[key]);
    }
    widthBoundsRef.current = { ...seen, ...result };
    return result;
  }, [dynamicWidths]);

  // Build a flat list of all visible pre-period columns with global indices
  // Each entry: { key, label, width, group, groupIdx, bg?, headerBg? }
  const visiblePrePeriodCols = useMemo(() => {
    const cols: Array<FgTradCol & {
      group: 'frozen' | 'status' | 'static' | 'wo';
    }> = [];
    const w = (c: { key: string; width: number }) => stableWidths[c.key] ?? c.width;
    for (const c of FROZEN_COLS) if (isVisible(c.key)) cols.push({ ...c, width: w(c), group: 'frozen' });
    // Status 群組緊接 Part Info 之後（對齊 Ragic d4/22 版面）
    for (const c of STATUS_COLS) if (isVisible(c.key)) cols.push({ ...c, width: w(c), group: 'status' });
    for (const c of STATIC_COLS) if (isVisible(c.key)) cols.push({ ...c, width: w(c), group: 'static' });
    for (const c of WO_COLS) if (isVisible(c.key)) cols.push({ ...c, width: w(c), group: 'wo' });
    return cols;
  }, [columnVisibility, stableWidths]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleWarehouseCols = useMemo<VisibleWarehouseCol[]>(() => {
    const width = (c: FgTradCol) => stableWidths[c.key] ?? c.width;
    return WAREHOUSE_COLS
      .filter((column) => isVisible(column.key))
      .map((column) => ({ ...column, width: width(column), group: 'warehouse' }));
  }, [columnVisibility, stableWidths]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cumulative left positions for visible columns. 最左是 checkbox 欄 (left:0,
  // width CHECKBOX_COL_WIDTH)，接著 detail-icon 欄 (left:CHECKBOX_COL_WIDTH,
  // width DETAIL_COL_WIDTH)；製程版本樹開啟時樹欄再往右
  // (left:CHECKBOX_COL_WIDTH+DETAIL_COL_WIDTH)。凍結 Part-Info 欄因此從
  // CHECKBOX + DETAIL + treeColW 起算，否則橫向捲動會疊到左側 sticky 欄底下。
  const cumLefts = useMemo(() => {
    const lefts: number[] = [];
    const treeOffset = showTree && treeColW > 0 ? treeColW : 0;
    let cum = CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH + treeOffset;
    for (const col of visiblePrePeriodCols) {
      lefts.push(cum);
      cum += col.width;
    }
    return lefts;
  }, [visiblePrePeriodCols, showTree, treeColW]);

  // Group boundaries for Row 1 headers
  const row1Groups = useMemo(() => {
    const groups: Array<{ group: string; label: string; headerBg: string; startIdx: number; count: number }> = [];
    const groupMeta: Record<string, { label: string; headerBg: string }> = {
      frozen: { label: 'Part Info', headerBg: 'bg-slate-200' },
      status: { label: '供需狀態', headerBg: 'bg-indigo-50 text-slate-700' },
      static: { label: 'Info', headerBg: 'bg-slate-200 text-slate-600' },
      wo: { label: '鍛造與生產進度（參考）', headerBg: 'bg-green-200 text-green-900' },
    };
    let prevGroup = '';
    for (let i = 0; i < visiblePrePeriodCols.length; i++) {
      const g = visiblePrePeriodCols[i].group;
      if (g !== prevGroup) {
        const meta = groupMeta[g];
        groups.push({ group: g, label: meta.label, headerBg: meta.headerBg, startIdx: i, count: 1 });
        prevGroup = g;
      } else {
        groups[groups.length - 1].count++;
      }
    }
    return groups;
  }, [visiblePrePeriodCols]);


  useEffect(() => {
    if (snapshot) return;
    if (items.length === 0) {
      setPeriodsMap({});
      setPeriodsError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    const seq = periodRequestSeq.current;
    const cached = periodsKey ? cachePeek<Record<string, PeriodDetail[]>>(periodsKey) : undefined;
    const fetchPeriods = async () => {
      if (cached) {
        setPeriodsMap(cached);
        setLoading(false);
        if (periodsKey && cacheIsFresh(periodsKey)) return; // 夠新不打網路；否則靜默背景 revalidate
      } else {
        setLoading(true);
      }
      try {
        const periods = await fetchFgMonthlyPeriodsByIdentity<PeriodDetail>(
          items,
          aggregated,
          { signal: controller.signal },
        );
        if (!active || seq !== periodRequestSeq.current) return;
        setPeriodsMap(periods);
        setPeriodsError(null);
        if (periodsKey) cacheSet(periodsKey, periods);
      } catch (error) {
        if (!active || seq !== periodRequestSeq.current) return;
        if (!cached) setPeriodsMap({});
        setPeriodsError(error instanceof Error ? error.message : '月推期間資料讀取失敗');
      } finally {
        if (active && seq === periodRequestSeq.current) setLoading(false);
      }
    };

    fetchPeriods();
    return () => {
      active = false;
      controller.abort();
    };
  }, [items, aggregated, periodsKey, snapshot]);

  const labels = useMemo(() => {
    const samplePeriods = Object.values(periodsMap)[0] || [];
    const periodLabels = samplePeriods.slice(0, displayMonths).map((p) => p.periodLabel);
    return periodLabels.length > 0
      ? periodLabels
      : Array.from({ length: displayMonths }, (_, i) => `M${i + 1}`);
  }, [displayMonths, periodsMap]);

  const timelineGroups = useMemo(
    () => PERIOD_GROUPS
      .filter((group) => columnVisibility[group.visibilityId] !== false)
      .map((group) => ({
        ...group,
        showPrior: !!group.prior && columnVisibility[group.prior.key] !== false,
      })),
    [columnVisibility],
  );
  const timelineSections = useMemo<TimelineSection[]>(() => {
    const sections: TimelineSection[] = timelineGroups.map((group) => ({
      kind: 'period',
      key: group.key,
      group,
    }));
    if (visibleWarehouseCols.length === 0) return sections;
    const warehouseSection: TimelineSection = {
      kind: 'warehouse',
      key: 'warehouse',
      columns: visibleWarehouseCols,
    };
    const remainingNoPlanIndex = sections.findIndex(
      (section) => section.kind === 'period' && section.group.key === 'remainingNoPlan',
    );
    if (remainingNoPlanIndex < 0) return [...sections, warehouseSection];
    return [
      ...sections.slice(0, remainingNoPlanIndex),
      warehouseSection,
      ...sections.slice(remainingNoPlanIndex),
    ];
  }, [timelineGroups, visibleWarehouseCols]);
  const timelineSectionOffsets = useMemo(() => {
    let offset = visiblePrePeriodCols.length;
    return timelineSections.map((section) => {
      const current = offset;
      offset += section.kind === 'warehouse'
        ? section.columns.length
        : displayMonths + (section.group.showPrior ? 1 : 0);
      return current;
    });
  }, [displayMonths, timelineSections, visiblePrePeriodCols.length]);
  const timelineSelectionCols = useMemo<BoxSelTimelineColumn[]>(
    () => timelineSections.flatMap((section) => section.kind === 'warehouse'
      ? section.columns.map((column) => ({ kind: 'item' as const, key: column.key }))
      : [
          ...(section.group.showPrior && section.group.prior
            ? [{ kind: 'item' as const, key: section.group.prior.key }]
            : []),
          ...Array.from({ length: displayMonths }, (_, monthIndex) => ({
            kind: 'period' as const,
            groupKey: section.group.key,
            monthIndex,
          })),
        ]),
    [displayMonths, timelineSections],
  );
  const timelineColumnCount = timelineSelectionCols.length;
  const tableColumnWidths = useMemo(() => [
    CHECKBOX_COL_WIDTH,
    DETAIL_COL_WIDTH,
    ...(showTree && treeColW > 0 ? [treeColW] : []),
    ...visiblePrePeriodCols.map((column) => column.width),
    ...timelineSections.flatMap((section) => {
      if (section.kind === 'warehouse') {
        return section.columns.map((column) => column.width);
      }
      return [
        ...(section.group.showPrior && section.group.prior
          ? [section.group.prior.width]
          : []),
        ...Array.from({ length: displayMonths }, () => PERIOD_COL_WIDTH),
      ];
    }),
  ], [displayMonths, showTree, timelineSections, treeColW, visiblePrePeriodCols]);
  const tableWidth = useMemo(
    () => tableColumnWidths.reduce((total, width) => total + width, 0),
    [tableColumnWidths],
  );

  // 合計列：把 server 回的 period 合計依 periodIndex 建 map，footer 逐格查
  const periodTotalMap = useMemo(
    () => new Map((totals?.periods ?? []).map((p) => [p.periodIndex, p])),
    [totals],
  );

  // === 框選加總 === 全表數字格皆可框：在表格上按住滑鼠拖曳框出矩形，
  // Sum/Count/Average 顯示在 Legend 列。只加總數字格，文字欄略過（同 Excel）。
  // 多框選：按住 Ctrl/Cmd 再 drag → 累加新矩形而非取代（對齊 Excel）。
  // committed 矩形存 selRects；正在 drag 的暫態存 draftAnchor/draftFocus，
  // mouseup 才 commit 進 selRects。effectiveRects = [...selRects, draftRect]
  // 給 selectionCss / selStats 共用。
  const [selRects, setSelRects] = useState<BoxSelRect[]>([]);
  const [draftAnchor, _setDraftAnchor] = useState<Cell | null>(null);
  const [draftFocus, _setDraftFocus] = useState<Cell | null>(null);
  const [dragging, _setDragging] = useState(false);
  // mouseup window listener 內讀不到最新 state（closure 舊值）→ ref 同步。
  // setDraft*Synced 把 state + ref 兩件事綁一起，避免「新增改 draft 的地方
  // 漏同步 ref」的 footgun。
  const draftAnchorRef = useRef<Cell | null>(null);
  const draftFocusRef = useRef<Cell | null>(null);
  const draggingRef = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const setDraftAnchor = useCallback((next: Cell | null | ((prev: Cell | null) => Cell | null)) => {
    _setDraftAnchor((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      draftAnchorRef.current = v;
      return v;
    });
  }, []);
  const setDraftFocus = useCallback((next: Cell | null | ((prev: Cell | null) => Cell | null)) => {
    _setDraftFocus((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      draftFocusRef.current = v;
      return v;
    });
  }, []);
  const setDragging = useCallback((v: boolean) => {
    draggingRef.current = v;
    _setDragging(v);
  }, []);
  const {
    cancel: cancelScheduledDraftFocus,
    flush: flushDraftFocus,
    schedule: scheduleDraftFocus,
  } = useRafCellFocus(draftFocusRef, setDraftFocus);

  const draftRect = useMemo<BoxSelRect | null>(
    () => (draftAnchor && draftFocus ? cellsToRect(draftAnchor, draftFocus) : null),
    [draftAnchor, draftFocus],
  );

  const effectiveRects = useMemo<BoxSelRect[]>(
    () => (draftRect ? [...selRects, draftRect] : selRects),
    [selRects, draftRect],
  );

  // 每列只產生一個 nth-child 範圍 selector，避免寬選時 selector 數量隨格數膨脹。
  const selectionCss = useMemo(() => buildSelectionRangeCss({
    rects: effectiveRects,
    tableSelector: '.fg-monthly-trad-table',
    firstSelectableChildIndex: 3 + (showTree && treeData && treeColW > 0 ? 1 : 0),
  }), [effectiveRects, showTree, treeColW, treeData]);

  const clearSelection = useCallback(() => {
    cancelScheduledDraftFocus();
    setSelRects([]);
    setDraftAnchor(null);
    setDraftFocus(null);
  }, [cancelScheduledDraftFocus, setDraftAnchor, setDraftFocus]);

  // === 列高亮標記 === 勾 detail 欄的小方塊 → 整列換底色，橫向捲動時容易追自己
  // 在看哪幾列。CSS-only（同框選 P1 機制）：highlightedRowIds 變只更新 <style>
  // textContent，不 invalidate renderRow → 勾選不重算整表。toggleHighlight 用
  // useCallback 穩定 ref，進 renderRow deps 不會觸發重算。
  const [highlightedRowIds, setHighlightedRowIds] = useState<Set<number>>(() => new Set());
  const toggleHighlight = useCallback((id: number) => {
    setHighlightedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearHighlight = useCallback(() => setHighlightedRowIds(new Set()), []);

  const highlightCss = useMemo(() => {
    if (highlightedRowIds.size === 0) return '';
    const ids = [...highlightedRowIds];
    // 整列靛藍底（仿 Ragic 勾選列）：靛藍蓋過橘黃/粉紅 row 染色、跟框選的
    // blue-200 略區隔。!important 蓋過 cell 自己的斑馬/分級底色。左側 detail td
    // (sticky) 額外加粗邊條，橫向捲動固定在左緣、列首一眼可辨。
    const rowSel = ids.map((id) => `.mrp-trad-table tr[data-row-id="${id}"] > td`).join(',');
    const barSel = ids.map((id) => `.mrp-trad-table tr[data-row-id="${id}"] > td:first-child::before`).join(',');
    const tglSel = ids.map((id) => `.mrp-trad-table tr[data-row-id="${id}"] .hl-toggle`).join(',');
    return `${rowSel}{background-color:#c7d2fe !important}` +
           `${barSel}{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:#4f46e5;z-index:20}` +
           `${tglSel}{background-color:#4f46e5 !important;border-color:#4338ca !important}`;
  }, [highlightedRowIds]);

  // 從事件 target 往上找帶 data-selc 的 td，解析 (r, c)
  const cellCoordOf = (target: EventTarget | null): Cell | null => {
    const td = (target as HTMLElement | null)?.closest?.('td[data-selc]') as HTMLElement | null;
    if (!td) return null;
    const r = Number(td.dataset.selr);
    const c = Number(td.dataset.selc);
    return Number.isNaN(r) || Number.isNaN(c) ? null : { r, c };
  };

  // 拖曳框選：mousedown 起點 → mouseover 擴張 → mouseup 結束。事件委派在
  // <table> 上避免每格掛 handler；preventDefault 阻止瀏覽器拖曳時反白選字。
  // ctrl/meta + drag → append 新矩形；無 modifier → 取代既有所有矩形。
  const handleTableMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-no-selection]')) return;
    const co = cellCoordOf(e.target);
    if (!co) return;
    e.preventDefault();
    tableRef.current?.focus({ preventScroll: true });
    const append = e.ctrlKey || e.metaKey;
    if (!append) setSelRects([]);
    cancelScheduledDraftFocus();
    setDragging(true);
    setDraftAnchor(co);
    setDraftFocus(co);
  }, [cancelScheduledDraftFocus, setDragging, setDraftAnchor, setDraftFocus]);

  const handleTableMouseOver = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const co = cellCoordOf(e.target);
    if (!co) return;
    scheduleDraftFocus(co);
  }, [scheduleDraftFocus]);

  // 換頁/篩選/改月數/欄位顯隱 → 座標意義失效，清掉選取
  useEffect(() => {
    clearSelection();
  }, [items, displayMonths, visiblePrePeriodCols, timelineSelectionCols, clearSelection]);

  // 換頁/篩選/換 run → row id 換一批，舊高亮 id 對不上（CSS selector 找不到），
  // 清掉避免「標記 N 列」殘留 dangling id。
  useEffect(() => { clearHighlight(); }, [items, clearHighlight]);

  // 拖曳結束（滑鼠在表格外放開也要收）—— 把 draft 矩形 commit 進 selRects
  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      setDragging(false);
      const a = draftAnchorRef.current;
      const f = flushDraftFocus();
      if (a && f) setSelRects((prev) => [...prev, cellsToRect(a, f)]);
      setDraftAnchor(null);
      setDraftFocus(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [dragging, flushDraftFocus, setDragging, setDraftAnchor, setDraftFocus]);

  // Esc 清除選取
  const hasSelection = effectiveRects.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection, clearSelection]);

  // 選取範圍的 Sum / Count / Average —— 計算邏輯抽到 computeSelectionStats
  // （可單元測試）。框選加總把數字欄都算進去（含備庫期數等），文字欄略過。
  // 多框選重疊格只算一次（computeSelectionStats 內部去重）。
  const selectionSummary = useMemo(() => {
    if (effectiveRects.length === 0) return null;
    const sharedPrePeriodKeys = new Set([
      'wfgStockPc', 'ye1StockPc', 'currentStockPc', 'badStockPc', 'lastPeriodRemainingNoPlan',
    ]);
    let includesSharedBalance = false;
    const args: SelectionStatsArgs = {
      rects: effectiveRects,
      prePeriodCols: visiblePrePeriodCols,
      periodGroupKeys: timelineGroups.map((g) => g.key),
      displayMonths,
      timelineCols: timelineSelectionCols,
      rowCount: items.length,
      getPrePeriodValue: (r, key) => snapshot?.missingFields.includes(key) ? null : items[r]?.[key as keyof FgMonthlyItem],
      getPeriodValue: (r, gKey, mi) => {
        const p = (periodsMap[items[r]?.partVersion] || [])[mi];
        if (snapshot) return snapshot.missingFields.includes(gKey) ? null : p?.[gKey as keyof PeriodDetail] ?? null;
        return p ? Number(p[gKey as keyof PeriodDetail]) || 0 : 0;
      },
      onVisitCell: (r, c) => {
        if (includesSharedBalance || (items[r]?.sharedErpCount ?? 1) <= 1) return;
        if (c < visiblePrePeriodCols.length) {
          includesSharedBalance = sharedPrePeriodKeys.has(visiblePrePeriodCols[c]?.key ?? '');
          return;
        }
        const timelineCol = timelineSelectionCols[c - visiblePrePeriodCols.length];
        includesSharedBalance = timelineCol?.kind === 'item'
          ? sharedPrePeriodKeys.has(timelineCol.key)
          : timelineCol?.kind === 'period'
            && (timelineCol.groupKey === 'remainingStock' || timelineCol.groupKey === 'remainingNoPlan');
      },
    };
    return {
      stats: computeSelectionStats(args),
      clipboardText: draftRect ? null : buildSelectionClipboardText(args),
      includesSharedBalance,
    };
  }, [draftRect, effectiveRects, items, periodsMap, displayMonths, timelineGroups, timelineSelectionCols, visiblePrePeriodCols, snapshot]);
  const selStats = selectionSummary?.stats ?? null;
  const selectionClipboardText = selectionSummary?.clipboardText ?? null;
  const selectionIncludesSharedBalance = selectionSummary?.includesSharedBalance ?? false;
  const getSelectionCopy = useCallback((cell: HTMLTableCellElement) => {
    const row = Number(cell.dataset.selr);
    const column = Number(cell.dataset.selc);
    if (
      selectionClipboardText === null
      || !Number.isInteger(row)
      || !Number.isInteger(column)
      || !isCellInSelection(effectiveRects, row, column)
    ) return null;
    return {
      text: selectionClipboardText,
      summary: '可貼入 Excel／試算表',
    };
  }, [effectiveRects, selectionClipboardText]);
  const cellMenu = useCellContextMenu({
    columns: snapshot ? columnHeaderColumns : FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
    columnFilters,
    onSetFilter: onSetColumnFilter ?? (() => {}),
    onRemoveFilter: onRemoveColumnFilter ?? (() => {}),
    sortFields,
    onAddSort,
    onRemoveSort,
    onToggleColumn,
    onFreezeToColumn,
    onPinRow: pinRow,
    getSelectionCopy,
    selectionCopyText: selectionClipboardText,
  });

  const closeCellMenu = cellMenu.contextMenuProps.onClose;
  useLayoutEffect(() => {
    if (active) return;
    setDragging(false);
    clearSelection();
    closeCellMenu();
    closeStockCalculation();
  }, [active, clearSelection, closeCellMenu, closeStockCalculation, setDragging]);

  const selectedStockCell = useMemo(() => {
    if (snapshot) return null;
    if (effectiveRects.length !== 1) return null;
    const rect = effectiveRects[0];
    if (rect.minR !== rect.maxR || rect.minC !== rect.maxC) return null;
    if (rect.minC < visiblePrePeriodCols.length) return null;
    const timelineCol = timelineSelectionCols[rect.minC - visiblePrePeriodCols.length];
    if (
      timelineCol?.kind !== 'period'
      || (timelineCol.groupKey !== 'remainingStock' && timelineCol.groupKey !== 'remainingNoPlan')
    ) return null;
    const item = items[rect.minR];
    const periods = item ? periodsMap[item.partVersion] ?? [] : [];
    if (!item || !periods[timelineCol.monthIndex]) return null;
    return {
      item,
      periods,
      periodIndex: timelineCol.monthIndex,
      balanceKind: timelineCol.groupKey === 'remainingStock'
        ? 'withPlan' as const
        : 'withoutPlan' as const,
    };
  }, [effectiveRects, items, periodsMap, timelineSelectionCols, visiblePrePeriodCols.length, snapshot]);

  // Frozen helpers — useCallback 穩定 ref，給 Row 跟 cell render 後續 memo 用。
  const pin = useCallback((gi: number) => gi < frozenCount, [frozenCount]);
  const pinStyle = useCallback(
    (gi: number, width: number, zIdx: number) => {
      const fixedWidth = { width, minWidth: width, maxWidth: width };
      return pin(gi)
        ? { ...fixedWidth, position: 'sticky' as const, left: cumLefts[gi], zIndex: zIdx }
        : fixedWidth;
    },
    [pin, cumLefts],
  );
  const pinBg = useCallback(
    (gi: number, rowIdx: number, defaultBg = '') =>
      pin(gi) ? (defaultBg || (rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50')) : defaultBg,
    [pin],
  );


  // 合計列數值格式：0 淡化，其餘千分位（容許 2 位小數，吸收 Decimal→Number 誤差）
  const footTotalNum = (n: number): React.ReactNode =>
    n === 0
      ? <span className="text-slate-400">0</span>
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // Export handler — fetches ALL filtered items + their periods, not just the current page
  const handleExport = useCallback(async (format: ExportFormat) => {
    setExporting(true);
    try {
      // 1. Fetch all filtered items
      const allItems = !snapshot && fetchAllForExport ? await fetchAllForExport() : items;

      // 2. Fetch periods for all items
      let allPeriodsMap: Record<string, PeriodDetail[]> = periodsMap;
      if (!snapshot && fetchAllForExport && allItems.length > items.length) {
        allPeriodsMap = await fetchFgMonthlyPeriodsByIdentity<PeriodDetail>(
          allItems,
          aggregated,
        );
      }

      // 3. Build headers
      const headerRow1: (string | null)[] = [];
      const headerRow2: string[] = [];

      const exportGroupLabels = {
        frozen: 'Part Info',
        status: '供需狀態',
        static: 'Info',
        wo: '鍛造與生產進度（參考）',
      } as const;
      const seenExportGroups = new Set<string>();
      for (const col of visiblePrePeriodCols) {
        const groupLabel = exportGroupLabels[col.group];
        headerRow1.push(seenExportGroups.has(col.group) ? null : groupLabel);
        headerRow2.push(col.label);
        seenExportGroups.add(col.group);
        if (col.key === 'erpPartNo') {
          headerRow1.push(null);
          headerRow2.push('共享ERP成員數');
        }
      }

      for (const section of timelineSections) {
        if (section.kind === 'warehouse') {
          section.columns.forEach((column, index) => {
            headerRow1.push(index === 0 ? '倉庫在庫' : null);
            headerRow2.push(column.label);
          });
          continue;
        }
        const g = section.group;
        if (g.showPrior && g.prior) {
          headerRow1.push(g.label);
          headerRow2.push('前期未結');
        }
        labels.forEach((label, i) => {
          headerRow1.push(i === 0 && !g.showPrior ? g.label : null);
          headerRow2.push(label);
        });
      }

      // 4. Build data rows from ALL items
      const dataRows = allItems.map((item) => {
        const row: (string | number | null)[] = [];
        for (const col of visiblePrePeriodCols) {
          if (col.key === 'materialReminder') {
            row.push(item.materialReminder ? MATERIAL_REMINDER_LABELS[item.materialReminder.state] : '未取得提醒');
          } else if (snapshot && (snapshot.missingFields.includes(col.key) || (item[col.key as keyof FgMonthlyItem] == null && !['shortageStartPeriod', 'shortageStartPeriodNoPlan'].includes(col.key)))) {
            row.push(null);
          } else if (col.group === 'frozen') {
            row.push(item[col.key as keyof FgMonthlyItem] as string | number | null ?? null);
          } else if (col.key === 'stockPeriods') {
            row.push(item.stockPeriods != null ? Number(item.stockPeriods) : null);
          } else if (col.key === 'missingForecastPeriods') {
            row.push(item.missingForecastPeriods);
          } else if (col.key === 'shortageStartPeriod') {
            row.push(item.shortageStartPeriod !== null
              ? `M${item.shortageStartPeriod + 1}${labels[item.shortageStartPeriod]?.includes('/') ? ` ${labels[item.shortageStartPeriod]}` : ''}`
              : 'OK');
          } else if (col.key === 'shortageStartPeriodNoPlan') {
            row.push(item.shortageStartPeriodNoPlan !== null
              ? `M${item.shortageStartPeriodNoPlan + 1}${labels[item.shortageStartPeriodNoPlan]?.includes('/') ? ` ${labels[item.shortageStartPeriodNoPlan]}` : ''}`
              : 'OK');
          } else if (col.key === 'shouldPlanProduction') {
            row.push(item.shouldPlanProduction ? 'Y' : 'N');
          } else {
            row.push(Number(item[col.key as keyof FgMonthlyItem]) || 0);
          }
          if (col.key === 'erpPartNo') row.push(item.sharedErpCount);
        }

        const periods = (allPeriodsMap[item.partVersion] || []).slice(0, displayMonths);
        const padded = Array.from({ length: displayMonths }, (_, i) => periods[i] || null);

        for (const section of timelineSections) {
          if (section.kind === 'warehouse') {
            for (const column of section.columns) {
              const value = item[column.key as keyof FgMonthlyItem];
              row.push(value == null ? null : Number(value));
            }
            continue;
          }
          const g = section.group;
          if (g.showPrior && g.prior) row.push(snapshot && item[g.prior.key as keyof FgMonthlyItem] == null ? null : Number(item[g.prior.key as keyof FgMonthlyItem]) || 0);
          for (const p of padded) {
            row.push(snapshot && (!p || p[g.key] == null) ? null : p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0);
          }
        }
        return row;
      });

      exportToFile({
        filename: snapshot ? `FG_Monthly_${snapshot.label}_本頁` : `FG_Monthly_${new Date().toISOString().split('T')[0]}`,
        sheetName: 'FG Monthly',
        headers: [headerRow1, headerRow2],
        data: dataRows,
        format,
      });
    } finally {
      setExporting(false);
    }
  }, [
    items, periodsMap, displayMonths, labels, fetchAllForExport, aggregated,
    timelineSections, visiblePrePeriodCols, snapshot,
  ]);

  // === Phase E: row jsx cache ===
  // menu state / pinned bar 等 setState 觸發 traditional re-render 時，這份
  // useCallback + useMemo 讓 tbody jsx 引用不變、React 跳過整個 tbody 的
  // reconcile。⚠️ deps 漏列任一會 silent stale（cached jsx 過時但 UI 不更新）。
  const renderRow = useCallback((item: FgMonthlyItem, rowIdx: number) => {
            const periods = (periodsMap[item.partVersion] || []).slice(0, displayMonths);
            const paddedPeriods: (PeriodDetail | null)[] = Array.from(
              { length: displayMonths },
              (_, i) => periods[i] || null,
            );
            // Only render an aggregated row as expandable when it actually
            // groups multiple customer-part-versions — a singleton "×1"
            // group expands to show the same content twice, which is just
            // visual noise.
            const isAggHead = aggregated && (item.aggregatedMembers?.length ?? 0) > 1;
            const isAggOpen = expandedAggGroups.has(item.id);
            const memberItems = memberItemsByGroup[item.id];
            const isLoadingMembers = !!loadingMembers[item.id];
            // Closed aggregated rows blend into the zebra stripe — the heavy
            // indigo treatment was overwhelming when every row in 按主件聚合
            // mode is an aggregated head. The chevron + tooltip already signal
            // "this is a group". Indigo wash only kicks in when EXPANDED so
            // the parent stays visually anchored above its member sub-rows.
            // 逐組白/淡藍交錯（鍛造母件分組，僅製程樹關閉且主排序為鍛造母件時）；
            // 否則回退逐列白/灰斑馬。
            // Ragic 模式下強制關掉「同鍛造母件淡藍」群組視覺 — Ragic 端原本就沒這效果，
            // 且 Ragic 自己有整列染色 + 斑馬紋會打架，視覺對齊不出來。
            const groupZebra = tableStyle !== 'ragic' && !showTree && groupLines.byForging;
            const evenBand = groupZebra
              ? groupLines.groupParity[rowIdx] === 0
              : rowIdx % 2 === 0;
            const bandStripe = groupZebra ? 'bg-sky-100' : 'bg-slate-50';
            const rowZebra = isAggHead && isAggOpen
              ? 'bg-indigo-100'
              : evenBand ? '' : bandStripe;
            const rowZebraBg = isAggHead && isAggOpen
              ? 'bg-indigo-100'
              : evenBand ? 'bg-white' : bandStripe;
            // 列 hover 效果由 .mrp-trad-table 的 inset box-shadow wash 統一處理
            // （見 globals.css）—— <tr> 層級的 hover 背景會被 cell 自己的底色蓋掉。
            // Thick emerald bottom border on the LAST row of each 鍛造母件
            // cluster (only when the tree column is on) so groups are
            // visually separated even when the next group's header isn't
            // immediately obvious. Combined with the group header's thick
            // top border, this creates a clear emerald band between groups.
            const isLastInForgingGroup =
              showTree && treeData ? treeData.isLastInGroup[rowIdx] : false;
            // showTree on → 既有 emerald 分群；off → 鍛造母件用底色分組、客戶料號用粗線
            let aggBorder: string;
            if (isLastInForgingGroup) {
              aggBorder = 'border-b-2 border-emerald-400';
            } else if (tableStyle !== 'ragic' && !showTree && groupLines.customerStart[rowIdx]) {
              // 同一鍛造母件群組內客戶料號換值 → 色帶內畫一條粗分隔線（底色不變，仍是同母件）
              // Ragic 模式下關掉 — Ragic 端原本沒這線、且 row 級染色已能視覺區分
              aggBorder = 'border-t-[3px] border-slate-500 border-b border-slate-200';
            } else {
              aggBorder = 'border-b border-slate-200';
            }
            const aggTextClass = isAggHead && isAggOpen ? 'font-semibold text-slate-800' : '';

            // 鍛造母件 group-header row — only rendered when the tree column
            // is on AND the group has something worth labelling (i.e. it's
            // either a multi-row cluster OR a single aggregated row that
            // contains multiple customer-part-versions). Pure singletons
            // (1 row + 1 customer-part-version) render no header.
            const isGroupBoundary =
              showTree && treeData && treeColW > 0 && treeData.isFirstInGroup[rowIdx];
            // 組 = number of rows in this 鍛造母件 cluster
            // 客戶料號版本 = total customer-part-versions across those rows
            // (for non-aggregated rows that's 1 each; for aggregated rows
            // it's aggregatedMembers.length).
            let groupRowCount = 0;
            let groupPartCount = 0;
            if (isGroupBoundary) {
              for (let k = rowIdx; k < items.length; k++) {
                if ((items[k].forgingParent || '') !== (item.forgingParent || '')) break;
                groupRowCount++;
                groupPartCount += Math.max(items[k].aggregatedMembers?.length ?? 1, 1);
              }
            }
            const showGroupHeader =
              isGroupBoundary && (groupRowCount > 1 || groupPartCount > 1);

            return (
              <Fragment key={item.id}>
              {showGroupHeader && (
                <tr className="bg-emerald-50 border-t-2 border-emerald-500">
                  {/* Sticky empty cell over the checkbox column */}
                  <td
                    className="bg-emerald-50 border-r border-emerald-200"
                    style={{
                      position: 'sticky',
                      left: 0,
                      zIndex: 11,
                      width: CHECKBOX_COL_WIDTH,
                      minWidth: CHECKBOX_COL_WIDTH,
                    }}
                  />
                  {/* Sticky empty cell over the detail column */}
                  <td
                    className="bg-emerald-50 border-r border-emerald-200"
                    style={{
                      position: 'sticky',
                      left: CHECKBOX_COL_WIDTH,
                      zIndex: 11,
                      width: DETAIL_COL_WIDTH,
                      minWidth: DETAIL_COL_WIDTH,
                    }}
                  />
                  {/* The 鍛造母件 label — sits in the tree column area */}
                  <td
                    className="bg-emerald-50 border-r-2 border-emerald-300 px-2 py-1 text-[10px] font-semibold text-emerald-900"
                    style={{
                      position: 'sticky',
                      left: CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH,
                      zIndex: 11,
                      width: treeColW,
                      minWidth: treeColW,
                    }}
                  >
                    <span className="text-emerald-600 mr-1">鍛造母件:</span>
                    <span className="font-mono">{item.forgingParent || '(none)'}</span>
                    <span className="text-emerald-500 ml-2 font-normal">
                      ({groupRowCount}組, 共{groupPartCount}客戶料號版本)
                    </span>
                  </td>
                  {/* Empty filler spanning the rest of the table */}
                  <td
                    className="bg-emerald-50"
                    colSpan={visiblePrePeriodCols.length + timelineColumnCount}
                  />
                </tr>
              )}
              <tr
                data-virtual-row
                data-row-id={item.id}
                data-row-shortage={
                  item.shortageStartPeriod !== null
                    ? (item.shortageStartPeriod <= 1 ? 'critical'
                      : item.shortageStartPeriod <= 3 ? 'high'
                      : item.shortageStartPeriod <= 5 ? 'warning'
                      : undefined)
                    : undefined
                }
                className={`${aggBorder} ${rowZebra} ${aggTextClass} ${
                  isAggHead ? 'cursor-pointer' : ''
                }`}
                onClick={isAggHead ? (e) => {
                  // 點在可框選的資料格 → 那是框選操作，不要觸發聚合列展開
                  if (!(e.target as HTMLElement).closest('td[data-selc]')) handleToggleAggregated(item);
                } : undefined}
              >
                {/* Checkbox column (sticky leftmost) — 列高亮標記 */}
                <td
                  className={`text-center ${rowZebraBg} border-r border-slate-200 relative`}
                  style={{ position: 'sticky', left: 0, zIndex: 12, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
                >
                  {/* Left accent bar only when the aggregated row is expanded —
                      keeps the parent visually anchored above its member sub-rows. */}
                  {isAggHead && isAggOpen && (
                    <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-indigo-500" />
                  )}
                  {/* 列高亮 toggle — 勾選態(靛藍)靠 highlightCss 控制，CSS-only */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleHighlight(item.id); }}
                    className="hl-toggle w-3 h-3 rounded-sm border border-slate-300 bg-white hover:border-indigo-400"
                    title="標記此列（橫向捲動易追蹤）"
                    aria-label="標記此列"
                  />
                </td>

                {/* Detail icon column (sticky, right of checkbox) */}
                <td
                  className={`text-center ${rowZebraBg} ${
                    isAggHead && isAggOpen ? 'border-r-2 border-indigo-300' : 'border-r border-slate-200'
                  } relative`}
                  style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, zIndex: 12, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
                >
                  <div className="flex items-center justify-center gap-0.5">
                    {isAggHead && (
                      <span
                        className={`text-indigo-600 text-[11px] font-bold inline-block transition-transform ${isAggOpen ? 'rotate-90' : ''}`}
                      >
                        ▸
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={snapshot && !onShowDetail}
                      onClick={(e) => { e.stopPropagation(); onShowDetail?.(item); }}
                      className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-900 border border-blue-200 font-medium leading-none disabled:opacity-40 disabled:cursor-not-allowed"
                      title={snapshot ? '檢視同版本封存來源' : '切換到詳細模式並定位此筆'}
                    >
                      詳細
                    </button>
                  </div>
                </td>

                {/* 製程版本樹 column — sticky left so it stays visible while
                    scrolling horizontally. Pinned just right of the detail
                    column. Click events are NOT stopped so aggregated rows
                    can still toggle expand/collapse from this cell. */}
                {showTree && treeData && treeColW > 0 && (
                  <td
                    className={`${rowZebraBg} border-r-2 border-emerald-200 align-middle p-0`}
                    style={{
                      width: treeColW,
                      minWidth: treeColW,
                      position: 'sticky',
                      left: CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH,
                      zIndex: 12,
                      // overflow:visible so the elbow connector can extend
                      // upward into the row above (negative top on the L).
                      overflow: 'visible',
                    }}
                  >
                    <ProcessTreeCell
                      steps={treeData.stepsByRow[rowIdx]}
                      prevSteps={rowIdx > 0 ? treeData.stepsByRow[rowIdx - 1] : []}
                      isFirstInGroup={treeData.isFirstInGroup[rowIdx]}
                      isLastInGroup={treeData.isLastInGroup[rowIdx]}
                      depth={treeData.maxDepth}
                      rowsBackToSource={treeData.rowsBackToSource[rowIdx]}
                      sourceRowId={treeData.sourceRowIdByRow[rowIdx]}
                      revision={treeRevision}
                    />
                  </td>
                )}

                {/* All pre-period columns */}
                {visiblePrePeriodCols.map((col, gi) => {
                  if (col.key === 'materialReminder') {
                    return <td key={col.key} data-selr={rowIdx} data-selc={gi} data-col={col.key} data-value={item.materialReminder ? MATERIAL_REMINDER_LABELS[item.materialReminder.state] : '未取得提醒'} className={`border-r border-slate-200 px-1.5 text-center ${rowZebraBg}`} style={{ minWidth: col.width }}><MaterialReminderButton reminder={item.materialReminder} error={item.materialReminderError} onClick={() => onShowDetail?.(item, true)} /></td>;
                  }
                  if (snapshot && (snapshot.missingFields.includes(col.key) || (item[col.key as keyof FgMonthlyItem] == null && !['shortageStartPeriod', 'shortageStartPeriodNoPlan'].includes(col.key)))) {
                    return <td key={col.key} data-selr={rowIdx} data-selc={gi} data-col={col.key} data-value="" className={`border-r border-slate-200 px-1.5 py-1 text-center text-slate-400 ${rowZebraBg}`} style={pinStyle(gi, col.width, 10)} title="此歷史版本未提供">—</td>;
                  }
                  const isFrozenGroup = col.group === 'frozen';
                  const isWo = col.group === 'wo';
                  const cellBg = isWo && col.bg ? col.bg : (isWo ? '' : rowZebraBg);

                  // For aggregated parents, the sticky cells must use solid indigo (matching the
                  // <tr> wash) so they don't bleed body cells through when scrolled.
                  const aggCellBg = isAggHead && isAggOpen ? 'bg-indigo-100' : '';
                  if (isFrozenGroup) {
                    const val = item[col.key as keyof FgMonthlyItem];
                    const isPartVersion = col.key === 'partVersion';
                    const isErp = col.key === 'erpPartNo';
                    // 表面處理條件是不限長度的自由文字 → 用 TruncatedText（hover 浮層
                    // 顯示全文），其餘短欄位維持原生 title。
                    const isSurface = col.key === 'surfaceTreatment';
                    // For aggregated rows, the partVersion cell shows tooltip listing all variants
                    const tooltip = isPartVersion && aggregated && item.aggregatedMembers && item.aggregatedMembers.length > 0
                      ? `聚合成員 (${item.aggregatedMembers.length}):\n${item.aggregatedMembers.join('\n')}`
                      : String(val || '');
                    const isAggHeader = isPartVersion && aggregated && item.aggregatedMembers && item.aggregatedMembers.length > 1;
                    const frozenBg = aggCellBg || pinBg(gi, rowIdx, rowZebraBg);
                    return (
                      <td
                        key={col.key}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-col={col.key}
                        data-value={val != null ? String(val) : ''}
                        className={`px-1.5 py-1 whitespace-nowrap border-r border-slate-200 cursor-cell ${frozenBg} ${
                          isPartVersion || isErp ? 'font-mono text-[10px] font-semibold' : ''
                        } ${isAggHeader ? 'font-bold' : ''}`}
                        style={pinStyle(gi, col.width, 10)}
                        title={isSurface ? undefined : tooltip}
                      >
                        {isSurface ? (
                          <TruncatedText
                            value={val != null ? String(val) : '—'}
                            maxWidth={col.width - 12}
                          />
                        ) : (
                          <div
                            className="truncate"
                            style={{ maxWidth: col.width - 12 }}
                          >
                            {val != null ? String(val) : '—'}
                            {isAggHeader && (
                              <span className="text-[8px] bg-blue-100 text-blue-700 px-1 rounded">
                                ×{item.aggregatedMembers!.length}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  }

                  // Status columns — custom per-key rendering (badges / ✓ / colours)
                  if (col.group === 'status') {
                    if (col.key === 'lastPeriodRemainingNoPlan') {
                      const neg = item.lastPeriodRemainingNoPlan !== null && Number(item.lastPeriodRemainingNoPlan) < 0;
                      return (
                        <td
                          key={col.key}
                          data-selr={rowIdx}
                          data-selc={gi}
                          data-col={col.key}
                          data-value={item.lastPeriodRemainingNoPlan != null ? String(item.lastPeriodRemainingNoPlan) : ''}
                          className={`px-1.5 py-1 text-right font-mono border-r border-slate-200 cursor-cell ${neg ? 'bg-red-100 text-red-800 font-bold' : 'bg-teal-50 text-teal-800'}`}
                          style={{ minWidth: col.width }}
                        >
                          <SharedBalanceValue
                            value={item.lastPeriodRemainingNoPlan}
                            label="[期末]剩餘庫存(無計劃量)"
                            sharedErpCount={item.sharedErpCount}
                            erpPartNo={item.erpPartNo}
                          />
                        </td>
                      );
                    }
                    // 開始缺貨期數 cell 按值 3 階分級（對齊 Ragic 色碼）：
                    //   critical = 第 1-2 期 (深粉)、high = 第 3-4 期 (橘黃)、warning = 第 5-6 期 (黃)
                    //   shortageStartPeriod 是 0-indexed。
                    const shortageLevel = col.key === 'shortageStartPeriod' && item.shortageStartPeriod !== null
                      ? (item.shortageStartPeriod <= 1 ? 'critical'
                        : item.shortageStartPeriod <= 3 ? 'high'
                        : item.shortageStartPeriod <= 5 ? 'warning'
                        : undefined)
                      : undefined;
                    const statusRawVal = item[col.key as keyof FgMonthlyItem];
                    return (
                      <td
                        key={col.key}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-col={col.key}
                        data-shortage-level={shortageLevel}
                        data-value={statusRawVal != null ? String(statusRawVal) : ''}
                        className="px-1.5 py-1 text-center border-r border-slate-200 cursor-cell"
                        style={{ minWidth: col.width }}
                      >
                        {col.key === 'inventoryAnomalyCount' && (
                          !item.inventoryValidationAvailable
                            ? <span className="text-[10px] text-slate-400" title="此歷史 Run 尚無庫存批號數量驗證">未驗證</span>
                            : item.inventoryAnomalyCount > 0
                              ? <button
                                  type="button"
                                  data-no-selection
                                  onMouseDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onShowWarehouseStock?.(
                                      item,
                                      item.wfgInventoryAnomalyCount > 0 ? 'INTERNAL' : 'YE1',
                                      'ANOMALY',
                                    );
                                  }}
                                  className="inline-flex items-center gap-1 border border-amber-500 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950 hover:bg-amber-200"
                                  title="查看可能未同步的 Ragic 庫存批號"
                                >
                                  <AlertTriangle size={10} aria-hidden="true" />待確認 {item.inventoryAnomalyCount}
                                </button>
                              : <span className="text-[10px] text-emerald-600">正常</span>
                        )}
                        {col.key === 'stockPeriods' && (item.stockPeriods != null
                          ? <span className="font-mono text-slate-600">{Number(item.stockPeriods)}</span>
                          : <span className="text-slate-300">&mdash;</span>)}
                        {col.key === 'missingForecastPeriods' && (Number(item.missingForecastPeriods) > 0
                          ? <span className="text-amber-700 font-mono">{item.missingForecastPeriods}</span>
                          : <span className="text-slate-300">&mdash;</span>)}
                        {col.key === 'shortageStartPeriod' && (item.shortageStartPeriod !== null
                          ? <span
                              className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-red-100 px-1 text-[10px] font-bold leading-none text-red-600"
                              title={`M${item.shortageStartPeriod + 1} ${labels[item.shortageStartPeriod] || ''}`.trim()}
                            >
                              M{item.shortageStartPeriod + 1}
                              {labels[item.shortageStartPeriod]?.includes('/') && (
                                <span className="text-[9px] font-normal">{labels[item.shortageStartPeriod]}</span>
                              )}
                            </span>
                          : <span className="text-green-600 text-[10px] bg-green-100 px-1 rounded">OK</span>)}
                        {col.key === 'shortageStartPeriodNoPlan' && (item.shortageStartPeriodNoPlan !== null
                          ? <span
                              className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-orange-100 px-1 text-[10px] font-bold leading-none text-orange-700"
                              title={`M${item.shortageStartPeriodNoPlan + 1} ${labels[item.shortageStartPeriodNoPlan] || ''}`.trim()}
                            >
                              M{item.shortageStartPeriodNoPlan + 1}
                              {labels[item.shortageStartPeriodNoPlan]?.includes('/') && (
                                <span className="text-[9px] font-normal">{labels[item.shortageStartPeriodNoPlan]}</span>
                              )}
                            </span>
                          : <span className="text-green-600 text-[10px] bg-green-100 px-1 rounded">OK</span>)}
                        {col.key === 'shouldPlanProduction' && (item.shouldPlanProduction
                          ? <span className="text-green-600 font-bold">&#10003;</span>
                          : <span className="text-slate-300">&mdash;</span>)}
                      </td>
                    );
                  }

                  // Numeric columns (static, wo, prior)
                  const val = Number(item[col.key as keyof FgMonthlyItem]) || 0;
                  let formatted: React.ReactNode;
                  if (col.key === 'currentStockPc' || col.key === 'badStockPc') formatted = (
                    <SharedBalanceValue
                      value={val}
                      label={col.label}
                      sharedErpCount={item.sharedErpCount}
                      erpPartNo={item.erpPartNo}
                      warning={col.key === 'currentStockPc' && item.inventoryAnomalyCount > 0
                        ? `${item.inventoryAnomalyCount} 筆庫存批號可能尚未同步；MRP 仍採 Ragic 原值`
                        : undefined}
                    />
                  );
                  else if (col.key === 'unitWeightG') formatted = val.toFixed(1);
                  else if (col.key === 'mainMaterialKg') formatted = val.toFixed(3);
                  else if (isFgMonthlySummarySourceMetric(col.key) && onShowPeriodSource) {
                    const metric = col.key;
                    const label = FG_MONTHLY_SOURCE_METRIC_LABELS[metric];
                    formatted = (
                      <button
                        type="button"
                        data-no-selection
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onShowPeriodSource({
                            partVersion: item.partVersion,
                            memberPartVersions: item.isAggregated
                              ? item.aggregatedMembers
                              : undefined,
                            mrpRunId: item.mrpRunId,
                            dbSource: item.dbSource,
                            metric,
                            period: fgMonthlySourcePeriod(metric, val, null, label),
                          });
                        }}
                        className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                          val === 0 ? 'text-slate-300' : ''
                        }`}
                        title={`查看${label}來源明細`}
                      >
                        {val.toLocaleString()}
                      </button>
                    );
                  }
                  else formatted = numCell(val);

                  const numericBg = aggCellBg || pinBg(gi, rowIdx, cellBg);
                  // data-* 屬性給 Ragic 模式 CSS rule 用：data-col 識別欄位、
                  // data-pos 標「正數警示」(不良品庫存 > 0)。
                  const isBadStockPos = col.key === 'badStockPc' && val > 0;
                  return (
                    <td
                      key={col.key}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-col={col.key}
                      data-pos={isBadStockPos ? '1' : undefined}
                      data-value={String(val)}
                      className={`px-1.5 py-1 text-right font-mono border-r border-slate-200 cursor-cell ${numericBg}`}
                      style={pinStyle(gi, col.width, 10)}
                    >
                      {formatted}
                    </td>
                  );
                })}

                {/* 時間軸：倉庫在庫放在「剩餘庫存(無計劃量)」左側；
                    期推移群組有前期未結時先放一格，再接 M1..Mn。 */}
                {timelineSections.map((section, sectionIdx) => {
                  if (section.kind === 'warehouse') {
                    return (
                      <Fragment key={section.key}>
                        {section.columns.map((column, columnIdx) => {
                          const rawValue = item[column.key as keyof FgMonthlyItem];
                          const value = rawValue == null ? null : Number(rawValue);
                          const warehouseGroup = warehouseStockGroupForField(column.key);
                          if (!warehouseGroup) return null;
                          return (
                            <td
                              key={column.key}
                              data-selr={rowIdx}
                              data-selc={timelineSectionOffsets[sectionIdx] + columnIdx}
                              data-col={column.key}
                              data-value={value == null ? '' : String(value)}
                              className={`px-1.5 py-1 text-right font-mono border-r border-sky-200 cursor-cell ${isAggHead && isAggOpen ? 'bg-indigo-100' : 'bg-sky-50'}`}
                              style={{ minWidth: column.width }}
                            >
                              {snapshot ? <SharedBalanceValue value={value} label={column.label} sharedErpCount={item.sharedErpCount} erpPartNo={item.erpPartNo} /> : <WarehouseStockValue
                                value={value}
                                warehouseGroup={warehouseGroup}
                                hasInventoryAnomaly={warehouseGroup === 'INTERNAL'
                                  ? item.wfgInventoryAnomalyCount > 0
                                  : item.ye1InventoryAnomalyCount > 0}
                                inventoryAnomalyCount={warehouseGroup === 'INTERNAL'
                                  ? item.wfgInventoryAnomalyCount
                                  : item.ye1InventoryAnomalyCount}
                                onOpen={() => onShowWarehouseStock?.(item, warehouseGroup)}
                              />}
                            </td>
                          );
                        })}
                      </Fragment>
                    );
                  }
                  const g = section.group;
                  return (
                  <Fragment key={section.key}>
                  {g.showPrior && g.prior && (() => {
                    const val = Number(item[g.prior.key as keyof FgMonthlyItem]) || 0;
                    return (
                      <td
                        key={g.prior.key}
                        data-selr={rowIdx}
                        data-selc={timelineSectionOffsets[sectionIdx]}
                        data-period-key={g.prior.key}
                        data-period-label={g.prior.label}
                        data-value={String(val)}
                        className={`px-1 py-1 text-right font-mono cursor-cell border-r border-slate-300 ${g.cellBg}`}
                        style={{ minWidth: g.prior.width }}
                        title={g.prior.label}
                      >
                        {snapshot && (snapshot.missingFields.includes(g.prior.key) || item[g.prior.key as keyof FgMonthlyItem] == null) ? '—' : isSourceMetric(g.key) && onShowPeriodSource ? (
                          <button
                            type="button"
                            data-no-selection
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onShowPeriodSource({
                                partVersion: item.partVersion,
                                memberPartVersions: item.isAggregated ? item.aggregatedMembers : undefined,
                                mrpRunId: item.mrpRunId,
                                dbSource: item.dbSource,
                                metric: g.key as FgMonthlySourceMetric,
                                period: fgMonthlySourcePeriod(
                                  g.key as FgMonthlySourceMetric,
                                  val,
                                  -1,
                                  g.prior!.label,
                                ),
                              });
                            }}
                            className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                              val === 0 ? 'text-slate-300' : ''
                            }`}
                            title={`查看${g.prior.label}來源明細`}
                          >
                            {val.toLocaleString()}
                          </button>
                        ) : numCell(val)}
                      </td>
                    );
                  })()}
                  {paddedPeriods.map((p, mi) => {
                    if (snapshot && (!p || p[g.key] == null || snapshot.missingFields.includes(g.key))) {
                      return <td key={`${g.key}-${mi}`} data-selr={rowIdx} data-selc={timelineSectionOffsets[sectionIdx] + (g.showPrior ? 1 : 0) + mi} data-period-key={g.key} data-period-month-idx={mi} data-value="" className={`border-r border-slate-200 px-1 py-1 text-right text-slate-400 ${g.cellBg}`} style={{ minWidth: PERIOD_COL_WIDTH }}>—</td>;
                    }
                    const val = p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0;
                    const isNeg = val < 0;
                    const isStockGroup = g.key === 'remainingStock' || g.key === 'remainingNoPlan';
                    const c = timelineSectionOffsets[sectionIdx] + (g.showPrior ? 1 : 0) + mi;
                    // data-period-neg: 剩餘庫存（含無計劃量）各期 < 0 給 Ragic 模式
                    // 用 — CSS rule 覆蓋 row 級的 critical/warning 染色（避免警示被
                    // 「整列同色」吃掉，對齊 Ragic 條件清單獨立列出的 ST1-10~21 / S01~S09）
                    const isPeriodNeg = isStockGroup && isNeg;
                    return (
                      <td
                        key={`${g.key}-${mi}`}
                        data-selr={rowIdx}
                        data-selc={c}
                        data-period-neg={isPeriodNeg ? '1' : undefined}
                        data-period-key={g.key}
                        data-period-month-idx={mi}
                        data-period-label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`}
                        data-value={String(val)}
                        className={`px-1 py-1 text-right font-mono cursor-cell ${
                          isPeriodNeg
                            ? 'bg-red-100 text-red-800 font-bold'
                            : g.cellBg
                        } ${
                          mi === displayMonths - 1 ? 'border-r border-slate-300' : 'border-r border-slate-200'
                        }`}
                        style={{ minWidth: PERIOD_COL_WIDTH }}
                        title={!snapshot && isStockGroup && p ? '選取此格後可查看本期剩餘庫存算式' : undefined}
                      >
                        {snapshot && isStockGroup ? <SharedBalanceValue value={val} label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`} sharedErpCount={item.sharedErpCount} erpPartNo={item.erpPartNo} /> : isStockGroup ? (
                          p ? (
                            <StockCalculationValue
                              value={val}
                              label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`}
                              sharedErpCount={item.sharedErpCount}
                              erpPartNo={item.erpPartNo}
                              onExplain={() => openStockCalculation(
                                item,
                                periods,
                                mi,
                                g.key === 'remainingStock' ? 'withPlan' : 'withoutPlan',
                              )}
                            />
                          ) : (
                            <SharedBalanceValue
                              value={val}
                              label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`}
                              sharedErpCount={item.sharedErpCount}
                              erpPartNo={item.erpPartNo}
                            />
                          )
                        ) : p && isSourceMetric(g.key) && onShowPeriodSource ? (
                          <button
                            type="button"
                            data-no-selection
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onShowPeriodSource({
                                partVersion: item.partVersion,
                                memberPartVersions: item.isAggregated ? item.aggregatedMembers : undefined,
                                mrpRunId: item.mrpRunId,
                                dbSource: item.dbSource,
                                metric: g.key as FgMonthlySourceMetric,
                                period: p,
                              });
                            }}
                            className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                              val === 0 ? 'text-slate-300' : ''
                            }`}
                            title={`查看${g.label} ${labels[mi] ?? `M${mi + 1}`}來源明細`}
                          >
                            {val.toLocaleString()}
                          </button>
                        ) : val === 0 ? (
                          <span className="text-slate-300">0</span>
                        ) : val.toLocaleString()}
                      </td>
                    );
                  })}
                  </Fragment>
                  );
                })}
              </tr>

              {/* Inline-expanded aggregated members (one sub-row per variant) */}
              {isAggHead && isAggOpen && (
                <>
                  {isLoadingMembers && (
                    <tr className="border-b-2 border-indigo-200">
                      <td
                        colSpan={2 + (showTree && treeColW > 0 ? 1 : 0) + visiblePrePeriodCols.length + timelineColumnCount}
                        className="bg-slate-50/60 text-center text-[11px] text-slate-400 italic py-2"
                      >
                        載入聚合成員中...
                      </td>
                    </tr>
                  )}
                  {!isLoadingMembers && memberItems && memberItems.map((member, mIdx) => {
                    const mPeriods = (memberPeriodsByPv[member.partVersion] || []).slice(0, displayMonths);
                    const mPadded: (PeriodDetail | null)[] = Array.from(
                      { length: displayMonths },
                      (_, i) => mPeriods[i] || null,
                    );
                    const isLastMember = mIdx === memberItems.length - 1;
                    // Sub-row appearance: lighter solid colours so the sticky frozen columns stay
                    // opaque (no body bleeding through when scrolled horizontally). Use solid slate
                    // tints + softer text colours for hierarchy.
                    const subBg = 'bg-slate-50';
                    const subBgFrozen = 'bg-slate-100';
                    const subText = 'text-slate-500';
                    const subBorder = isLastMember ? 'border-b-2 border-indigo-200' : 'border-b border-dashed border-slate-200';
                    return (
                      <tr
                        key={`m-${item.id}-${member.id}`}
                        data-virtual-row
                        data-row-id={member.id}
                        className={`${subBorder} ${subBg} ${subText}`}
                      >
                        {/* Checkbox column placeholder (member 不獨立標記) — 放 indent guide */}
                        <td
                          className={`${subBgFrozen} border-r border-slate-200 relative`}
                          style={{ position: 'sticky', left: 0, zIndex: 12, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
                        >
                          {/* indent guide aligned with parent's accent bar */}
                          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-indigo-200" />
                        </td>
                        <td
                          className={`text-center ${subBgFrozen} border-r border-slate-200 relative`}
                          style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, zIndex: 12, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
                        >
                          <div className="flex items-center justify-center gap-0.5 pl-0.5">
                            <span className="text-slate-400 text-[9px] leading-none">└</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onShowDetail?.(member); }}
                              className="text-[9px] px-1 py-0.5 rounded bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-700 border border-slate-200 font-normal leading-none"
                              title="切換到詳細模式並定位此筆"
                            >
                              詳細
                            </button>
                          </div>
                        </td>
                        {/* Tree-cell for aggregated members — renders the
                            member's own process-version path so that variants
                            with different final-step (e.g. ...V07-10PA vs
                            ...V07-10PA-D9) show up as their own divergence
                            against the parent's main path. The parent row's
                            steps act as the "previous" for the first member,
                            and each subsequent member compares against the
                            previous member's steps. */}
                        {showTree && treeData && treeColW > 0 && (() => {
                          const memberSteps = parseProcessSteps(member.processBomVersion);
                          const prevSteps =
                            mIdx === 0
                              ? treeData.stepsByRow[rowIdx]
                              : parseProcessSteps(memberItems[mIdx - 1].processBomVersion);
                          return (
                            <td
                              className={`${subBgFrozen} border-r-2 border-emerald-100 align-middle p-0`}
                              style={{
                                width: treeColW,
                                minWidth: treeColW,
                                position: 'sticky',
                                left: CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH,
                                zIndex: 12,
                                overflow: 'visible',
                              }}
                            >
                              <ProcessTreeCell
                                steps={memberSteps}
                                prevSteps={prevSteps}
                                isFirstInGroup={false}
                                isLastInGroup={isLastMember}
                                depth={treeData.maxDepth}
                                /* For members, the source step (drawn as a
                                   box) lives in the parent row above —
                                   members 0..mIdx-1 all share with the
                                   parent so they render that column as a
                                   thin trunk. Reach back mIdx+1 rows to
                                   the parent's box. */
                                rowsBackToSource={mIdx + 1}
                                sourceRowId={item.id}
                                revision={treeRevision}
                              />
                            </td>
                          );
                        })()}
                        {visiblePrePeriodCols.map((col, gi) => {
                          const isFrozenGroup = col.group === 'frozen';
                          if (isFrozenGroup) {
                            const val = member[col.key as keyof FgMonthlyItem];
                            const isPartVersion = col.key === 'partVersion';
                            const isErp = col.key === 'erpPartNo';
                            const isSurface = col.key === 'surfaceTreatment';
                            return (
                              <td
                                key={col.key}
                                className={`px-1.5 py-1 whitespace-nowrap border-r border-slate-200 ${subBgFrozen} text-slate-500 ${
                                  isPartVersion || isErp ? 'font-mono text-[10px] italic' : 'italic'
                                }`}
                                style={pinStyle(gi, col.width, 10)}
                                title={isSurface ? undefined : String(val || '')}
                              >
                                {isSurface ? (
                                  <TruncatedText
                                    value={val != null ? String(val) : '—'}
                                    maxWidth={col.width - 12}
                                  />
                                ) : (
                                  <div
                                    className="truncate"
                                    style={{ maxWidth: col.width - 12 }}
                                  >
                                    {val != null ? String(val) : '—'}
                                  </div>
                                )}
                              </td>
                            );
                          }
                          // Status columns — custom per-key rendering
                          if (col.group === 'status') {
                            if (col.key === 'materialReminder') return <td key={col.key} className="border-r border-slate-200 px-1.5 text-center bg-slate-50" style={{ minWidth: col.width }}><MaterialReminderButton reminder={member.materialReminder} error={member.materialReminderError} onClick={() => onShowDetail?.(member, true)} /></td>;
                            if (col.key === 'lastPeriodRemainingNoPlan') {
                              return (
                                <td key={col.key} className="px-1.5 py-1 text-right font-mono bg-slate-50 text-slate-500" style={{ minWidth: col.width }}>
                                  <SharedBalanceValue
                                    value={member.lastPeriodRemainingNoPlan}
                                    label="[期末]剩餘庫存(無計劃量)"
                                    sharedErpCount={member.sharedErpCount}
                                    erpPartNo={member.erpPartNo}
                                  />
                                </td>
                              );
                            }
                            return (
                              <td key={col.key} className="px-1.5 py-1 text-center border-r border-slate-200 bg-slate-50" style={{ minWidth: col.width }}>
                                {col.key === 'inventoryAnomalyCount' && (
                                  !member.inventoryValidationAvailable
                                    ? <span className="text-[10px] text-slate-400">未驗證</span>
                                    : member.inventoryAnomalyCount > 0
                                      ? <button
                                          type="button"
                                          data-no-selection
                                          onMouseDown={(event) => event.stopPropagation()}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            onShowWarehouseStock?.(
                                              member,
                                              member.wfgInventoryAnomalyCount > 0 ? 'INTERNAL' : 'YE1',
                                              'ANOMALY',
                                            );
                                          }}
                                          className="inline-flex items-center gap-1 border border-amber-500 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950 hover:bg-amber-200"
                                        >
                                          <AlertTriangle size={10} aria-hidden="true" />待確認 {member.inventoryAnomalyCount}
                                        </button>
                                      : <span className="text-[10px] text-emerald-600">正常</span>
                                )}
                                {col.key === 'stockPeriods' && (member.stockPeriods != null
                                  ? <span className="font-mono text-slate-500">{Number(member.stockPeriods)}</span>
                                  : <span className="text-slate-300">—</span>)}
                                {col.key === 'missingForecastPeriods' && (Number(member.missingForecastPeriods) > 0
                                  ? <span className="text-amber-600 font-mono">{member.missingForecastPeriods}</span>
                                  : <span className="text-slate-300">—</span>)}
                                {col.key === 'shortageStartPeriod' && (member.shortageStartPeriod !== null
                                  ? <span
                                      className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-red-50 px-1 text-[10px] leading-none text-red-500"
                                      title={`M${member.shortageStartPeriod + 1} ${labels[member.shortageStartPeriod] || ''}`.trim()}
                                    >
                                      M{member.shortageStartPeriod + 1}
                                      {labels[member.shortageStartPeriod]?.includes('/') && (
                                        <span className="text-[9px]">{labels[member.shortageStartPeriod]}</span>
                                      )}
                                    </span>
                                  : <span className="text-green-500 text-[10px] bg-green-50 px-1 rounded">OK</span>)}
                                {col.key === 'shortageStartPeriodNoPlan' && (member.shortageStartPeriodNoPlan !== null
                                  ? <span
                                      className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-orange-50 px-1 text-[10px] leading-none text-orange-600"
                                      title={`M${member.shortageStartPeriodNoPlan + 1} ${labels[member.shortageStartPeriodNoPlan] || ''}`.trim()}
                                    >
                                      M{member.shortageStartPeriodNoPlan + 1}
                                      {labels[member.shortageStartPeriodNoPlan]?.includes('/') && (
                                        <span className="text-[9px]">{labels[member.shortageStartPeriodNoPlan]}</span>
                                      )}
                                    </span>
                                  : <span className="text-green-500 text-[10px] bg-green-50 px-1 rounded">OK</span>)}
                                {col.key === 'shouldPlanProduction' && (member.shouldPlanProduction
                                  ? <span className="text-green-500">✓</span>
                                  : <span className="text-slate-300">—</span>)}
                              </td>
                            );
                          }
                          const val = Number(member[col.key as keyof FgMonthlyItem]) || 0;
                          let formatted: React.ReactNode;
                          if (col.key === 'currentStockPc' || col.key === 'badStockPc') formatted = (
                            <SharedBalanceValue
                              value={val}
                              label={col.label}
                              sharedErpCount={member.sharedErpCount}
                              erpPartNo={member.erpPartNo}
                              warning={col.key === 'currentStockPc' && member.inventoryAnomalyCount > 0
                                ? `${member.inventoryAnomalyCount} 筆庫存批號可能尚未同步；MRP 仍採 Ragic 原值`
                                : undefined}
                            />
                          );
                          else if (col.key === 'unitWeightG') formatted = (
                            <span className="font-mono text-slate-500">{val.toFixed(1)}</span>
                          );
                          else if (col.key === 'mainMaterialKg') formatted = (
                            <span className="font-mono text-slate-500">{val.toFixed(3)}</span>
                          );
                          else if (isFgMonthlySummarySourceMetric(col.key) && onShowPeriodSource) {
                            const metric = col.key;
                            const label = FG_MONTHLY_SOURCE_METRIC_LABELS[metric];
                            formatted = (
                              <button
                                type="button"
                                data-no-selection
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onShowPeriodSource({
                                    partVersion: member.partVersion,
                                    mrpRunId: member.mrpRunId,
                                    dbSource: member.dbSource,
                                    metric,
                                    period: fgMonthlySourcePeriod(metric, val, null, label),
                                  });
                                }}
                                className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                                  val === 0 ? 'text-slate-300' : 'text-slate-500'
                                }`}
                                title={`查看${label}來源明細`}
                              >
                                {val.toLocaleString()}
                              </button>
                            );
                          }
                          else formatted = (
                            val === 0
                              ? <span className="text-slate-300 font-mono">0</span>
                              : <span className="font-mono text-slate-500">{val.toLocaleString()}</span>
                          );
                          return (
                            <td
                              key={col.key}
                              className={`px-1.5 py-1 text-right border-r border-slate-200 ${subBgFrozen}`}
                              style={pinStyle(gi, col.width, 10)}
                            >
                              {formatted}
                            </td>
                          );
                        })}
                        {timelineSections.map((section) => {
                          if (section.kind === 'warehouse') {
                            return (
                              <Fragment key={section.key}>
                                {section.columns.map((column) => {
                                  const rawValue = member[column.key as keyof FgMonthlyItem];
                                  const value = rawValue == null ? null : Number(rawValue);
                                  const warehouseGroup = warehouseStockGroupForField(column.key);
                                  if (!warehouseGroup) return null;
                                  return (
                                    <td
                                      key={column.key}
                                      className="bg-sky-50 px-1.5 py-1 text-right font-mono border-r border-sky-200"
                                      style={{ minWidth: column.width }}
                                    >
                                      <WarehouseStockValue
                                        value={value}
                                        warehouseGroup={warehouseGroup}
                                        hasInventoryAnomaly={warehouseGroup === 'INTERNAL'
                                          ? member.wfgInventoryAnomalyCount > 0
                                          : member.ye1InventoryAnomalyCount > 0}
                                        inventoryAnomalyCount={warehouseGroup === 'INTERNAL'
                                          ? member.wfgInventoryAnomalyCount
                                          : member.ye1InventoryAnomalyCount}
                                        onOpen={() => onShowWarehouseStock?.(member, warehouseGroup)}
                                      />
                                    </td>
                                  );
                                })}
                              </Fragment>
                            );
                          }
                          const g = section.group;
                          return (
                          <Fragment key={section.key}>
                          {g.showPrior && g.prior && (() => {
                            const v = Number(member[g.prior.key as keyof FgMonthlyItem]) || 0;
                            return (
                              <td
                                key={g.prior.key}
                                className={`px-1 py-1 text-right font-mono border-r border-slate-200 ${g.cellBg}`}
                                style={{ minWidth: g.prior.width }}
                                title={g.prior.label}
                              >
                                {isSourceMetric(g.key) && onShowPeriodSource ? (
                                  <button
                                    type="button"
                                    data-no-selection
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onShowPeriodSource({
                                        partVersion: member.partVersion,
                                        mrpRunId: member.mrpRunId,
                                        dbSource: member.dbSource,
                                        metric: g.key as FgMonthlySourceMetric,
                                        period: fgMonthlySourcePeriod(
                                          g.key as FgMonthlySourceMetric,
                                          v,
                                          -1,
                                          g.prior!.label,
                                        ),
                                      });
                                    }}
                                    className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                                      v === 0 ? 'text-slate-300' : 'text-slate-500'
                                    }`}
                                    title={`查看${g.prior.label}來源明細`}
                                  >
                                    {v.toLocaleString()}
                                  </button>
                                ) : v === 0
                                  ? <span className="text-slate-300">0</span>
                                  : <span className="text-slate-500">{v.toLocaleString()}</span>}
                              </td>
                            );
                          })()}
                          {mPadded.map((p, mi) => {
                            const v = p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0;
                            const isNeg = v < 0;
                            const isStockGroup = g.key === 'remainingStock' || g.key === 'remainingNoPlan';
                            // Lighter solid tints keyed off the period-group palette (e.g. yellow-50 → yellow-50/lighter feel via slate overlay isn't great — keep the same group bg but lighten via text only).
                            return (
                              <td
                                key={`m-${g.key}-${mi}`}
                                className={`px-1 py-1 text-right font-mono ${
                                  isStockGroup && isNeg ? 'bg-red-50 text-red-700' : g.cellBg
                                } ${mi === displayMonths - 1 ? 'border-r border-slate-200' : 'border-r border-slate-200'}`}
                                style={{ minWidth: PERIOD_COL_WIDTH }}
                              >
                                {isStockGroup ? (
                                  p ? (
                                    <StockCalculationValue
                                      value={v}
                                      label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`}
                                      sharedErpCount={member.sharedErpCount}
                                      erpPartNo={member.erpPartNo}
                                      onExplain={() => openStockCalculation(
                                        member,
                                        mPeriods,
                                        mi,
                                        g.key === 'remainingStock' ? 'withPlan' : 'withoutPlan',
                                      )}
                                    />
                                  ) : (
                                    <SharedBalanceValue
                                      value={v}
                                      label={`${g.label} ${labels[mi] ?? `M${mi + 1}`}`}
                                      sharedErpCount={member.sharedErpCount}
                                      erpPartNo={member.erpPartNo}
                                    />
                                  )
                                ) : p && isSourceMetric(g.key) && onShowPeriodSource ? (
                                  <button
                                    type="button"
                                    data-no-selection
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onShowPeriodSource({
                                        partVersion: member.partVersion,
                                        mrpRunId: member.mrpRunId,
                                        dbSource: member.dbSource,
                                        metric: g.key as FgMonthlySourceMetric,
                                        period: p,
                                      });
                                    }}
                                    className={`font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                                      v === 0 ? 'text-slate-300' : 'text-slate-500'
                                    }`}
                                    title={`查看${g.label} ${labels[mi] ?? `M${mi + 1}`}來源明細`}
                                  >
                                    {v.toLocaleString()}
                                  </button>
                                ) : v === 0 ? <span className="text-slate-300">0</span> : (
                                  <span className="text-slate-500">{v.toLocaleString()}</span>
                                )}
                              </td>
                            );
                          })}
                          </Fragment>
                          );
                        })}
                      </tr>
                    );
                  })}
                </>
              )}
              </Fragment>
            );
  }, [
    periodsMap, displayMonths, aggregated, expandedAggGroups, snapshot,
    memberItemsByGroup, loadingMembers, memberPeriodsByPv,
    showTree, treeData, treeColW, treeRevision,
    groupLines, tableStyle,
    visiblePrePeriodCols, labels, items,
    timelineSections, timelineSectionOffsets, timelineColumnCount,
    onShowDetail, onShowWarehouseStock, onShowPeriodSource, handleToggleAggregated,
    openStockCalculation, pinBg, pinStyle, toggleHighlight,
  ]);
  const tableZoom = TEXT_ZOOM_LEVELS[textSize] || 1;
  const rowGroups = useMemo(() => buildFgRowGroups(items, {
    showTree: Boolean(showTree && treeData && treeColW > 0),
    aggregated,
    expanded: expandedAggGroups,
    memberCounts: Object.fromEntries(Object.entries(memberItemsByGroup).map(([id, members]) => [id, members.length])),
    loading: loadingMembers,
  }), [items, showTree, treeData, treeColW, aggregated, expandedAggGroups, memberItemsByGroup, loadingMembers]);
  const virtualRows = useVirtualTableGroups({
    groups: rowGroups,
    zoom: tableZoom,
    overscan: showTree ? 1 : 6,
    geometryKey: `${textSize}:${tableStyle}`,
    resetKey: `${items[0]?.id ?? 0}:${items.at(-1)?.id ?? 0}:${items.length}`,
  });
  const firstRenderedRow = rowGroups[virtualRows.start]?.start ?? 0;
  const lastRenderedRow = rowGroups[virtualRows.end - 1]?.end ?? 0;
  const renderedRows = useVirtualTableRowNodes({
    items,
    start: firstRenderedRow,
    end: lastRenderedRow,
    renderRow,
    renderVersion: renderRow,
  });
  const bodyColSpan = tableColumnWidths.length;

  if (loading && Object.keys(periodsMap).length === 0) {
    return <Loader />;
  }

  if (periodsError && Object.keys(periodsMap).length === 0) {
    return (
      <div
        role="alert"
        className="flex items-center justify-center gap-2 min-h-40 border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg"
      >
        <AlertTriangle size={16} />
        <span>{periodsError}</span>
      </div>
    );
  }

  return (
    // flex-1 min-h-0 — claim all remaining vertical space within the parent
    // flex-col (fg-monthly.tsx outer). flex flex-col inside lays out the
    // legend + table region.
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Legend + export buttons — fixed above table (flex-shrink-0 so it
          doesn't lose height when the table region grows) */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-t-lg text-[10px] flex-wrap">
        <span className="font-semibold text-slate-500">Legend:</span>
        {timelineGroups.map((g) => (
          <span key={g.key} className={`${g.headerBg} px-1.5 py-0.5 rounded`}>
            {g.label}
          </span>
        ))}
        <SharedErpLegend />
        {tableStyle !== 'ragic' && !showTree && groupLines.byForging && (
          <span className="flex items-center gap-1 text-slate-500 border-l border-slate-300 pl-2 ml-1">
            <span className="font-semibold">分群:</span>
            <span className="inline-flex align-middle">
              <span className="inline-block w-3 h-3 bg-white border border-slate-300" />
              <span className="inline-block w-3 h-3 bg-sky-100 border border-l-0 border-sky-300" />
            </span>
            <span>白/藍交替 = 換鍛造母件</span>
            <span className="inline-block w-5 border-t-[3px] border-slate-500 align-middle ml-1" />
            <span>粗線 = 同母件內換客戶料號</span>
          </span>
        )}
        {tableStyle !== 'ragic' && !showTree && !groupLines.byForging && (
          <span className="flex items-center gap-1.5 border-l border-amber-300 pl-2 text-amber-700">
            <span className="font-semibold">分群已暫停</span>
            <span className="text-amber-600">主排序不是鍛造母件</span>
            {onRestoreGrouping && (
              <button
                type="button"
                onClick={onRestoreGrouping}
                className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
              >
                恢復分群
              </button>
            )}
          </span>
        )}
        {highlightedRowIds.size > 0 && (
          <span className="flex items-center gap-1.5 text-xs border-l border-slate-300 pl-2 ml-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-[#fef9c3] border border-[#ca8a04]" />
            <span className="text-slate-600">標記 {highlightedRowIds.size} 列</span>
            <button
              onClick={clearHighlight}
              className="ml-0.5 px-1.5 py-0.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-100 text-[11px]"
            >
              清除標記
            </button>
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => handleExport('xlsx')}
          disabled={items.length === 0 || exporting}
          className="px-2 py-0.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-[10px] font-medium"
        >
          {exporting ? '匯出中...' : snapshot ? 'Excel（本頁）' : 'Excel'}
        </button>
        <button
          onClick={() => handleExport('csv')}
          disabled={items.length === 0 || exporting}
          className="px-2 py-0.5 bg-slate-600 text-white rounded hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-[10px] font-medium"
        >
          {exporting ? '匯出中...' : snapshot ? 'CSV（本頁）' : 'CSV'}
        </button>
      </div>
      <FloatingSelectionSummary
        stats={active ? selStats : null}
        isSelecting={dragging}
        warning={selectionIncludesSharedBalance
          ? '含共享池快照，合計不等於實體總庫存'
          : null}
        onShowCalculation={selectedStockCell
          ? () => openStockCalculation(
              selectedStockCell.item,
              selectedStockCell.periods,
              selectedStockCell.periodIndex,
              selectedStockCell.balanceKind,
            )
          : null}
        onClear={clearSelection}
      />
      {/* 釘選列 bar — 抽成 memoized sub-component，避免 menu state 之類無關
          re-render 連帶把 PinnedBar 也 reconcile（一次 ~200 個 DOM nodes）。 */}
      <PinnedRowsBar items={pinnedItems} onUnpin={unpinRow} onClearAll={clearPins} />

      <div
        ref={virtualRows.containerRef}
        onScroll={virtualRows.onScroll}
        data-mrp-scroll
        className="flex-1 min-h-0 overflow-auto border border-slate-300 border-t-0 rounded-b-lg bg-white"
      >
      {highlightCss && <style>{highlightCss}</style>}
      {selectionCss && <style>{selectionCss}</style>}
      <table
        ref={tableRef}
        tabIndex={-1}
        className={`fg-monthly-trad-table mrp-trad-table text-xs border-separate border-spacing-0 ${dragging ? 'select-none' : ''}`}
        data-table-style={tableStyle}
        style={{
          zoom: tableZoom,
          tableLayout: 'fixed',
          width: tableWidth,
        }}
        onMouseDown={handleTableMouseDown}
        onMouseOver={handleTableMouseOver}
        onContextMenu={cellMenu.handleContextMenu}
        onCopy={cellMenu.handleCopy}
      >
        <colgroup>
          {tableColumnWidths.map((width, index) => (
            <col key={`${index}-${width}`} style={{ width }} />
          ))}
        </colgroup>
        {/* ===== HEADER ===== */}
        <thead className="sticky top-0 z-30">
          {/* Row 1: Group headers — border 改 cell-level box-shadow（見 globals.css），
              border-collapse + sticky thead 用 <tr> 級 border 會在 scroll 時露縫。 */}
          <tr>
            <th
              rowSpan={2}
              className="bg-slate-200 border-r border-slate-300"
              style={{ position: 'sticky', left: 0, zIndex: 50, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
              aria-label="標記"
            />
            <th
              rowSpan={2}
              className="bg-slate-200 border-r border-slate-300"
              style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, zIndex: 50, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
              aria-label="詳細"
            />
            {showTree && treeColW > 0 && (
              <th
                rowSpan={2}
                className="bg-emerald-50 border-r-2 border-emerald-300 text-emerald-800 text-[10px] font-semibold px-2 align-bottom"
                style={{
                  width: treeColW,
                  minWidth: treeColW,
                  // Pin to the right of the detail-icon column so the tree
                  // stays visible while scrolling the rest of the table.
                  position: 'sticky',
                  left: CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH,
                  zIndex: 50,
                }}
              >
                <div className="text-left">成品製程版本樹</div>
                <div className="text-[9px] font-normal text-emerald-600 mt-0.5">
                  同一鍛造母件下相鄰列共用前段製程，分歧處顯示為 <span className="text-amber-700">琥珀色</span> 節點
                </div>
              </th>
            )}
            {row1Groups.map((grp) => {
              const endIdx = grp.startIdx + grp.count;
              const groupFullyFrozen = endIdx <= frozenCount;

              if (grp.group === 'frozen') {
                // Render individual cells for frozen group (to support per-cell sticky)
                return visiblePrePeriodCols
                  .slice(grp.startIdx, endIdx)
                  .map((col, i) => {
                    const gi = grp.startIdx + i;
                    return (
                      <th
                        key={col.key}
                        className={`${grp.headerBg} border-r border-slate-300 px-1`}
                        style={pinStyle(gi, col.width, 40)}
                      >
                        {i === 0 ? (
                          <span className="text-[10px] text-slate-500 font-normal">{grp.label}</span>
                        ) : null}
                      </th>
                    );
                  });
              }

              // ColSpan group header
              return (
                <th
                  key={grp.group}
                  colSpan={grp.count}
                  className={`${grp.headerBg} text-center text-[10px] border-r border-slate-400 px-1`}
                  style={groupFullyFrozen ? { position: 'sticky', left: cumLefts[grp.startIdx], zIndex: 40 } : undefined}
                  title={grp.group === 'wo'
                    ? '前三欄只統計未結案 HF01 鍛造工令；累計報工與結案入庫來自生產計畫。此區僅供進度參考，不參與剩餘庫存計算。'
                    : undefined}
                >
                  {grp.label}
                </th>
              );
            })}

            {/* Status group is now part of row1Groups (visiblePrePeriodCols) */}

            {/* Period year-month — top row (對齊 Ragic d4/22 版面)。每格加上
                Mx 期號，方便跟「缺料期 Mx」欄對照。 */}
            {timelineSections.map((section) => {
              if (section.kind === 'warehouse') {
                return (
                  <th
                    key={section.key}
                    colSpan={section.columns.length}
                    className="bg-sky-100 px-1 py-1.5 text-center text-[10px] font-semibold text-sky-900 border-r border-sky-300"
                  >
                    倉庫在庫
                  </th>
                );
              }
              const g = section.group;
              return (
              <Fragment key={section.key}>
              {g.showPrior && g.prior && (
                <th
                  className={`${g.headerBg} px-1 py-1.5 text-center font-semibold whitespace-nowrap text-[10px] leading-tight border-r border-slate-300`}
                  style={{ minWidth: g.prior.width }}
                  title={g.prior.label}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(g.prior.key)!}
                    controller={columnHeaderController}
                    label="前期未結"
                    labelClassName="text-center"
                  />
                </th>
              )}
              {labels.map((label, mi) => (
                <th
                  key={`${g.key}-${mi}`}
                  className={`${g.headerBg} px-1 py-1.5 text-center font-medium whitespace-nowrap text-[10px] leading-tight ${
                    mi === displayMonths - 1 ? 'border-r border-slate-400' : 'border-r border-slate-200'
                  }`}
                  style={{ minWidth: PERIOD_COL_WIDTH }}
                >
                  <span className="block text-[9px] font-normal opacity-75">M{mi + 1}</span>
                  {label}
                </th>
              ))}
              </Fragment>
              );
            })}
          </tr>

          {/* Row 2: Column headers — 同上，border-b 改 cell-level box-shadow */}
          <tr className="bg-slate-100">
            {visiblePrePeriodCols.map((col, gi) => {
              const isWo = col.group === 'wo';
              const headerBg = (isWo && col.headerBg) ? col.headerBg : 'bg-slate-100';
              const isFrozenGroup = col.group === 'frozen';
              const isMaterialReminder = col.key === 'materialReminder';
              return (
                <th
                  key={col.key}
                  className={`${headerBg} px-1.5 py-1.5 ${isMaterialReminder ? 'text-center' : isFrozenGroup ? 'text-left' : 'text-right'} font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]`}
                  style={pinStyle(gi, col.width, 40)}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(col.key)!}
                    controller={columnHeaderController}
                    label={col.label}
                    labelClassName={isMaterialReminder ? 'text-center pl-3.5' : isFrozenGroup ? 'text-left' : 'text-right'}
                  />
                </th>
              );
            })}

            {/* Status columns now render inside visiblePrePeriodCols above */}

            {/* Period group labels — second row, below the year-month */}
            {timelineSections.map((section) => {
              if (section.kind === 'warehouse') {
                return (
                  <Fragment key={section.key}>
                    {section.columns.map((column) => (
                      <th
                        key={column.key}
                        className="bg-sky-50 px-1.5 py-1.5 text-right text-[10px] font-semibold text-sky-900 whitespace-nowrap border-r border-sky-200"
                        style={{ minWidth: column.width }}
                      >
                        <ColumnHeaderButton
                          column={columnHeaderById.get(column.key)!}
                          controller={columnHeaderController}
                          label={column.label}
                          labelClassName="text-right"
                        />
                      </th>
                    ))}
                  </Fragment>
                );
              }
              const g = section.group;
              return (
                <th
                  key={section.key}
                  colSpan={displayMonths + (g.showPrior ? 1 : 0)}
                  className={`${g.headerBg} text-center text-[10px] font-bold px-1 border-r border-slate-400`}
                >
                  {g.label}
                </th>
              );
            })}
          </tr>
        </thead>

        {/* ===== BODY ===== */}
        <tbody>
          <VirtualTableSpacer height={virtualRows.topSpacerHeight} colSpan={bodyColSpan} zoom={tableZoom} />
        </tbody>
        {rowGroups.slice(virtualRows.start, virtualRows.end).map((group, index) => (
          <tbody key={group.key} data-virtual-group={virtualRows.start + index} data-stripe-start={(group.stripeStart ?? 0) % 2}>
            {renderedRows.slice(group.start - firstRenderedRow, group.end - firstRenderedRow)}
          </tbody>
        ))}
        <tbody>
          <VirtualTableSpacer height={virtualRows.bottomSpacerHeight} colSpan={bodyColSpan} zoom={tableZoom} />
        </tbody>

        {/* ===== 合計列 ===== server 對「整個篩選結果」(不只當前頁) 算的 SUM。
            sticky bottom，永遠貼在捲動區底部；合併 DB 模式 totals=null 不顯示。 */}
        {totals && items.length > 0 && (
          <tfoot>
            <tr>
              {/* 標記欄 placeholder */}
              <td
                className="bg-slate-200 border-t-2 border-slate-400 border-r border-slate-300"
                style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 42, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
              />
              {/* 詳細欄 */}
              <td
                className="bg-slate-200 border-t-2 border-slate-400 border-r border-slate-300 text-center text-[10px] font-bold text-slate-600"
                style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, bottom: 0, zIndex: 42, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
              >
                合計
              </td>
              {/* 製程樹欄 */}
              {showTree && treeColW > 0 && (
                <td
                  className="bg-slate-200 border-t-2 border-slate-400 border-r border-slate-300"
                  style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH, bottom: 0, zIndex: 42, width: treeColW, minWidth: treeColW }}
                />
              )}
              {/* Part Info / Status / 數量欄 */}
              {visiblePrePeriodCols.map((col, gi) => {
                const raw = totals.preperiod[col.key];
                const style = pin(gi)
                  ? { position: 'sticky' as const, left: cumLefts[gi], bottom: 0, zIndex: 42, minWidth: col.width, maxWidth: col.width }
                  : { position: 'sticky' as const, bottom: 0, zIndex: 25, minWidth: col.width };
                return (
                  <td
                    key={col.key}
                    className="bg-slate-200 border-t-2 border-slate-400 border-r border-slate-200 px-1.5 py-1 text-right font-mono text-[10px] font-bold text-slate-700"
                    style={style}
                  >
                    {raw == null ? '' : footTotalNum(Number(raw))}
                  </td>
                );
              })}
              {/* 期推移合計 */}
              {timelineSections.map((section) => {
                if (section.kind === 'warehouse') {
                  return (
                    <Fragment key={section.key}>
                      {section.columns.map((column) => (
                        <td
                          key={column.key}
                          className="bg-sky-100 border-t-2 border-slate-400 border-r border-sky-200 px-1.5 py-1 text-right font-mono text-[10px] font-bold text-slate-700"
                          style={{ position: 'sticky', bottom: 0, zIndex: 25, minWidth: column.width }}
                        >
                          {totals.preperiod[column.key] == null
                            ? '—'
                            : footTotalNum(Number(totals.preperiod[column.key]))}
                        </td>
                      ))}
                    </Fragment>
                  );
                }
                const g = section.group;
                return (
                <Fragment key={section.key}>
                {g.showPrior && g.prior && (
                  <td
                    className="bg-slate-200 border-t-2 border-slate-400 border-r border-slate-300 px-1 py-1 text-right font-mono text-[10px] font-bold text-slate-700"
                    style={{ position: 'sticky', bottom: 0, zIndex: 25, minWidth: g.prior.width }}
                  >
                    {footTotalNum(Number(totals.preperiod[g.prior.key]) || 0)}
                  </td>
                )}
                {Array.from({ length: displayMonths }, (_, mi) => {
                  const n = Number(periodTotalMap.get(mi)?.[g.key]) || 0;
                  return (
                    <td
                      key={`${g.key}-${mi}`}
                      className={`bg-slate-200 border-t-2 border-slate-400 px-1 py-1 text-right font-mono text-[10px] font-bold ${
                        mi === displayMonths - 1 ? 'border-r border-slate-400' : 'border-r border-slate-200'
                      } ${n < 0 ? 'text-red-700' : 'text-slate-700'}`}
                      style={{ position: 'sticky', bottom: 0, zIndex: 25, minWidth: PERIOD_COL_WIDTH }}
                    >
                      {footTotalNum(n)}
                    </td>
                  );
                })}
                </Fragment>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
      </div>
      {active && <CellContextMenu {...cellMenu.contextMenuProps} />}
      {active && stockCalculation && (
        <StockCalculationDrawer
          detail={stockCalculation}
          onClose={closeStockCalculation}
        />
      )}
    </div>
  );
}

// ============================================================
// PinnedRowsBar — 釘選列 floating bar，記得用 React.memo 包：menu state 變化
// 觸發 traditional re-render 時，此 component props 通常 unchanged 跳過 reconcile。
// onUnpin / onClearAll 上層必須用 useCallback 穩定 ref，否則 memo 沒效。
// ============================================================
const PinnedRowsBar = memo(function PinnedRowsBar({
  items,
  onUnpin,
  onClearAll,
}: {
  items: FgMonthlyItem[];
  onUnpin: (id: number) => void;
  onClearAll: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 bg-indigo-50 border-x border-indigo-200 text-[11px]">
      <span className="text-indigo-700 font-semibold">📌 釘選 ({items.length}):</span>
      {items.map((it) => (
        <div
          key={it.id}
          className="inline-flex items-center gap-1.5 px-2 py-1 bg-white border border-indigo-300 rounded shadow-sm"
        >
          <span className="font-mono font-semibold text-slate-800">{it.partVersion}</span>
          {it.customerCode && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500">{it.customerCode}</span>
            </>
          )}
          {it.forgingMachine && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500">{it.forgingMachine}</span>
            </>
          )}
          <span className="text-slate-300">|</span>
          <span className="text-slate-600 font-mono">
            可用庫存 {Number(it.currentStockPc).toLocaleString()}
          </span>
          <button
            onClick={() => onUnpin(it.id)}
            className="text-slate-400 hover:text-red-500 ml-1 leading-none"
            title="取消釘選"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={onClearAll}
        className="text-slate-400 hover:text-red-500 ml-auto px-1.5 py-0.5 rounded border border-slate-300 hover:border-red-300"
        title="全部取消釘選"
      >
        全部清除
      </button>
    </div>
  );
});
