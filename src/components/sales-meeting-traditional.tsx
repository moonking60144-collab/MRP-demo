'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { TEXT_ZOOM_LEVELS } from './ui/text-size-control';
import { Loader } from './ui/loader';
import { cachePeek, cacheSet, cacheIsFresh } from '@/lib/swr-cache';
import { exportToFile, type ExportFormat } from '@/lib/export-utils';
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
import { SALES_MEETING_COLUMNS, SALES_MEETING_PERIOD_VISIBILITY_IDS } from './data-table/column-defs/sales-meeting-columns';
import { PinnedRowsBar, usePinnedRows } from './data-table/ui/pinned-rows-bar';
import {
  WarehouseStockValue,
  type WarehouseStockRequest,
} from './warehouse-stock-detail';
import type {
  SalesMeetingItem,
  SalesMeetingPeriodDetail as PeriodDetail,
  SalesMeetingSourceTarget,
  SalesMeetingSummaryKey,
} from '@/lib/mrp/sales-meeting-types';
import { salesMeetingSummarySource } from '@/lib/mrp/sales-meeting-summary-source';
import { SalesMeetingSourceValue } from './sales-meeting-source-value';
import {
  VirtualTableSpacer,
  useVirtualTableRowNodes,
  useVirtualTableRows,
} from './ui/virtual-table-rows';
import { salesMeetingPeriodsCacheKey } from '@/lib/mrp/list-periods-contract';
import { loadSalesMeetingPeriods } from '@/lib/mrp/sales-meeting-period-client';
import { useToast } from './toast';
import { useRafCellFocus } from './ui/use-raf-cell-focus';
import { FloatingSelectionSummary } from './ui/floating-selection-summary';

// ============================================================
// Types (matching sales-meeting.tsx)
// ============================================================
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

