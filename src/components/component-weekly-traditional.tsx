'use client';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { Loader } from './ui/loader';
import { cachePeek, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import { exportToFile, type ExportFormat } from '@/lib/export-utils';
import {
  componentWeeklyPeriodsCacheKey,
  componentWeeklyRowKey,
  loadComponentWeeklyPeriods,
  type ComponentWeeklyPeriodDetail,
  type ComponentWeeklyPeriodLoadFailure,
} from '@/lib/mrp/component-weekly-periods';
import {
  formatComponentWeeklyLeadTime,
  presentComponentWeeklyPurchaseAction,
  presentComponentWeeklyShortage,
  type ComponentWeeklyDecisionSummary,
} from '@/lib/mrp/component-weekly-purchase';
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
  CellContextMenu,
  useCellContextMenu,
} from './data-table/ui/cell-context-menu';
import {
  ColumnHeaderButton,
  type ColumnHeaderMenuController,
} from './data-table/ui/column-header-menu';
import type { ColumnFilter, ColumnVisibilityState, MrpColumnDef, SortField } from './data-table/types';
import { COMPONENT_WEEKLY_COLUMNS } from './data-table/column-defs/component-weekly-columns';
import { PinnedRowsBar, usePinnedRows } from './data-table/ui/pinned-rows-bar';
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
import {
  VirtualTableSpacer,
  useVirtualTableRowNodes,
  useVirtualTableRows,
} from './ui/virtual-table-rows';
import { useRafCellFocus } from './ui/use-raf-cell-focus';
import { FloatingSelectionSummary } from './ui/floating-selection-summary';

const CHECKBOX_COL_WIDTH = 24;
const DETAIL_COL_WIDTH = 44;

type Cell = { r: number; c: number };

function cellsToRect(a: Cell, f: Cell): BoxSelRect {
  return {
    minR: Math.min(a.r, f.r),
    maxR: Math.max(a.r, f.r),
    minC: Math.min(a.c, f.c),
    maxC: Math.max(a.c, f.c),
  };
}

function cellCoordOf(target: EventTarget | null): Cell | null {
  const td = (target as HTMLElement | null)?.closest?.('td[data-selc]') as HTMLElement | null;
  if (!td) return null;
  const r = Number(td.dataset.selr);
  const c = Number(td.dataset.selc);
  return Number.isNaN(r) || Number.isNaN(c) ? null : { r, c };
}

function numCell(val: number | null | undefined, decimals = 0, negative?: boolean) {
  const n = Number(val) || 0;
  if (n === 0) return <span className="text-slate-300 font-mono">0</span>;
  const formatted = decimals > 0
    ? n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : n.toLocaleString();
  return (
    <span className={`font-mono ${negative && n < 0 ? 'text-red-700 font-bold' : ''}`}>
      {formatted}
    </span>
  );
}

// ============================================================
// Types (matching component-weekly.tsx)
// ============================================================
export interface ComponentWeeklyItem extends ComponentWeeklyDecisionSummary {
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

const HighlightedRowsContext = createContext<ReadonlySet<string>>(new Set());

const ComponentWeeklyHighlightToggle = memo(function ComponentWeeklyHighlightToggle({
  materialPartNo,
  onToggle,
  rowKey,
}: {
  materialPartNo: string;
  onToggle: (rowKey: string) => void;
  rowKey: string;
}) {
  const highlightedRows = useContext(HighlightedRowsContext);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle(rowKey);
      }}
      className="hl-toggle w-3 h-3 rounded-sm border border-slate-300 bg-white hover:border-indigo-400"
      title="標記此列"
      aria-label={`標記 ${materialPartNo}`}
      aria-pressed={highlightedRows.has(rowKey)}
    />
  );
});

const MemoizedComponentWeeklyRows = memo(function MemoizedComponentWeeklyRows({
  end,
  items,
  renderRow,
  renderVersion,
  start,
}: {
  end: number;
  items: ComponentWeeklyItem[];
  renderRow: (item: ComponentWeeklyItem, localRowIndex: number) => ReactNode;
  renderVersion: object;
  start: number;
}) {
  const rows = useVirtualTableRowNodes({
    items,
    start,
    end,
    renderRow,
    renderVersion,
  });
  return <>{rows}</>;
}, (previous, next) => (
  previous.items === next.items
  && previous.start === next.start
  && previous.end === next.end
  && previous.renderVersion === next.renderVersion
));

type PeriodDetail = ComponentWeeklyPeriodDetail;

// ============================================================
// Column definitions
// ============================================================
const FROZEN_COLS = [
  { key: 'materialPartNo', label: '料號', width: 180 },
  { key: 'unit', label: '單位', width: 50 },
];

const STOCK_COLS = [
  { key: 'goodStockPc', label: '良品pc', width: 75 },
  { key: 'goodStockKg', label: '良品kg', width: 75 },
  { key: 'badStockPc', label: '不良品pc', width: 70 },
  { key: 'badStockKg', label: '不良品kg', width: 70 },
];

const ANALYTICS_COLS = [
  { key: 'avgWeeklyUsage', label: '平均用量/週', width: 80 },
  { key: 'stockWeeks', label: '庫存週數', width: 70 },
  { key: 'purchaseLeadWeeks', label: '採購前置期', width: 92 },
];

// Period column groups, ordered to match synthetic weekly view: 剩餘庫存 → 工令用料 → 預納.
const PERIOD_GROUPS = [
  { key: 'remainingStock', label: '剩餘庫存', headerBg: 'bg-emerald-800 text-white', cellBg: 'bg-emerald-50', borderColor: 'border-emerald-300' },
  { key: 'usage', label: '工令用料', headerBg: 'bg-orange-500 text-white', cellBg: 'bg-orange-50', borderColor: 'border-orange-300' },
  { key: 'receipts', label: '預納(進貨)', headerBg: 'bg-green-500 text-white', cellBg: 'bg-green-50', borderColor: 'border-green-300' },
];

const STATUS_COLS = [
  { key: 'shortageStartWeek', label: '開始缺貨', width: 112 },
  { key: 'weeksUntilOrder', label: '最晚下單／處置', width: 118 },
];

const PERIOD_COL_WIDTH = 60;