const MemoizedSalesMeetingRows = memo(function MemoizedSalesMeetingRows({
  end,
  items,
  renderRow,
  renderVersion,
  start,
}: {
  end: number;
  items: SalesMeetingItem[];
  renderRow: (item: SalesMeetingItem, localRowIndex: number) => ReactNode;
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

const STATUS_STYLES: Record<string, string> = {
  '足夠': 'bg-green-100 text-green-800',
  '不足': 'bg-red-100 text-red-800',
  '無訂單': 'bg-slate-100 text-slate-500',
};

// ============================================================
// Column definitions — matching Ragic Form 36 layout
// ============================================================
const FROZEN_COLS = [
  { key: 'customerCode', label: '客戶代碼', width: 70 },
  { key: 'customerPartNo', label: '客戶料號', width: 160 },
  { key: 'partVersion', label: '客戶料號版本（追溯）', width: 180 },
];

function itemColumnValue(item: SalesMeetingItem, key: string): unknown {
  return key === 'partVersion'
    ? item.memberPartVersions.join('、')
    : item[key as keyof SalesMeetingItem];
}

// Static columns matching Ragic order
const INFO_COLS: Array<{
  key: string;
  label: string;
  width: number;
  headerBg?: string;
  cellBg?: string;
  align?: 'left' | 'right' | 'center';
  type?: 'number' | 'status' | 'shortage-badge' | 'text' | 'warehouse' | 'anomaly';
  source?: SalesMeetingSummaryKey;
  decimals?: number;
  negative?: boolean;
}> = [
  // Ragic 對照碼與公式保留在 column description，不占用表頭。
  { key: 'erpPartNo', label: 'ERP料號', width: 192, align: 'left', type: 'text' },
  { key: 'goodStockPc', label: '良品\n庫存pc', width: 70, headerBg: 'bg-slate-100', align: 'right', type: 'number' },
  { key: 'wfgStockPc', label: '廠內HD\n庫存pc', width: 78, headerBg: 'bg-sky-100', cellBg: 'bg-sky-50', align: 'right', type: 'warehouse' },
  { key: 'ye1StockPc', label: 'YE1\n庫存pc', width: 72, headerBg: 'bg-sky-100', cellBg: 'bg-sky-50', align: 'right', type: 'warehouse' },
  { key: 'inventoryAnomalyCount', label: '庫存\n檢核', width: 68, headerBg: 'bg-amber-100', align: 'center', type: 'anomaly' },
  { key: 'badStockPc', label: '不良品\n庫存pc', width: 70, align: 'right', type: 'number' },
  { key: 'stockWeeks', label: '可支應\n週數', width: 75, align: 'right', type: 'number', decimals: 1 },
  { key: 'avgDemandPerWeek', label: '平均需求\npc／週', width: 85, align: 'right', type: 'number', decimals: 2 },
  { key: 'shortageStartWeek', label: '預計\n缺貨週', width: 80, headerBg: 'bg-yellow-200', align: 'center', type: 'shortage-badge' },
  { key: 'outstanding04', label: '近期訂單量\n前期＋4週', width: 100, headerBg: 'bg-green-200', cellBg: 'bg-green-50', align: 'right', type: 'number', source: 'outstanding04' },
  { key: 'fgDiff04', label: '近期餘缺\n不含計畫', width: 100, headerBg: 'bg-blue-200', cellBg: 'bg-blue-50', align: 'right', type: 'number', negative: true, source: 'fgDiff04' },
  { key: 'fgStatus04', label: '近期\n供需狀態', width: 90, headerBg: 'bg-slate-100', align: 'center', type: 'status' },
  { key: 'totalOrderDemand', label: '未出貨\n訂單總量', width: 110, headerBg: 'bg-indigo-800 text-white', cellBg: 'bg-indigo-50', align: 'right', type: 'number', source: 'totalOrderDemand' },
  { key: 'totalFgDiff', label: '總訂單餘缺\n不含計畫', width: 110, headerBg: 'bg-teal-600 text-white', cellBg: 'bg-teal-50', align: 'right', type: 'number', negative: true, source: 'totalFgDiff' },
];

// Period column groups
const PERIOD_GROUPS = [
  { key: 'demand', visibilityId: SALES_MEETING_PERIOD_VISIBILITY_IDS.demand, label: '訂單需求', headerBg: 'bg-orange-500 text-white', cellBg: 'bg-orange-50', borderColor: 'border-orange-300' },
  { key: 'supply', visibilityId: SALES_MEETING_PERIOD_VISIBILITY_IDS.supply, label: '生產計畫', headerBg: 'bg-green-500 text-white', cellBg: 'bg-green-50', borderColor: 'border-green-300' },
  { key: 'remainingStock', visibilityId: SALES_MEETING_PERIOD_VISIBILITY_IDS.remainingStock, label: '剩餘庫存', headerBg: 'bg-emerald-800 text-white', cellBg: 'bg-emerald-50', borderColor: 'border-emerald-300' },
];

const PERIOD_COL_WIDTH = 60;

export const SALES_MEETING_FREEZABLE_COLUMN_IDS = [
  ...FROZEN_COLS,
  ...INFO_COLS,
].map((column) => column.key);

export const SM_DEFAULT_FROZEN = 2;
export const SM_MAX_FROZEN = SALES_MEETING_FREEZABLE_COLUMN_IDS.length;

const SALES_MEETING_COLUMN_ID_SET = new Set(SALES_MEETING_COLUMNS.map((column) => column.id));

// ============================================================
// Traditional View Component
// ============================================================
export function SalesMeetingTraditionalView({
  items,
  active = true,
  textSize = 0,
  frozenCount = SM_DEFAULT_FROZEN,
  fetchAllForExport,
  onOpenSource,
  onOpenWarehouse,
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
  onInspect,
}: {
  items: SalesMeetingItem[];
  active?: boolean;
  textSize?: number;
  frozenCount?: number;
  fetchAllForExport?: () => Promise<SalesMeetingItem[]>;
  onOpenSource: (target: SalesMeetingSourceTarget) => void;
  onOpenWarehouse: (
    item: SalesMeetingItem,
    warehouseGroup: WarehouseStockRequest['warehouseGroup'],
    initialFilter?: WarehouseStockRequest['initialFilter'],
  ) => void;
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
  onInspect?: (item: SalesMeetingItem) => void;
}) {
  const showToast = useToast();
  const columnHeaderById = useMemo(
    () => new Map(columnHeaderColumns.map((column) => [column.id, column])),
    [columnHeaderColumns],
  );
  const [livePeriodsMap, setPeriodsMap] = useState<Record<string, PeriodDetail[]>>({});
  const periodsMap = snapshot?.periods ?? livePeriodsMap;
  const [loading, setLoading] = useState(false);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selRects, setSelRects] = useState<BoxSelRect[]>([]);
  const [draftAnchorState, setDraftAnchorState] = useState<Cell | null>(null);
  const [draftFocusState, setDraftFocusState] = useState<Cell | null>(null);
  const [draggingState, setDraggingState] = useState(false);
  const draftAnchorRef = useRef<Cell | null>(null);
  const draftFocusRef = useRef<Cell | null>(null);
  const draggingRef = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const isVisible = useCallback(
    (columnId: string) => columnVisibility[columnId] !== false,
    [columnVisibility],
  );
  const visibleFrozenCols = useMemo(() => FROZEN_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const visibleInfoCols = useMemo(() => INFO_COLS.filter((column) => isVisible(column.key)), [isVisible]);
  const visiblePeriodGroups = useMemo(() => PERIOD_GROUPS.filter(group => isVisible(group.visibilityId)), [isVisible]);
  const selectionPrePeriodCols = useMemo(() => [
    ...visibleFrozenCols.map((column) => ({ key: column.key, filterType: 'text' as const })),
    ...visibleInfoCols.map((column) => ({
      key: column.key,
      filterType: ['number', 'warehouse'].includes(column.type || '') ? 'numeric' as const : 'text' as const,
    })),
  ], [visibleFrozenCols, visibleInfoCols]);
  const infoOffset = visibleFrozenCols.length;
  const cumLefts = useMemo(() => {
    const lefts: number[] = [];
    let left = 0;
    for (const column of [...visibleFrozenCols, ...visibleInfoCols]) {
      lefts.push(left);
      left += column.width;
    }
    return lefts;
  }, [visibleFrozenCols, visibleInfoCols]);
  const { pinnedItems, pinRow, unpinRow, clearPins } = usePinnedRows(items);
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

  const periodsKey = snapshot ? null : salesMeetingPeriodsCacheKey(items);
  // 切頁回來時 paint 前先鋪上快取的格資料 → 傳統 view 零 spinner
  useLayoutEffect(() => {
    if (snapshot) return;
    const cached = periodsKey ? cachePeek<Record<string, PeriodDetail[]>>(periodsKey) : undefined;
    setPeriodsMap(cached ?? {});
    setPeriodError(null);
    setLoading(!cached && items.length > 0);
  }, [items.length, periodsKey, snapshot]);

  useEffect(() => {
    if (snapshot) return;
    const controller = new AbortController();
    if (items.length === 0) {
      setPeriodsMap({});
      setPeriodError(null);
      setLoading(false);
      return;
    }

    const fetchPeriods = async () => {
      const cached = periodsKey ? cachePeek<Record<string, PeriodDetail[]>>(periodsKey) : undefined;
      if (cached) {
        setPeriodsMap(cached);
        setPeriodError(null);
        setLoading(false);
        if (periodsKey && cacheIsFresh(periodsKey)) return;
      } else {
        setLoading(true);
      }
      try {
        const periods = await loadSalesMeetingPeriods<PeriodDetail>(items, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPeriodsMap(periods);
        setPeriodError(null);
        if (periodsKey) cacheSet(periodsKey, periods);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPeriodError(error instanceof Error ? error.message : '產銷週期資料讀取失敗');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchPeriods();
    return () => controller.abort();
  }, [items, periodsKey, snapshot]);

  const { labels, numWeeks } = useMemo(() => {
    const samplePeriods = Object.values(periodsMap)[0] || [];
    const weekLabels = samplePeriods.map(
      (period) => period.weekLabel || `W${String(period.weekIndex).padStart(2, '0')}`,
    );
    const resolvedNumWeeks = weekLabels.length || 14;
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

  const selectionTimelineCols = useMemo<BoxSelTimelineColumn[]>(() => (
    visiblePeriodGroups.flatMap((group) =>
      Array.from({ length: numWeeks }, (_, weekIndex) => ({
        kind: 'period' as const,
        groupKey: group.key,
        monthIndex: weekIndex,
      })),
    )
  ), [numWeeks, visiblePeriodGroups]);
  const draftRect = useMemo(
    () => (draftAnchorState && draftFocusState ? cellsToRect(draftAnchorState, draftFocusState) : null),
    [draftAnchorState, draftFocusState],
  );
  const effectiveRects = useMemo(
    () => (draftRect ? [...selRects, draftRect] : selRects),
    [selRects, draftRect],
  );
  const selectionCss = useMemo(() => buildSelectionRangeCss({
    rects: effectiveRects,
    tableSelector: '.sales-meeting-trad-table',
    firstSelectableChildIndex: 1,
  }), [effectiveRects]);
  const handleTableMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-no-selection]')) return;
    const coord = cellCoordOf(event.target);
    if (!coord) return;
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
    if (coord) scheduleDraftFocus(coord);
  }, [scheduleDraftFocus]);
  const handleTableMouseMove = useCallback((event: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const coord = cellCoordOf(document.elementFromPoint(event.clientX, event.clientY));
    if (coord) scheduleDraftFocus(coord);
  }, [scheduleDraftFocus]);

  useEffect(() => {
    clearSelection();
  }, [items, numWeeks, selectionPrePeriodCols, selectionTimelineCols, clearSelection]);
  useEffect(() => {
    if (!draggingState) return;
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
  }, [draggingState, flushDraftFocus, setDragging, setDraftAnchor, setDraftFocus]);
  useEffect(() => {
    if (effectiveRects.length === 0) return;
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', clearOnEscape);
    return () => window.removeEventListener('keydown', clearOnEscape);
  }, [effectiveRects.length, clearSelection]);
  const selectionSummary = useMemo(() => {
    if (effectiveRects.length === 0) return null;
    const args: SelectionStatsArgs = {
      rects: effectiveRects,
      prePeriodCols: selectionPrePeriodCols,
      periodGroupKeys: visiblePeriodGroups.map((group) => group.key),
      displayMonths: numWeeks,
      timelineCols: selectionTimelineCols,
      rowCount: items.length,
      getPrePeriodValue: (row, key) => {
        const item = items[row];
        return item ? itemColumnValue(item, key) : null;
      },
      getPeriodValue: (row, groupKey, weekIndex) => {
        if (groupKey === 'remainingStock' && weekIndex === 0) return null;
        const period = (periodsMap[items[row]?.partVersion || ''] || [])[weekIndex];
        return period?.[groupKey as keyof PeriodDetail] ?? null;
      },
    };
    return {
      stats: computeSelectionStats(args),
      clipboardText: draftRect ? null : buildSelectionClipboardText(args),
    };
  }, [draftRect, effectiveRects, items, periodsMap, numWeeks, selectionPrePeriodCols, selectionTimelineCols, visiblePeriodGroups]);
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
    columns: snapshot ? columnHeaderColumns : SALES_MEETING_COLUMNS,
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

      let allPeriodsMap: Record<string, PeriodDetail[]> = periodsMap;
      if (!snapshot && fetchAllForExport && allItems.length > 0) {
        allPeriodsMap = await loadSalesMeetingPeriods<PeriodDetail>(allItems);
      }

      const headerRow1: (string | null)[] = [];
      const headerRow2: string[] = [];

      for (const col of FROZEN_COLS) { headerRow1.push('Part Info'); headerRow2.push(col.label); }
      for (const col of INFO_COLS) { headerRow1.push(null); headerRow2.push(col.label.replace(/\n/g, ' ')); }

      for (const g of PERIOD_GROUPS) {
        labels.forEach((label, i) => {
          headerRow1.push(i === 0 ? g.label : null);
          headerRow2.push(label);
        });
      }

      const dataRows = allItems.map((item) => {
        const row: (string | number | null)[] = [];
        for (const col of FROZEN_COLS) row.push(itemColumnValue(item, col.key) as string | number | null ?? null);
        for (const col of INFO_COLS) {
          if (snapshot && (snapshot.missingFields.includes(col.key) || item[col.key as keyof SalesMeetingItem] == null) && col.type !== 'shortage-badge') row.push(null);
          else if (col.type === 'text') row.push(item[col.key as keyof SalesMeetingItem] as string | null ?? null);
          else if (col.type === 'status') row.push(item.fgStatus04 ?? null);
          else if (col.type === 'shortage-badge') row.push(item.shortageStartWeek !== null ? `W${item.shortageStartWeek}` : null);
          else row.push(Number(item[col.key as keyof SalesMeetingItem]) || 0);
        }

        const periods = allPeriodsMap[item.partVersion] || [];
        const padded = Array.from({ length: numWeeks }, (_, i) => periods[i] || null);

        for (const g of PERIOD_GROUPS) {
          for (const p of padded) {
            row.push(snapshot && (!p || p[g.key as keyof PeriodDetail] == null || (g.key === 'remainingStock' && p.weekIndex === 0)) ? null : p ? Number(p[g.key as keyof PeriodDetail]) || 0 : 0);
          }
        }
        return row;
      });

      exportToFile({
        filename: snapshot ? `Sales_Meeting_${snapshot.label}_本頁` : `Sales_Meeting_${new Date().toISOString().split('T')[0]}`,
        sheetName: 'Sales Meeting',
        headers: [headerRow1, headerRow2],
        data: dataRows,
        format,
      });
    } catch (error) {
      showToast({
        type: 'error',
        message: error instanceof Error ? error.message : '產銷資料匯出失敗',
      });
    } finally {
      setExporting(false);
    }
  }, [items, periodsMap, numWeeks, labels, fetchAllForExport, showToast, snapshot]);

  const tableZoom = TEXT_ZOOM_LEVELS[textSize] || 1;
  const virtualRows = useVirtualTableRows({
    count: items.length,
    rowHeight: 25 * tableZoom,
    overscan: 6,
    geometryKey: textSize,
    resetKey: `${items[0]?.id ?? 0}:${items.at(-1)?.id ?? 0}:${items.length}`,
  });
  const rowRenderVersion = useMemo(() => ({
    infoOffset,
    labels,
    numWeeks,
    onOpenSource,
    onInspect,
    onOpenWarehouse,
    periodsMap,
    snapshot,
    pinBg,
    pinStyle,
    selectionPrePeriodCols,
    visibleFrozenCols,
    visibleInfoCols,
    visiblePeriodGroups,
  }), [
    infoOffset,
    labels,
    numWeeks,
    onOpenSource,
    onInspect,
    onOpenWarehouse,
    periodsMap,
    snapshot,
    pinBg,
    pinStyle,
    selectionPrePeriodCols,
    visibleFrozenCols,
    visibleInfoCols,
    visiblePeriodGroups,
  ]);
  const bodyColSpan = Math.max(1, visibleFrozenCols.length
    + visibleInfoCols.length
    + visiblePeriodGroups.length * numWeeks);

  if (loading && Object.keys(periodsMap).length === 0) {
    return <Loader />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Legend + export buttons — fixed above table */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-t-lg text-[10px] flex-wrap">
        <span className="font-semibold text-slate-500">Legend:</span>
        {visiblePeriodGroups.map((g) => (
          <span key={g.key} className={`${g.headerBg} px-1.5 py-0.5 rounded`}>
            {g.label}
          </span>
        ))}
        <span
          className="px-1.5 py-0.5 border border-sky-300 bg-sky-50 text-sky-800 rounded"
          title="同一 ERP 料號的實體庫存與生產計畫只計一次，剩餘庫存依週別、客戶代碼、客料版本順序扣用"
        >
          同 ERP 共享庫存
        </span>
        {periodError && (
          <span className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-red-700">
            {periodError}
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
        isSelecting={draggingState}
        onClear={clearSelection}
      />
      <PinnedRowsBar
        items={pinnedItems}
        onUnpin={unpinRow}
        onClearAll={clearPins}
        renderItem={(item) => (
          <>
            <span className="font-mono font-semibold text-slate-800">{item.customerPartNo || item.partVersion}</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-600">{item.customerCode || '—'}</span>
            <span className="text-slate-300">|</span>
            <span className="font-mono text-slate-600">{item.erpPartNo}</span>
          </>
        )}
      />
      <div
        ref={virtualRows.containerRef}
        onScroll={virtualRows.onScroll}
        data-mrp-scroll
        className="flex-1 min-h-0 overflow-auto border border-slate-300 border-t-0 rounded-b-lg bg-white"
      >
      {selectionCss && <style>{selectionCss}</style>}
      <table
        ref={tableRef}
        tabIndex={-1}
        className={`sales-meeting-trad-table mrp-trad-table text-xs border-separate border-spacing-0 trad-sep-table ${draggingState ? 'select-none' : ''}`}
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
            {/* Frozen group */}
            {visibleFrozenCols.map((col, i) => {
              const gi = i;
              return (
                <th
                  key={col.key}
                  className="bg-slate-200 border-r border-slate-300 px-1"
                  style={pinStyle(gi, col.width, 40)}
                />
              );
            })}

            {/* Info columns — each is its own group header */}
            {visibleInfoCols.map((col, i) => {
              const gi = infoOffset + i;
              return (
                <th
                  key={col.key}
                  className={`${col.headerBg || 'bg-slate-200'} border-r border-slate-300 px-1`}
                  style={pinStyle(gi, col.width, 40)}
                />
              );
            })}

            {/* Period groups */}
            {visiblePeriodGroups.map((g) => (
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
            {/* Frozen columns */}
            {visibleFrozenCols.map((col, i) => {
              const gi = i;
              return (
                <th
                  key={col.key}
                  className="bg-slate-100 px-1.5 py-1.5 text-left font-semibold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[10px]"
                  style={pinStyle(gi, col.width, 40)}
                >
                  <ColumnHeaderButton
                    column={columnHeaderById.get(col.key)!}
                    controller={columnHeaderController}
                    label={col.label}
                    labelMaxLines={3}
                    labelClassName="text-left"
                  />
                </th>
              );
            })}

            {/* Info columns */}
            {visibleInfoCols.map((col, i) => {
              const gi = infoOffset + i;
              return (
                <th
                  key={col.key}
                  className={`${col.headerBg || 'bg-slate-100'} px-1.5 py-1.5 ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'} font-semibold text-slate-700 border-r border-slate-200 text-[10px] whitespace-pre-line leading-tight`}
                  style={pinStyle(gi, col.width, 40)}
                >
                  {columnHeaderById.has(col.key) ? (
                    <ColumnHeaderButton
                      column={columnHeaderById.get(col.key)!}
                      controller={columnHeaderController}
                      label={col.label}
                      labelMaxLines={3}
                      labelClassName="whitespace-pre-line text-inherit"
                    />
                  ) : col.label}
                </th>
              );
            })}

            {/* Period group columns */}
            {visiblePeriodGroups.map((g) =>
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
        <tbody>
          <VirtualTableSpacer height={virtualRows.topSpacerHeight} colSpan={bodyColSpan} zoom={tableZoom} />
          <MemoizedSalesMeetingRows
            items={items}
            start={virtualRows.start}
            end={virtualRows.end}
            renderVersion={rowRenderVersion}
            renderRow={(item, rowIdx) => {
            const periods = periodsMap[item.partVersion] || [];
            const paddedPeriods: (PeriodDetail | null)[] = Array.from(
              { length: numWeeks },
              (_, i) => periods[i] || null,
            );
            const previousErp = rowIdx > 0 ? items[rowIdx - 1]?.erpPartNo?.trim() : null;
            const startsSharedGroup = item.sharedErpCount > 1
              && item.erpPartNo?.trim() !== previousErp;

            return (
              <tr
                key={item.id}
                data-virtual-row
                data-row-id={item.id}
                data-shared-group-start={startsSharedGroup ? 'true' : undefined}
                className={`border-b border-slate-100 hover:bg-blue-50/30 ${
                  rowIdx % 2 === 0 ? '' : 'bg-slate-50/50'
                }`}
              >
                {/* Frozen columns */}
                {visibleFrozenCols.map((col, i) => {
                  const gi = i;
                  const val = itemColumnValue(item, col.key);
                  return (
                    <td
                      key={col.key}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-col={col.key}
                      data-value={val != null ? String(val) : ''}
                      className={`px-1.5 py-1 whitespace-nowrap border-r border-slate-100 ${
                        pinBg(gi, rowIdx, rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50')
                      } font-mono text-[10px] font-medium cursor-cell`}
                      style={pinStyle(gi, col.width, 10)}
                      title={col.key === 'customerPartNo'
                        ? item.memberPartVersions.join('\n')
                        : String(val || '')}
                    >
                      <div className="truncate" style={{ maxWidth: col.width - 12 }}>
                        {snapshot && col.key === 'partVersion' && onInspect ? <button type="button" className="underline decoration-dotted" onMouseDown={event => event.stopPropagation()} onClick={() => onInspect(item)}>{val != null ? String(val) : '—'}</button> : val != null ? String(val) : '—'}
                      </div>
                    </td>
                  );
                })}

                {/* Info columns */}
                {visibleInfoCols.map((col, i) => {
                  if (snapshot && (col.type === 'warehouse' || col.type === 'anomaly' || (item[col.key as keyof SalesMeetingItem] == null && col.type !== 'shortage-badge'))) {
                    const value = item[col.key as keyof SalesMeetingItem];
                    const gi = infoOffset + i;
                    return <td key={col.key} data-selr={rowIdx} data-selc={gi} data-col={col.key} data-value={value == null ? '' : String(value)} className={`border-r border-slate-100 px-1.5 py-1 text-right font-mono ${pinBg(gi, rowIdx, col.cellBg || '')}`} style={pinStyle(gi, col.width, 10)}>{value == null ? '—' : numCell(Number(value))}</td>;
                  }
                  const gi = infoOffset + i;
                  const cellBg = col.cellBg || '';
                  const frozenBgClass = pinBg(gi, rowIdx, cellBg);
                  const menuCellAttributes = SALES_MEETING_COLUMN_ID_SET.has(col.key)
                    ? { 'data-col': col.key }
                    : {
                        'data-period-key': col.key,
                        'data-period-label': col.label.replace(/\n/g, ' '),
                      };
                  const menuValue = item[col.key as keyof SalesMeetingItem];
                  const menuDataValue = menuValue != null ? String(menuValue) : '';

                  // Text column (erpPartNo)
                  if (col.type === 'text') {
                    const val = item[col.key as keyof SalesMeetingItem];
                    return (
                      <td
                        key={col.key}
                        {...menuCellAttributes}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-value={menuDataValue}
                        className={`px-1.5 py-1 font-mono text-[10px] whitespace-nowrap border-r border-slate-100 ${frozenBgClass} cursor-cell`}
                        style={pinStyle(gi, col.width, 10)}
                        title={String(val || '')}
                      >
                        {/* ERP 料號不截斷，對齊成品月推移傳統檢視的處理 */}
                        <div className="whitespace-nowrap">
                          {val != null ? String(val) : '—'}
                        </div>
                      </td>
                    );
                  }

                  if (col.type === 'warehouse') {
                    const warehouseGroup = col.key === 'wfgStockPc' ? 'INTERNAL' : 'YE1';
                    const value = item[col.key as 'wfgStockPc' | 'ye1StockPc'];
                    const anomalyCount = warehouseGroup === 'INTERNAL'
                      ? item.wfgInventoryAnomalyCount
                      : item.ye1InventoryAnomalyCount;
                    return (
                      <td
                        key={col.key}
                        {...menuCellAttributes}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-value={menuDataValue}
                        className={`px-1.5 py-1 text-right font-mono border-r border-slate-100 ${frozenBgClass} cursor-cell`}
                        style={pinStyle(gi, col.width, 10)}
                      >
                        <WarehouseStockValue
                          value={value}
                          warehouseGroup={warehouseGroup}
                          onOpen={() => onOpenWarehouse(item, warehouseGroup)}
                          hasInventoryAnomaly={anomalyCount > 0}
                          inventoryAnomalyCount={anomalyCount}
                        />
                      </td>
                    );
                  }

                  if (col.type === 'anomaly') {
                    return (
                      <td
                        key={col.key}
                        {...menuCellAttributes}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-value={menuDataValue}
                        className={`px-1 py-1 text-center border-r border-slate-100 ${frozenBgClass} cursor-cell`}
                        style={pinStyle(gi, col.width, 10)}
                      >
                        {item.inventoryAnomalyCount > 0 ? (
                          <button
                            type="button"
                            data-no-selection
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => onOpenWarehouse(
                              item,
                              item.wfgInventoryAnomalyCount > 0 ? 'INTERNAL' : 'YE1',
                              'ANOMALY',
                            )}
                            className="border border-amber-400 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
                            title={`查看 ${item.inventoryAnomalyCount} 筆庫存異常`}
                          >
                            待確認 {item.inventoryAnomalyCount}
                          </button>
                        ) : (
                          <span className="text-emerald-600">正常</span>
                        )}
                      </td>
                    );
                  }

                  // Status badge (fgStatus04)
                  if (col.type === 'status') {
                    return (
                      <td
                        key={col.key}
                        {...menuCellAttributes}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-value={menuDataValue}
                        className={`px-1.5 py-1 text-center border-r border-slate-100 ${frozenBgClass}`}
                        style={pinStyle(gi, col.width, 10)}
                      >
                        {item.fgStatus04 ? (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[item.fgStatus04] || 'bg-slate-100'}`}>
                            {item.fgStatus04}
                          </span>
                        ) : '—'}
                      </td>
                    );
                  }

                  // Shortage badge (shortageStartWeek)
                  if (col.type === 'shortage-badge') {
                    return (
                      <td
                        key={col.key}
                        {...menuCellAttributes}
                        data-selr={rowIdx}
                        data-selc={gi}
                        data-value={menuDataValue}
                        className={`px-1.5 py-1 text-center border-r border-slate-100 ${frozenBgClass}`}
                        style={pinStyle(gi, col.width, 10)}
                      >
                        {item.shortageStartWeek !== null ? (
                          <span className="text-red-600 font-bold text-[10px] bg-red-100 px-1 rounded">
                            W{item.shortageStartWeek}
                          </span>
                        ) : (
                          <span className="text-slate-300">&mdash;</span>
                        )}
                      </td>
                    );
                  }

                  // Number column (default)
                  const val = Number(item[col.key as keyof SalesMeetingItem]) || 0;
                  return (
                    <td
                      key={col.key}
                      {...menuCellAttributes}
                      data-selr={rowIdx}
                      data-selc={gi}
                      data-value={menuDataValue}
                      className={`px-1.5 py-1 text-right font-mono border-r border-slate-100 ${frozenBgClass} cursor-cell`}
                      style={pinStyle(gi, col.width, 10)}
                    >
                      {col.source && !snapshot ? (
                        <SalesMeetingSourceValue target={salesMeetingSummarySource(item, col.source)} onOpen={onOpenSource}>
                          {val === 0 ? <span className="text-slate-500">0</span> : numCell(val, col.decimals || 0, col.negative)}
                        </SalesMeetingSourceValue>
                      ) : numCell(val, col.decimals || 0, col.negative)}
                    </td>
                  );
                })}

                {/* Period group cells */}
                {visiblePeriodGroups.map((g, groupIndex) =>
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
                    const sourceType = g.key === 'demand'
                      ? 'orders'
                      : g.key === 'supply'
                        ? 'production_plans'
                        : 'balance';
                    return (
                      <td
                        key={`${g.key}-${wi}`}
                        data-selr={rowIdx}
                        data-selc={selectionPrePeriodCols.length + groupIndex * numWeeks + wi}
                        data-period-key={g.key}
                        data-period-label={`${g.label} ${p?.weekLabel || labels[wi] || `W${wi}`}`}
                        data-value={String(val)}
                        className={`px-1 py-1 text-right font-mono ${
                          isPriorRemaining
                            ? 'bg-slate-50'
                            : isStockGroup && isNeg
                            ? 'bg-red-100 text-red-800 font-bold'
                            : g.cellBg
                        } ${
                          wi === numWeeks - 1 ? 'border-r border-slate-300' : 'border-r border-slate-100'
                        } cursor-cell`}
                        style={{ minWidth: PERIOD_COL_WIDTH }}
                      >
                        {isPriorRemaining ? '' : (
                          <SalesMeetingSourceValue
                            target={{
                              item,
                              type: sourceType,
                              weekIndex: p?.weekIndex ?? wi,
                              weekLabel: p?.weekLabel || labels[wi] || `W${wi}`,
                            }}
                            onOpen={onOpenSource}
                          >
                            <span className={val === 0 ? 'text-slate-500' : ''}>{val === 0 ? '0' : val.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                          </SalesMeetingSourceValue>
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
      </table>
      </div>
      {active && <CellContextMenu {...cellMenu.contextMenuProps} />}
    </div>
  );
}