export const COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS = [
  ...FROZEN_COLS,
  ...STOCK_COLS,
  ...ANALYTICS_COLS,
].map((column) => column.key);

export const CW_DEFAULT_FROZEN = FROZEN_COLS.length;
export const CW_MAX_FROZEN = COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS.length;

// ============================================================
// Traditional View Component
// ============================================================
export function ComponentWeeklyTraditionalView({
  items,
  active = true,
  mrpType,
  textSize = 0,
  frozenCount = CW_DEFAULT_FROZEN,
  fetchAllForExport,
  columnVisibility = {},
  columnFilters = [],
  onSetColumnFilter,
  onRemoveColumnFilter,
  sortFields,
  onAddSort,
  onRemoveSort,
  onToggleColumn,
  onFreezeToColumn,
  columnHeaderController,
  columnHeaderColumns,
  snapshot,
  preloadedPeriods,
  onInspect,
}: {
  items: ComponentWeeklyItem[];
  active?: boolean;
  mrpType: string;
  textSize?: number;
  frozenCount?: number;
  fetchAllForExport?: () => Promise<ComponentWeeklyItem[]>;
  columnVisibility?: ColumnVisibilityState;
  columnFilters?: ColumnFilter[];
  onSetColumnFilter?: (filter: ColumnFilter) => void;
  onRemoveColumnFilter?: (columnId: string) => void;
  sortFields?: SortField[];
  onAddSort?: (field: SortField) => void;
  onRemoveSort?: (fieldId: string) => void;
  onToggleColumn?: (columnId: string) => void;
  onFreezeToColumn?: (columnId: string) => void;
  columnHeaderController: ColumnHeaderMenuController;
  columnHeaderColumns: MrpColumnDef[];
  snapshot?: { periods: Record<string, PeriodDetail[]>; missingFields: string[]; label: string };
  preloadedPeriods?: Record<string, PeriodDetail[]>;
  onInspect?: (item: ComponentWeeklyItem) => void;
}) {
  const [livePeriodsMap, setPeriodsMap] = useState<Record<string, PeriodDetail[]>>({});
  const periodsMap = snapshot?.periods ?? preloadedPeriods ?? livePeriodsMap;
  const columnHeaderById = useMemo(
    () => new Map(columnHeaderColumns.map((column) => [column.id, column])),
    [columnHeaderColumns],
  );
  const [loading, setLoading] = useState(false);
  const [periodFailures, setPeriodFailures] = useState<ComponentWeeklyPeriodLoadFailure[]>([]);
  const [periodRetry, setPeriodRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [selRects, setSelRects] = useState<BoxSelRect[]>([]);
  const [draftAnchor, setDraftAnchorState] = useState<Cell | null>(null);
  const [draftFocus, setDraftFocusState] = useState<Cell | null>(null);
  const [dragging, setDraggingState] = useState(false);
  const draftAnchorRef = useRef<Cell | null>(null);
  const draftFocusRef = useRef<Cell | null>(null);
  const draggingRef = useRef(false);
  const detailDragRef = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const isVisible = useCallback(
    (columnId: string) => columnVisibility[columnId] !== false,
    [columnVisibility],
  );
  const visibleFrozenCols = useMemo(() => FROZEN_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const visibleStockCols = useMemo(() => STOCK_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const visibleAnalyticsCols = useMemo(() => ANALYTICS_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const visibleStatusCols = useMemo(() => STATUS_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const selectionPrePeriodCols = useMemo(() => [
    ...visibleFrozenCols.map((column) => ({ key: column.key, filterType: 'text' })),
    ...visibleStockCols.map((column) => ({ key: column.key, filterType: 'numeric' })),
    ...visibleAnalyticsCols.map((column) => ({ key: column.key, filterType: 'numeric' })),
    ...visibleStatusCols.map((column) => ({ key: column.key, filterType: 'numeric' })),
  ], [visibleAnalyticsCols, visibleFrozenCols, visibleStatusCols, visibleStockCols]);
  const groupOffsets = useMemo(() => ({
    frozen: 0,
    stock: visibleFrozenCols.length,
    analytics: visibleFrozenCols.length + visibleStockCols.length,
    status: visibleFrozenCols.length + visibleStockCols.length + visibleAnalyticsCols.length,
  }), [visibleAnalyticsCols.length, visibleFrozenCols.length, visibleStockCols.length]);
  const cumLefts = useMemo(() => {
    const lefts: number[] = [];
    let left = CHECKBOX_COL_WIDTH + DETAIL_COL_WIDTH;
    for (const column of [...visibleFrozenCols, ...visibleStockCols, ...visibleAnalyticsCols]) {
      lefts.push(left);
      left += column.width;
    }
    return lefts;
  }, [visibleAnalyticsCols, visibleFrozenCols, visibleStockCols]);
  const row1Groups = useMemo(() => [
    { label: 'Material', cols: visibleFrozenCols, startIdx: groupOffsets.frozen, headerBg: 'bg-slate-200', individual: true },
    { label: 'Inventory', cols: visibleStockCols, startIdx: groupOffsets.stock, headerBg: 'bg-slate-200 text-slate-600', individual: false },
    { label: 'Analytics', cols: visibleAnalyticsCols, startIdx: groupOffsets.analytics, headerBg: 'bg-slate-200 text-slate-600', individual: false },
  ].filter((group) => group.cols.length > 0), [groupOffsets, visibleAnalyticsCols, visibleFrozenCols, visibleStockCols]);
  const { pinnedItems, pinRow, unpinRow, clearPins } = usePinnedRows(items);
  const [highlightedRowIds, setHighlightedRowIds] = useState<Set<string>>(() => new Set());
  const [usageDetailTarget, setUsageDetailTarget] = useState<ComponentWeeklyUsageTarget | null>(null);

  const openUsageDetail = useCallback((
    item: ComponentWeeklyItem,
    options: {
      weekIndex?: number | null;
      weekLabel?: string;
      initialTab: ComponentWeeklyUsageDetailTab;
      focusMetric: ComponentWeeklyUsageMetric;
    },
  ) => {
    if (snapshot) { onInspect?.(item); return; }
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
  }, [snapshot, onInspect]);

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

  const setDraftAnchor = useCallback((value: Cell | null) => {
    draftAnchorRef.current = value;
    setDraftAnchorState(value);
  }, []);
  const setDraftFocus = useCallback((value: Cell | null) => {
    draftFocusRef.current = value;
    setDraftFocusState(value);
  }, []);
  const setDragging = useCallback((value: boolean) => {
    draggingRef.current = value;
    setDraggingState(value);
  }, []);
  const {
    cancel: cancelScheduledDraftFocus,
    flush: flushDraftFocus,
    schedule: scheduleDraftFocus,
  } = useRafCellFocus(draftFocusRef, setDraftFocus);
  const clearSelection = useCallback(() => {
    cancelScheduledDraftFocus();
    setSelRects([]);
    setDraftAnchor(null);
    setDraftFocus(null);
  }, [cancelScheduledDraftFocus, setDraftAnchor, setDraftFocus]);
  const toggleHighlight = useCallback((id: string) => {
    setHighlightedRowIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearHighlight = useCallback(() => setHighlightedRowIds(new Set()), []);

  const periodsKey = snapshot || preloadedPeriods ? null : componentWeeklyPeriodsCacheKey(items);
  // 切頁回來時 paint 前先鋪上快取的格資料 → 傳統 view 零 spinner
  useLayoutEffect(() => {
    if (!periodsKey) return;
    const cached = cachePeek<Record<string, PeriodDetail[]>>(periodsKey);
    if (cached) {
      setPeriodsMap(cached);
      setPeriodFailures([]);
      setLoading(false);
    } else {
      setPeriodsMap({});
      setPeriodFailures([]);
      setLoading(true);
    }
  }, [periodsKey]);

  useEffect(() => {
    if (snapshot || preloadedPeriods) return;
    if (items.length === 0) {
      setPeriodsMap({});
      setPeriodFailures([]);
      return;
    }

    let cancelled = false;
    const fetchPeriods = async () => {
      const cached = periodsKey ? cachePeek<Record<string, PeriodDetail[]>>(periodsKey) : undefined;
      if (cached) {
        setPeriodsMap(cached);
        setPeriodFailures([]);
        setLoading(false);
        if (periodsKey && cacheIsFresh(periodsKey)) return;
      } else {
        setLoading(true);
      }
      const result = await loadComponentWeeklyPeriods(items);
      if (cancelled) return;
      setPeriodsMap(result.periods);
      setPeriodFailures(result.failures);
      if (periodsKey && result.failures.length === 0) cacheSet(periodsKey, result.periods);
      setLoading(false);
    };

    fetchPeriods();
    return () => { cancelled = true; };
  }, [items, mrpType, periodsKey, periodRetry, snapshot, preloadedPeriods]);

  const failedPeriodRowKeys = useMemo(
    () => new Set(periodFailures.flatMap((failure) => failure.rowKeys)),
    [periodFailures],
  );
  const failedPeriodScopeLabels = useMemo(
    () => periodFailures.map(({ scope }) => `${scope.dbSource || '目前資料庫'} / Run ${scope.runId}`),
    [periodFailures],
  );

  const { labels, numWeeks } = useMemo(() => {
    const samplePeriods = Object.values(periodsMap)[0] || [];
    const weekLabels = samplePeriods.map(
      (period) => period.weekLabel || `W${String(period.weekIndex).padStart(2, '0')}`,
    );
    const resolvedNumWeeks = weekLabels.length || 28;
    return {
      labels: weekLabels.length > 0
        ? weekLabels
        : Array.from(
          { length: resolvedNumWeeks },
          (_, index) => index === 0 ? '前期' : `W${String(index).padStart(2, '0')}`,
        ),
      numWeeks: resolvedNumWeeks,
    };
  }, [periodsMap]);

  const selectionTimelineCols = useMemo<BoxSelTimelineColumn[]>(() => [
    ...PERIOD_GROUPS.flatMap((group) =>
      Array.from({ length: numWeeks }, (_, weekIndex) => ({
        kind: 'period' as const,
        groupKey: group.key,
        monthIndex: weekIndex,
      })),
    ),
  ], [numWeeks]);

  const draftRect = useMemo(
    () => (draftAnchor && draftFocus ? cellsToRect(draftAnchor, draftFocus) : null),
    [draftAnchor, draftFocus],
  );
  const effectiveRects = useMemo(
    () => (draftRect ? [...selRects, draftRect] : selRects),
    [selRects, draftRect],
  );
  const selectionCss = useMemo(() => buildSelectionRangeCss({
    rects: effectiveRects,
    tableSelector: '.component-weekly-trad-table',
    firstSelectableChildIndex: 3,
  }), [effectiveRects]);
  const highlightCss = useMemo(() => {
    if (highlightedRowIds.size === 0) return '';
    const ids = [...highlightedRowIds];
    const rowSelectors = ids.map((id) => `.component-weekly-trad-table tr[data-row-key="${id}"] > td`).join(',');
    const barSelectors = ids.map((id) => `.component-weekly-trad-table tr[data-row-key="${id}"] > td:first-child::before`).join(',');
    const toggleSelectors = ids.map((id) => `.component-weekly-trad-table tr[data-row-key="${id}"] .hl-toggle`).join(',');
    return `${rowSelectors}{background-color:#c7d2fe !important}`
      + `${barSelectors}{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:#4f46e5;z-index:20}`
      + `${toggleSelectors}{background-color:#4f46e5 !important;border-color:#4338ca !important}`;
  }, [highlightedRowIds]);

  const handleTableMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const coord = cellCoordOf(event.target);
    if (!coord) return;
    detailDragRef.current = false;
    event.preventDefault();
    tableRef.current?.focus({ preventScroll: true });
    if (!event.ctrlKey && !event.metaKey) setSelRects([]);
    cancelScheduledDraftFocus();
    setDragging(true);
    setDraftAnchor(coord);
    setDraftFocus(coord);
  }, [cancelScheduledDraftFocus, setDragging, setDraftAnchor, setDraftFocus]);
  const handleTableMouseOver = useCallback((event: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const coord = cellCoordOf(event.target);
    if (!coord) return;
    if (scheduleDraftFocus(coord)) detailDragRef.current = true;
  }, [scheduleDraftFocus]);
  const handleTableMouseMove = useCallback((event: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const coord = cellCoordOf(document.elementFromPoint(event.clientX, event.clientY));
    if (!coord) return;
    if (scheduleDraftFocus(coord)) detailDragRef.current = true;
  }, [scheduleDraftFocus]);

  useEffect(() => {
    clearSelection();
    clearHighlight();
    setUsageDetailTarget(null);
  }, [items, mrpType, numWeeks, clearSelection, clearHighlight]);

  useEffect(() => {
    if (!dragging) return;
    const finish = (event: MouseEvent) => {
      setDragging(false);
      const anchor = draftAnchorRef.current;
      const focus = flushDraftFocus(
        cellCoordOf(document.elementFromPoint(event.clientX, event.clientY)),
      );
      if (anchor && focus) setSelRects((previous) => [...previous, cellsToRect(anchor, focus)]);
      setDraftAnchor(null);
      setDraftFocus(null);
    };
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, [dragging, flushDraftFocus, setDragging, setDraftAnchor, setDraftFocus]);

  const hasSelection = effectiveRects.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', clearOnEscape);
    return () => window.removeEventListener('keydown', clearOnEscape);
  }, [hasSelection, clearSelection]);

  const selectionSummary = useMemo(() => {
    if (effectiveRects.length === 0) return null;
    const args: SelectionStatsArgs = {
      rects: effectiveRects,
      prePeriodCols: selectionPrePeriodCols,
      periodGroupKeys: PERIOD_GROUPS.map((group) => group.key),
      displayMonths: numWeeks,
      timelineCols: selectionTimelineCols,
      rowCount: items.length,
      getPrePeriodValue: (row, key) => items[row]?.[key as keyof ComponentWeeklyItem] ?? null,
      getPeriodValue: (row, groupKey, weekIndex) => {
        if (groupKey === 'remainingStock' && weekIndex === 0) return null;
        const item = items[row];
        if (!item) return null;
        const rowKey = componentWeeklyRowKey(item);
        if (failedPeriodRowKeys.has(rowKey)) return null;
        const period = (periodsMap[rowKey] || [])[weekIndex];
        if (!period) return null;
        return period[groupKey as keyof PeriodDetail];
      },
    };
    return {
      stats: computeSelectionStats(args),
      clipboardText: draftRect ? null : buildSelectionClipboardText(args),
    };
  }, [draftRect, effectiveRects, items, periodsMap, failedPeriodRowKeys, numWeeks, selectionPrePeriodCols, selectionTimelineCols]);
  const selectionStats = selectionSummary?.stats ?? null;
  const selectionClipboardText = selectionSummary?.clipboardText ?? null;
  const isSelectedCell = useCallback((cell: HTMLTableCellElement) => {
    const row = Number(cell.dataset.selr);
    const column = Number(cell.dataset.selc);
    return Number.isInteger(row)
      && Number.isInteger(column)
      && isCellInSelection(effectiveRects, row, column);
  }, [effectiveRects]);
  const getSelectionCopy = useCallback((cell: HTMLTableCellElement) => (
    selectionClipboardText !== null && isSelectedCell(cell)
      ? { text: selectionClipboardText, summary: '可貼入 Excel／試算表' }
      : null
  ), [isSelectedCell, selectionClipboardText]);
  const cellMenu = useCellContextMenu({
    columns: snapshot || preloadedPeriods ? columnHeaderColumns : COMPONENT_WEEKLY_COLUMNS,
    columnFilters,
    onSetFilter: onSetColumnFilter ?? (() => {}),
    onRemoveFilter: onRemoveColumnFilter ?? (() => {}),
    sortFields,
    onAddSort,
    onRemoveSort,
    onToggleColumn,
    onFreezeToColumn,
    canFreezeColumn: (columnId) => COMPONENT_WEEKLY_FREEZABLE_COLUMN_IDS.includes(columnId),
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
    setUsageDetailTarget(null);
  }, [active, clearSelection, closeCellMenu, setDragging]);

  const pin = useCallback((groupIndex: number) => groupIndex < frozenCount, [frozenCount]);
  const pinStyle = useCallback(
    (groupIndex: number, width: number, zIndex: number) => (
      pin(groupIndex)
        ? {
            position: 'sticky' as const,
            left: cumLefts[groupIndex],
            zIndex,
            minWidth: width,
            maxWidth: width,
          }
        : { minWidth: width }
    ),
    [cumLefts, pin],
  );
  const pinBg = useCallback(
    (groupIndex: number, rowIndex: number, defaultBg = '') => (
      pin(groupIndex)
        ? (defaultBg || (rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50'))
        : defaultBg
    ),
    [pin],
  );

  // Export handler — fetches ALL filtered items + their periods
  const handleExport = useCallback(async (format: ExportFormat) => {
    setExporting(true);
    try {
      const allItems = !snapshot && fetchAllForExport ? await fetchAllForExport() : items;

      let allPeriodsMap = periodsMap;
      if (!snapshot && fetchAllForExport) {
        const result = await loadComponentWeeklyPeriods(allItems);
        if (result.failures.length > 0) {
          setPeriodFailures(result.failures);
          return;
        }
        allPeriodsMap = result.periods;
      }

      const headerRow1: (string | null)[] = [];
      const headerRow2: string[] = [];

      for (const col of FROZEN_COLS) { headerRow1.push(headerRow1.some(h => h === 'Material') ? null : 'Material'); headerRow2.push(col.label); }
      for (const col of STOCK_COLS) { headerRow1.push(headerRow1.filter(h => h === 'Inventory').length ? null : 'Inventory'); headerRow2.push(col.label); }
      for (const col of ANALYTICS_COLS) { headerRow1.push(headerRow1.filter(h => h === 'Analytics').length ? null : 'Analytics'); headerRow2.push(col.label); }
      for (const col of STATUS_COLS) { headerRow1.push(headerRow1.filter(h => h === 'Status').length ? null : 'Status'); headerRow2.push(col.label); }

      for (const g of PERIOD_GROUPS) {
        labels.forEach((label, i) => {
          headerRow1.push(i === 0 ? g.label : null);
          headerRow2.push(label);
        });
      }

      const dataRows = allItems.map((item) => {
        const row: (string | number | null)[] = [];
        for (const col of FROZEN_COLS) row.push(item[col.key as keyof ComponentWeeklyItem] as string | number | null ?? null);
        for (const col of STOCK_COLS) row.push(snapshot && item[col.key as keyof ComponentWeeklyItem] == null ? null : Number(item[col.key as keyof ComponentWeeklyItem]) || 0);
        for (const col of ANALYTICS_COLS) {
          row.push(snapshot ? item[col.key as keyof ComponentWeeklyItem] as number | null : col.key === 'purchaseLeadWeeks'
            ? formatComponentWeeklyLeadTime(item)
            : Number(item[col.key as keyof ComponentWeeklyItem]) || 0);
        }

        const shortage = presentComponentWeeklyShortage(item);
        const purchase = presentComponentWeeklyPurchaseAction(item);
        row.push(snapshot ? (item.shortageStartWeek == null ? '期間內無缺料' : `W${item.shortageStartWeek}`) : shortage.detail ? `${shortage.label}／${shortage.detail}` : shortage.label);
        row.push(snapshot ? item.weeksUntilOrder ?? null : purchase.detail ? `${purchase.label}／${purchase.detail}` : purchase.label);

        const periods = allPeriodsMap[componentWeeklyRowKey(item)] || [];
        const padded = Array.from({ length: numWeeks }, (_, i) => periods[i] || null);

        for (const g of PERIOD_GROUPS) {
          for (const p of padded) {
            row.push(snapshot && (!p || p[g.key as keyof PeriodDetail] == null || (g.key === 'remainingStock' && p.weekIndex === 0)) ? null : p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0);
          }
        }
        return row;
      });

      exportToFile({
        filename: snapshot ? `Component_Weekly_${mrpType}_${snapshot.label}_本頁` : `Component_Weekly_${mrpType}_${new Date().toISOString().split('T')[0]}`,
        sheetName: `CW ${mrpType}`,
        headers: [headerRow1, headerRow2],
        data: dataRows,
        format,
      });
    } finally {
      setExporting(false);
    }
  }, [items, periodsMap, numWeeks, labels, mrpType, fetchAllForExport, snapshot]);

  const tableZoom = TEXT_ZOOM_LEVELS[textSize] || 1;
  const virtualRows = useVirtualTableRows({
    count: items.length,
    rowHeight: 41 * tableZoom,
    overscan: 6,
    geometryKey: `${mrpType}:${textSize}`,
    resetKey: `${mrpType}:${items[0]?.id ?? 0}:${items.at(-1)?.id ?? 0}:${items.length}`,
  });
  const rowRenderVersion = useMemo(() => ({
    failedPeriodRowKeys,
    groupOffsets,
    labels,
    numWeeks,
    openPurchaseActionDetail,
    openUsageDetail,
    snapshot,
    periodsMap,
    pinBg,
    pinStyle,
    selectionPrePeriodCols,
    toggleHighlight,
    visibleAnalyticsCols,
    visibleFrozenCols,
    visibleStatusCols,
    visibleStockCols,
  }), [
    failedPeriodRowKeys,
    groupOffsets,
    labels,
    numWeeks,
    openPurchaseActionDetail,
    openUsageDetail,
    snapshot,
    periodsMap,
    pinBg,
    pinStyle,
    selectionPrePeriodCols,
    toggleHighlight,
    visibleAnalyticsCols,
    visibleFrozenCols,
    visibleStatusCols,
    visibleStockCols,
  ]);
  const bodyColSpan = 2
    + visibleFrozenCols.length
    + visibleStockCols.length
    + visibleAnalyticsCols.length
    + PERIOD_GROUPS.length * numWeeks
    + visibleStatusCols.length;

  if (loading && Object.keys(periodsMap).length === 0) {
    return <Loader />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex min-h-7 items-center gap-2 px-2 py-1 bg-slate-50 border border-slate-300 rounded-t-md text-[10px] flex-wrap">
        <div className="flex shrink-0 items-center gap-1.5" aria-label="圖例">
          <span className="font-semibold text-slate-500">圖例</span>
          {PERIOD_GROUPS.map((group) => (
            <span
              key={group.key}
              className={`inline-flex h-5 items-center rounded-sm px-1.5 font-semibold ${group.headerBg}`}
            >
              {group.label}
            </span>
          ))}
        </div>
        {highlightedRowIds.size > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-slate-600 border-l border-slate-300 pl-2">
            <span className="inline-block w-3 h-3 rounded-sm bg-indigo-200 border border-indigo-500" />
            <span>標記 {highlightedRowIds.size} 列</span>
            <button
              type="button"
              onClick={clearHighlight}
              className="px-1.5 py-0.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-100 text-[10px]"
            >
              清除標記
            </button>
          </span>
        )}
        {periodFailures.length > 0 && (
          <span
            role="status"
            className="flex min-w-0 items-center gap-1.5 border-l border-amber-300 pl-2 text-[11px] text-amber-800"
            title={`${failedPeriodScopeLabels.join('、')}：週期資料讀取失敗，未以 0 代替`}
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="truncate">{periodFailures.length} 個來源週期資料無法讀取</span>
            <button
              type="button"
              onClick={() => setPeriodRetry((value) => value + 1)}
              disabled={loading}
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-amber-300 bg-white px-1.5 font-medium hover:bg-amber-50 disabled:cursor-wait disabled:opacity-60"
              title="重新讀取失敗來源"
            >
              <RotateCw size={11} className={loading ? 'animate-spin' : ''} />
              重試
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
        stats={active ? selectionStats : null}
        isSelecting={dragging}
        onClear={clearSelection}
      />
      <PinnedRowsBar
        items={pinnedItems}
        onUnpin={unpinRow}
        onClearAll={clearPins}
        renderItem={(item) => (
          <>
            <span className="font-mono font-semibold text-slate-800">{item.materialPartNo}</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-600">{item.unit || '—'}</span>
            <span className="text-slate-300">|</span>
            <span className="font-mono text-slate-600">平均 {Number(item.avgWeeklyUsage).toLocaleString()}</span>
          </>
        )}
      />
      <div
        ref={virtualRows.containerRef}
        onScroll={virtualRows.onScroll}
        data-mrp-scroll
        className="flex-1 min-h-0 overflow-auto border border-slate-300 border-t-0 rounded-b-md bg-white"
      >
      {highlightCss && <style>{highlightCss}</style>}
      {selectionCss && <style>{selectionCss}</style>}
      <table
        ref={tableRef}
        tabIndex={-1}
        className={`component-weekly-trad-table mrp-trad-table text-xs border-separate border-spacing-0 trad-sep-table ${dragging ? 'select-none' : ''}`}
        style={{ zoom: tableZoom }}
        onMouseDown={handleTableMouseDown}
        onMouseOver={handleTableMouseOver}
        onMouseMove={handleTableMouseMove}
        onContextMenu={cellMenu.handleContextMenu}
        onCopy={cellMenu.handleCopy}
      >
        {/* ===== HEADER ===== */}
        <thead className="sticky top-0 z-30">
          {/* Row 1: Group headers */}
          <tr className="border-b border-slate-300">
            <th
              rowSpan={2}
              className="bg-slate-200 border-r border-slate-300"
              style={{ position: 'sticky', left: 0, zIndex: 50, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
              aria-label="標記"
            />
            <th
              rowSpan={2}
              className="bg-slate-200 border-r border-slate-300 text-center text-[10px] font-semibold text-slate-600"
              style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, zIndex: 50, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
            >
              詳細
            </th>
            {row1Groups.map((grp) => {
              const endIdx = grp.startIdx + grp.cols.length;
              const groupFullyFrozen = endIdx <= frozenCount;

              if (grp.individual) {
                // Render individual cells (for the Material group)
                return grp.cols.map((col, i) => {
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
                  key={grp.label}
                  colSpan={grp.cols.length}
                  className={`${grp.headerBg} text-center text-[10px] border-r border-slate-400 px-1`}
                  style={groupFullyFrozen ? { position: 'sticky', left: cumLefts[grp.startIdx], zIndex: 40 } : undefined}
                >
                  {grp.label}
                </th>
              );
            })}

            {/* Status group */}
            {visibleStatusCols.length > 0 && (
              <th
                colSpan={visibleStatusCols.length}
                className="bg-slate-200 text-center text-[10px] text-slate-600 px-1"
              >
                Status
              </th>
            )}

            {/* Period groups */}
            {PERIOD_GROUPS.map((g) => (
              <th
                key={g.key}
                colSpan={numWeeks}
                className={`${g.headerBg} text-center text-[10px] font-bold px-1 border-r border-slate-400`}
              >
                {g.label}
              </th>
            ))}
          </tr>

          {/* Row 2: Column headers */}
          <tr className="border-b-2 border-slate-400 bg-slate-100">
            {/* Material columns */}
            {visibleFrozenCols.map((col, i) => {
              const gi = groupOffsets.frozen + i;
              return (
                <th
                  key={col.key}
                  className={`bg-slate-100 px-1.5 py-1.5 text-left font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]`}
                  style={pinStyle(gi, col.width, 40)}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(col.key)!}
                    controller={columnHeaderController}
                    label={col.label}
                    labelClassName="text-left"
                  />
                </th>
              );
            })}

            {/* Stock columns */}
            {visibleStockCols.map((col, i) => {
              const gi = groupOffsets.stock + i;
              return (
                <th
                  key={col.key}
                  className={`bg-slate-100 px-1.5 py-1.5 text-right font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]`}
                  style={pinStyle(gi, col.width, 40)}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(col.key)!}
                    controller={columnHeaderController}
                    label={col.label}
                    labelClassName="text-right"
                  />
                </th>
              );
            })}

            {/* Analytics columns */}
            {visibleAnalyticsCols.map((col, i) => {
              const gi = groupOffsets.analytics + i;
              return (
                <th
                  key={col.key}
                  className={`bg-slate-100 px-1.5 py-1.5 text-right font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]`}
                  style={pinStyle(gi, col.width, 40)}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(col.key)!}
                    controller={columnHeaderController}
                    label={col.label}
                    labelClassName="text-right"
                  />
                </th>
              );
            })}

            {/* Status columns */}
            {visibleStatusCols.map((col) => (
              <th
                key={col.key}
                className="bg-slate-100 px-1.5 py-1.5 text-center font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]"
                style={{ minWidth: col.width }}
              >
                <ColumnHeaderButton
                  column={columnHeaderById.get(col.key)!}
                  controller={columnHeaderController}
                  label={col.label}
                  labelClassName="text-center"
                />
              </th>
            ))}

            {/* Period group columns */}
            {PERIOD_GROUPS.map((g) =>
              labels.map((label, wi) => (
                <th
                  key={`${g.key}-${wi}`}
                  className={`${g.headerBg} px-1 py-1.5 text-center font-medium whitespace-nowrap text-[10px] ${
                    wi === numWeeks - 1 ? 'border-r border-slate-400' : 'border-r border-slate-200'
                  }`}
                  style={{ minWidth: PERIOD_COL_WIDTH }}
                >
                  {label}
                </th>
              )),
            )}
          </tr>
        </thead>

        {/* ===== BODY ===== */}
        <HighlightedRowsContext.Provider value={highlightedRowIds}>
        <tbody>
          <VirtualTableSpacer height={virtualRows.topSpacerHeight} colSpan={bodyColSpan} zoom={tableZoom} />
          <MemoizedComponentWeeklyRows
            items={items}
            start={virtualRows.start}
            end={virtualRows.end}
            renderVersion={rowRenderVersion}
            renderRow={(item, rowIdx) => {
            const rowKey = componentWeeklyRowKey(item);
            const periodsUnavailable = failedPeriodRowKeys.has(rowKey);
            const periods = periodsMap[rowKey] || [];
            const paddedPeriods: (PeriodDetail | null)[] = Array.from(
              { length: numWeeks },
              (_, i) => periods[i] || null,
            );

            return (
              <tr
                key={rowKey}
                data-virtual-row
                data-row-id={item.id}
                data-row-key={rowKey}
                className={`border-b border-slate-100 hover:bg-blue-50/30 ${
                  rowIdx % 2 === 0 ? '' : 'bg-slate-50/50'
                }`}
              >
                <td
                  className={`${rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50'} border-r border-slate-200 text-center relative`}
                  style={{ position: 'sticky', left: 0, zIndex: 12, width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH }}
                >
                  <ComponentWeeklyHighlightToggle
                    rowKey={rowKey}
                    materialPartNo={item.materialPartNo}
                    onToggle={toggleHighlight}
                  />
                </td>
                <td
                  className={`${rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50'} border-r border-slate-200 text-center`}
                  style={{ position: 'sticky', left: CHECKBOX_COL_WIDTH, zIndex: 12, width: DETAIL_COL_WIDTH, minWidth: DETAIL_COL_WIDTH }}
                >
                  <button
                    type="button"
                    className="rounded border border-blue-300 bg-white px-1 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      openUsageDetail(item, {
                        initialTab: 'work-orders',
                        focusMetric: 'plannedUsage',
                      });
                    }}
                    aria-label={snapshot ? `查看 ${item.materialPartNo} 封存來源` : `查看 ${item.materialPartNo} 全部週期工令用料明細`}
                  >
                    詳細
                  </button>
                </td>

                {/* Material columns */}
                {visibleFrozenCols.map((col, i) => {
                  const gi = groupOffsets.frozen + i;
                  const val = item[col.key as keyof ComponentWeeklyItem];
                  const isMaterial = col.key === 'materialPartNo';
                  return (
                    <td
                      key={col.key}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-col={col.key}
                      data-value={val != null ? String(val) : ''}
                      className={`px-1.5 py-1 whitespace-nowrap border-r border-slate-100 ${
                        pinBg(gi, rowIdx, rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50')
                      } ${isMaterial ? 'font-mono text-[10px] font-medium' : 'text-center'} cursor-cell`}
                      style={pinStyle(gi, col.width, 10)}
                      title={String(val || '')}
                    >
                      <div className="truncate" style={{ maxWidth: col.width - 12 }}>
                        {val != null ? String(val) : '—'}
                      </div>
                    </td>
                  );
                })}

                {/* Stock columns */}
                {visibleStockCols.map((col, i) => {
                  const gi = groupOffsets.stock + i;
                  if (snapshot) {
                    const value = item[col.key as keyof ComponentWeeklyItem];
                    return <td key={col.key} data-selr={rowIdx} data-selc={gi} data-col={col.key} data-value={value == null ? '' : String(value)} className={`border-r border-slate-100 px-1.5 py-1 text-right font-mono ${pinBg(gi, rowIdx)}`} style={pinStyle(gi, col.width, 10)}>{value == null ? '—' : numCell(Number(value), col.key.endsWith('Kg') ? 2 : 0)}</td>;
                  }
                  const val = Number(item[col.key as keyof ComponentWeeklyItem]) || 0;
                  const isKg = col.key.endsWith('Kg');
                  return (
                    <td
                      key={col.key}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-col={col.key}
                      data-value={String(val)}
                      className={`px-1.5 py-1 text-center border-r border-slate-100 cursor-cell ${pinBg(gi, rowIdx)}`}
                      style={pinStyle(gi, col.width, 10)}
                    >
                      <button
                        type="button"
                        className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            (event.detail > 0 && detailDragRef.current)
                            || event.ctrlKey
                            || event.metaKey
                            || event.shiftKey
                          ) return;
                          openUsageDetail(item, {
                            initialTab: 'inventory',
                            focusMetric: col.key.startsWith('bad') ? 'badStock' : 'initialStock',
                          });
                        }}
                        title={col.key.startsWith('bad') ? '查看不良庫存批號' : '查看良品庫存批號'}
                      >
                        {numCell(val, isKg ? 2 : 0)}
                      </button>
                    </td>
                  );
                })}

                {/* Analytics columns */}
                {visibleAnalyticsCols.map((col, i) => {
                  const gi = groupOffsets.analytics + i;
                  if (snapshot) {
                    const value = item[col.key as keyof ComponentWeeklyItem];
                    return <td key={col.key} data-selr={rowIdx} data-selc={gi} data-col={col.key} data-value={value == null ? '' : String(value)} className={`border-r border-slate-100 px-1.5 py-1 text-right font-mono ${pinBg(gi, rowIdx)}`} style={pinStyle(gi, col.width, 10)}>{value == null ? '—' : numCell(Number(value), 1)}</td>;
                  }
                  const val = Number(item[col.key as keyof ComponentWeeklyItem]) || 0;
                  return (
                    <td
                      key={col.key}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-col={col.key}
                      data-value={col.key === 'purchaseLeadWeeks' && item.purchaseLeadWeeksConfigured === false ? '' : String(val)}
                      className={`px-1.5 py-1 ${col.key === 'purchaseLeadWeeks' ? 'text-center' : 'text-right font-mono'} border-r border-slate-100 cursor-cell ${pinBg(gi, rowIdx)}`}
                      style={pinStyle(gi, col.width, 10)}
                    >
                      {col.key === 'purchaseLeadWeeks' ? (
                        <ComponentWeeklyLeadTimeButton
                          summary={item}
                          compact
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              (event.detail > 0 && detailDragRef.current)
                              || event.ctrlKey
                              || event.metaKey
                              || event.shiftKey
                            ) return;
                            openUsageDetail(item, {
                              initialTab: 'calculation',
                              focusMetric: 'purchaseLeadWeeks',
                            });
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="w-full text-right underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              (event.detail > 0 && detailDragRef.current)
                              || event.ctrlKey
                              || event.metaKey
                              || event.shiftKey
                            ) return;
                            openUsageDetail(item, {
                              initialTab: 'calculation',
                              focusMetric: col.key as ComponentWeeklyUsageMetric,
                            });
                          }}
                          title={`查看${col.label}計算來源`}
                        >
                          {numCell(val, 1)}
                        </button>
                      )}
                    </td>
                  );
                })}

                {visibleStatusCols.map((column, statusIndex) => {
                  const selectionColumn = groupOffsets.status + statusIndex;
                  if (snapshot) {
                    const value = item[column.key as keyof ComponentWeeklyItem];
                    const missing = snapshot.missingFields.includes(column.key);
                    return <td key={column.key} data-selr={rowIdx} data-selc={selectionColumn} data-col={column.key} data-value={missing || value == null ? '' : String(value)} className="border-r border-slate-100 px-1.5 py-1 text-center text-xs" style={{ minWidth: column.width }}>{missing ? '—' : column.key === 'shortageStartWeek' ? value == null ? <span className="bg-green-50 text-green-700">期間內無缺料</span> : <span className="bg-red-50 text-red-700">W{String(value)}</span> : value == null ? '—' : `${value} 週`}</td>;
                  }
                  if (column.key === 'shortageStartWeek') {
                    return (
                      <td
                        key={column.key}
                        data-selr={rowIdx}
                        data-selc={selectionColumn}
                        data-col={column.key}
                        data-value={item.shortageStartWeek != null ? String(item.shortageStartWeek) : ''}
                        className="px-1.5 py-1 text-center border-r border-slate-100 cursor-cell"
                        style={{ minWidth: column.width }}
                      >
                        <ComponentWeeklyShortageButton
                          summary={item}
                          compact
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              (event.detail > 0 && detailDragRef.current)
                              || event.ctrlKey
                              || event.metaKey
                              || event.shiftKey
                            ) return;
                            openUsageDetail(item, {
                              weekIndex: item.shortageStartWeek,
                              weekLabel: item.shortageStartWeek === 0
                                ? '前期'
                                : item.shortageStartWeek === null
                                  ? '全部週期'
                                  : `W${item.shortageStartWeek}`,
                              initialTab: 'calculation',
                              focusMetric: 'shortageStartWeek',
                            });
                          }}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={column.key}
                      data-selr={rowIdx}
                      data-selc={selectionColumn}
                      data-col={column.key}
                      data-value={item.weeksUntilOrder != null ? String(item.weeksUntilOrder) : ''}
                      className="px-1.5 py-1 text-center border-r border-slate-100 cursor-cell"
                      style={{ minWidth: column.width }}
                    >
                      <ComponentWeeklyPurchaseActionButton
                        summary={item}
                        compact
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            (event.detail > 0 && detailDragRef.current)
                            || event.ctrlKey
                            || event.metaKey
                            || event.shiftKey
                          ) return;
                          openPurchaseActionDetail(item);
                        }}
                      />
                    </td>
                  );
                })}

                {/* Period group cells */}
                {PERIOD_GROUPS.map((g, groupIndex) =>
                  paddedPeriods.map((p, wi) => {
                    if (snapshot) {
                      const value = p?.[g.key as keyof PeriodDetail];
                      const prior = g.key === 'remainingStock' && wi === 0;
                      return <td key={`${g.key}-${wi}`} data-selr={rowIdx} data-selc={selectionPrePeriodCols.length + groupIndex * numWeeks + wi} data-period-key={g.key} data-week-index={wi} data-value={prior || value == null ? '' : String(value)} className={`border-r border-slate-100 px-1 py-1 text-right font-mono cursor-cell ${value != null && Number(value) < 0 && g.key === 'remainingStock' ? 'bg-red-100 text-red-800 font-bold' : g.cellBg}`} style={{ minWidth: PERIOD_COL_WIDTH }}>{prior ? '' : value == null ? '—' : numCell(Number(value), 1)}</td>;
                    }
                    const val = p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0;
                    const isNeg = val < 0;
                    const isStockGroup = g.key === 'remainingStock';
                    const isPriorRemaining = isStockGroup && wi === 0;
                    const canOpenDetail = !!p && !isPriorRemaining;
                    const detailTab: ComponentWeeklyUsageDetailTab = g.key === 'remainingStock'
                      ? 'calculation'
                      : g.key === 'receipts'
                        ? 'supply'
                        : 'work-orders';
                    const detailMetric = g.key as ComponentWeeklyUsageMetric;
                    return (
                      <td
                        key={`${g.key}-${wi}`}
                        data-selr={rowIdx}
                        data-selc={selectionPrePeriodCols.length + groupIndex * numWeeks + wi}
                        data-period-key={g.key}
                        data-period-label={`${g.label} ${p?.weekLabel || labels[wi] || `W${wi}`}`}
                        data-value={String(val)}
                        className={`px-1 py-1 text-right font-mono ${
                          periodsUnavailable
                            ? 'bg-amber-50 text-amber-700'
                            : isPriorRemaining
                            ? 'bg-slate-50'
                            : isStockGroup && isNeg
                            ? 'bg-red-100 text-red-800 font-bold'
                            : g.cellBg
                        } ${
                          wi === numWeeks - 1 ? 'border-r border-slate-300' : 'border-r border-slate-100'
                        } cursor-cell`}
                        style={{ minWidth: PERIOD_COL_WIDTH }}
                      >
                        {periodsUnavailable ? (
                          <span title="此來源週期資料讀取失敗">—</span>
                        ) : isPriorRemaining ? '' : canOpenDetail ? (
                          <button
                            type="button"
                            className={`font-mono underline decoration-current decoration-dotted underline-offset-2 hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${
                              val === 0 ? 'text-slate-300' : ''
                            }`}
                            title={`查看${g.label}來源明細`}
                            aria-label={`查看 ${item.materialPartNo} ${p.weekLabel || `W${p.weekIndex}`} ${g.label}來源明細`}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (
                                (event.detail > 0 && detailDragRef.current)
                                || event.ctrlKey
                                || event.metaKey
                                || event.shiftKey
                              ) return;
                              openUsageDetail(item, {
                                weekIndex: p.weekIndex,
                                weekLabel: p.weekLabel || `W${p.weekIndex}`,
                                initialTab: detailTab,
                                focusMetric: detailMetric,
                              });
                            }}
                          >
                            {val.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                          </button>
                        ) : val === 0 ? (
                          <span className="text-slate-300">0</span>
                        ) : (
                          val.toLocaleString(undefined, { maximumFractionDigits: 1 })
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
            );
            }}
          />
          <VirtualTableSpacer height={virtualRows.bottomSpacerHeight} colSpan={bodyColSpan} zoom={tableZoom} />
        </tbody>
        </HighlightedRowsContext.Provider>
      </table>
      </div>
      {active && <CellContextMenu {...cellMenu.contextMenuProps} />}
      {usageDetailTarget && (
        <ComponentWeeklyUsageDrawer
          target={usageDetailTarget}
          onClose={() => setUsageDetailTarget(null)}
        />
      )}
    </div>
  );
}
