'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import {
  useColumnVisibility,
  useRunCustomerCodeColumns,
  useTableFiltering,
  useTablePresets,
  useTableSorting,
} from './data-table/hooks';
import { TableToolbar } from './data-table/ui/table-toolbar';
import {
  ColumnHeaderCell,
  ColumnHeaderMenu,
  useTableColumnHeaderMenu,
} from './data-table/ui/column-header-menu';
import { PLAN_MANAGEMENT_COLUMNS } from './data-table/column-defs/plan-management-columns';
import { CellContextMenu, useCellContextMenu } from './data-table/ui/cell-context-menu';
import { multiFieldSort } from './data-table/utils/sort-fns';
import { applyFiltersToRow } from './data-table/utils/filter-fns';
import type { TablePreset } from './data-table/types';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { useToast } from './toast';
import { useConfirm } from './confirm-dialog';
import { friendlyTransferError } from '@/lib/transfer-error';
import { TRANSFER_STATUS, isTransferBlocked, type TransferStatus } from '@/lib/transfer-state';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheGet, cacheSet, cacheIsFresh, cacheInvalidate } from '@/lib/swr-cache';
import { TransferReconciliationControls } from './transfer-reconciliation-controls';
import {
  ProductionPlanWorkOrderAction,
  type ProductionPlanWorkOrderUpdate,
} from './production-plan-work-order-action';
import type { WorkOrderStatus } from '@/lib/work-order-state';
import {
  canAutoRecalculatePlanQty,
  computeFulfillmentPlanQty,
  computeMaterialKg,
} from '@/lib/mrp/fg-plan-suggestion';
import { parsePositivePlanQty } from '@/lib/mrp/fg-plan-input';
import { TablePagination } from './ui/table-pagination';

const planKey = (runId: number | null) => (runId != null ? `/api/plan-management?runId=${runId}` : null);

const TABLE_ID = 'plan_management';
const SEARCHABLE_FIELDS = ['partVersion', 'customerPartNo', 'customerCode', 'erpPartNo', 'forgingParent', 'sourcePlanNo'];
const DEFAULT_BUFFER_PCT = '10';
const DEFAULT_PLAN_PAGE_SIZE = 50;
const PLAN_MANAGEMENT_COLUMN_IDS = new Set(
  PLAN_MANAGEMENT_COLUMNS.map((column) => column.id),
);

// 批次轉單前端並發數：逐筆打單筆轉單端點，同時最多幾筆在飛。
// source-client 無 global rate limiter，唯一護欄是 per-call 的 429 backoff；
// 2 約對應現況一半時間。若與 sync/verify 同時段跑可能疊加超限，調高前先在
// staging 觀測 429 出現率。
const BATCH_TRANSFER_CONCURRENCY = 2;

interface PlanItem {
  id: number;
  mrpRunId: number;
  partVersion: string;
  planSequence: number;
  targetStartPeriod: number | null;
  fulfillToPeriod: number | null;
  suggestedQty: number | null;
  completionDate: string | null;
  materialWeightKg: number | null;
  bufferPct: number;
  useManualQty: boolean;
  isTransferred: boolean;
  transferStatus: TransferStatus;
  transferError: string | null;
  customerPartNo: string | null;
  customerCode: string | null;
  erpPartNo: string | null;
  sharedErpCount: number;
  usesSharedErpPool: boolean;
  forgingMachine: string | null;
  forgingParent: string | null;
  firstProcess: string | null;
  currentStockPc: number | null;
  inventoryValidationAvailable: boolean;
  inventoryAnomalyCount: number;
  inventoryAnomalyDiffPc: number;
  inventoryAnomalyErpPartNos: string[];
  mainMaterialKg: number | null;
  unitWeightG: number | null;
  sortGroup: number | null;
  productStatus: string | null;
  sourcePlanNo: string | null;
  sourceUrl: string | null;
  transferId: number | null;
  sourceRecordId: string | null;
  workOrderStatus: WorkOrderStatus | null;
  workOrderError: string | null;
  workOrderCompletedAt: string | null;
  status: '未儲存' | '已儲存' | '待確認' | '已轉單';
}

interface EditFields {
  targetStartPeriod: string;
  fulfillToPeriod: string;
  suggestedQty: string;
  completionDate: string;
  bufferPct: string;
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
  sourcePlanNo?: string | null;
  sourceUrl?: string | null;
  transferId?: number | null;
  sourceRecordId?: string | null;
  workOrderStatus?: WorkOrderStatus | null;
  workOrderError?: string | null;
  workOrderCompletedAt?: string | null;
}

const STATUS_TABS = [
  { value: 'all', label: '全部' },
  { value: '未儲存', label: '未儲存' },
  { value: '已儲存', label: '已儲存' },
  { value: '待確認', label: '待確認' },
  { value: '已轉單', label: '已建立生產計畫' },
] as const;

export function PlanManagementClient() {
  const { selectedRunId, isLoading: versionLoading, isLatestSelected, setBusy } = useMrpVersion();
  const queryRunId = versionLoading ? null : selectedRunId;
  const activeRunIdRef = useRef(queryRunId);
  activeRunIdRef.current = queryRunId;
  const fetchAbortRef = useRef<AbortController | null>(null);
  const isReadOnly = queryRunId === null || !isLatestSelected;
  const showToast = useToast();
  const confirmDialog = useConfirm();
  // 跨頁快取 lazy-seed：重訪時 selectedRunId 已 resolve → 首幀直接吃 stale、零 spinner
  const [items, setItems] = useState<PlanItem[]>(() => {
    const k = planKey(queryRunId);
    return k ? (cachePeek<{ items: PlanItem[] }>(k)?.items ?? []) : [];
  });
  const [loading, setLoading] = useState(() => {
    const k = planKey(queryRunId);
    return k ? cachePeek(k) === undefined : true;
  });
  const [runVersionCode, setRunVersionCode] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const handleWorkOrderChange = useCallback((id: number, update: ProductionPlanWorkOrderUpdate) => {
    setItems((current) => current.map((item) => (
      item.id === id ? { ...item, ...update } : item
    )));
  }, []);

  // Edit state
  const [editingIds, setEditingIds] = useState<Set<number>>(new Set());
  const [editState, setEditState] = useState<Map<number, EditFields>>(new Map());
  const [savingId, setSavingId] = useState<number | null>(null);

  // Batch transfer state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [tablePage, setTablePage] = useState(1);
  const [tableLimit, setTableLimit] = useState(DEFAULT_PLAN_PAGE_SIZE);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [includeInventoryAnomalies, setIncludeInventoryAnomalies] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferProgress, setTransferProgress] = useState<{
    completed: number;
    total: number;
    failed: Array<{ partVersion: string; planSequence: number; error: string }>;
  } | null>(null);
  // 取消旗標：按下取消後 worker 不再從 queue 取新項，已送出的單筆自然跑完
  const abortBatchRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  // 轉單進行中防止誤關分頁（已送出的單筆若中斷會卡在已建檔但畫面沒更新）
  useEffect(() => {
    if (!transferring) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [transferring]);

  // 轉單中 / 有列在編輯 → 回報忙碌，延後「自動切換到最新 MRP」直到操作結束
  useEffect(() => {
    setBusy('plan-management', transferring || editingIds.size > 0);
    return () => setBusy('plan-management', false);
  }, [transferring, editingIds, setBusy]);

  // Overlay state
  const [overlayPartVersion, setOverlayPartVersion] = useState<string | null>(null);

  const columns = useRunCustomerCodeColumns(PLAN_MANAGEMENT_COLUMNS, selectedRunId);

  // Table hooks
  const sorting = useTableSorting(
    [
      { id: 'forgingParent', direction: 'asc', label: '鍛造母件' },
      { id: 'partVersion', direction: 'asc', label: '客料版本' },
      { id: 'planSequence', direction: 'asc', label: '規劃#' },
    ],
    'mrp_sort_plan_mgmt',
    PLAN_MANAGEMENT_COLUMN_IDS,
  );
  const filtering = useTableFiltering(
    undefined,
    'mrp_filter_plan_mgmt',
    PLAN_MANAGEMENT_COLUMN_IDS,
  );
  const colVis = useColumnVisibility(columns, 'mrp_colvis_plan_mgmt');
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

  // Fetch data
  useLayoutEffect(() => {
    fetchAbortRef.current?.abort();
    const key = planKey(queryRunId);
    const cached = key ? cachePeek<{ items: PlanItem[]; runVersionCode: string | null }>(key) : undefined;
    setItems(cached?.items ?? []);
    setRunVersionCode(cached?.runVersionCode ?? null);
    setLoading(!cached);
    return () => fetchAbortRef.current?.abort();
  }, [queryRunId]);

  const fetchData = useCallback(async () => {
    if (queryRunId === null || activeRunIdRef.current !== queryRunId) return;
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const key = planKey(queryRunId);
    const url = `/api/plan-management?runId=${queryRunId}`;
    if (key) {
      const cached = cacheGet<{ items: PlanItem[]; runVersionCode: string | null }>(key);
      if (cached) {
        setItems(cached.items);
        setRunVersionCode(cached.runVersionCode);
        setLoading(false);
        if (cacheIsFresh(key)) return; // 夠新就不打網路；否則靜默背景 revalidate
      }
    }
    try {
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json();
      if (controller.signal.aborted || activeRunIdRef.current !== queryRunId || fetchAbortRef.current !== controller) return;
      if (!res.ok) throw new Error(json.error || '開單規劃讀取失敗');
      setItems(json.items || []);
      setRunVersionCode(json.runVersionCode || null);
      if (key) cacheSet(key, { items: json.items || [], runVersionCode: json.runVersionCode || null });
    } catch {
      // ignore
    } finally {
      if (!controller.signal.aborted && activeRunIdRef.current === queryRunId && fetchAbortRef.current === controller) setLoading(false);
    }
  }, [queryRunId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Initialize edit state for unsaved rows
  useEffect(() => {
    const newEditState = new Map<number, EditFields>();
    const newEditingIds = new Set<number>();
    for (const item of items) {
      if (item.status === '未儲存') {
        newEditingIds.add(item.id);
        newEditState.set(item.id, itemToEditFields(item));
      }
    }
    setEditingIds(newEditingIds);
    setEditState(newEditState);
    setSelectedIds(new Set());
    setIncludeInventoryAnomalies(false);
  }, [items]);

  // Filter + sort
  const processed = useMemo(() => {
    let result = items;
    if (statusFilter !== 'all') {
      result = result.filter((r) => r.status === statusFilter);
    }
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
      result = multiFieldSort(result as unknown as Record<string, unknown>[], sorting.sortState.fields) as unknown as PlanItem[];
    }
    return result;
  }, [items, statusFilter, filtering.filterState, sorting.sortState]);
  const tableTotalPages = Math.max(1, Math.ceil(processed.length / tableLimit));
  const pagedProcessed = useMemo(
    () => processed.slice((tablePage - 1) * tableLimit, tablePage * tableLimit),
    [processed, tableLimit, tablePage],
  );
  const handleTablePageChange = useCallback((page: number) => {
    setTablePage(page);
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    handleTablePageChange(1);
  }, [statusFilter, filtering.filterState, sorting.sortState, handleTablePageChange]);

  useEffect(() => {
    if (tablePage > tableTotalPages) handleTablePageChange(tableTotalPages);
  }, [handleTablePageChange, tablePage, tableTotalPages]);

  // Counts for tabs
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length, '未儲存': 0, '已儲存': 0, '待確認': 0, '已轉單': 0 };
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, [items]);

  // Edit handlers
  const handleEditClick = (item: PlanItem) => {
    setEditingIds((prev) => new Set(prev).add(item.id));
    setEditState((prev) => new Map(prev).set(item.id, itemToEditFields(item)));
  };

  const handleCancelEdit = (item: PlanItem) => {
    setEditingIds((prev) => { const s = new Set(prev); s.delete(item.id); return s; });
    setEditState((prev) => { const m = new Map(prev); m.delete(item.id); return m; });
  };

  const handleFieldChange = (id: number, field: keyof EditFields, value: string) => {
    setEditState((prev) => {
      const m = new Map(prev);
      const current = m.get(id);
      if (current) m.set(id, { ...current, [field]: value });
      return m;
    });
  };

  const handleSave = async (item: PlanItem) => {
    if (isReadOnly) return;
    const edit = editState.get(item.id);
    if (!edit) return;
    setSavingId(item.id);
    try {
      const qty = parsePositivePlanQty(edit.suggestedQty);
      if (qty === null) {
        alert('生產計畫量必須大於 0');
        return;
      }
      const bufferDecimal = (parseFloat(edit.bufferPct) || 0) / 100;
      const materialKg = computeMaterialKg(qty, Number(item.mainMaterialKg) || 0, Number(item.unitWeightG) || 0);
      const res = await fetch(
        `/api/fg-monthly/${encodeURIComponent(item.partVersion)}/suggestions`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: item.mrpRunId,
            planSequence: item.planSequence,
            suggestedQty: qty,
            completionDate: edit.completionDate || undefined,
            targetStartPeriod: parseInt(edit.targetStartPeriod) || 0,
            fulfillToPeriod: parseFloat(edit.fulfillToPeriod) || 0,
            materialWeightKg: materialKg,
            bufferPct: bufferDecimal,
          }),
        },
      );
      if (res.ok) {
        cacheInvalidate((k) => k.startsWith('/api/plan-management') || k.startsWith('/api/fg-monthly'));
        await fetchData();
      } else {
        const json = await res.json();
        alert(json.error || '儲存失敗');
      }
    } catch {
      alert('網路錯誤');
    } finally {
      setSavingId(null);
    }
  };

  // Selection handlers
  const savedItems = useMemo(
    () => processed.filter((item) => item.status === '已儲存'),
    [processed],
  );
  const anomalySavedItems = useMemo(
    () => savedItems.filter((item) => item.inventoryAnomalyCount > 0),
    [savedItems],
  );
  const transferableItems = useMemo(
    () => savedItems.filter((item) => includeInventoryAnomalies || item.inventoryAnomalyCount === 0),
    [includeInventoryAnomalies, savedItems],
  );

  const handleIncludeInventoryAnomalies = (checked: boolean) => {
    setIncludeInventoryAnomalies(checked);
    if (!checked) {
      const anomalyIds = new Set(anomalySavedItems.map((item) => item.id));
      setSelectedIds((previous) => new Set([...previous].filter((id) => !anomalyIds.has(id))));
    }
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(transferableItems.map((i) => i.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (checked) s.add(id); else s.delete(id);
      return s;
    });
  };

  // Batch transfer
  const handleBatchTransfer = async () => {
    if (isReadOnly) return;
    const selectedItems = items.filter((item) =>
      selectedIds.has(item.id)
      && item.status === '已儲存'
      && (includeInventoryAnomalies || item.inventoryAnomalyCount === 0),
    );
    if (selectedItems.length === 0) return;
    const selectedAnomalyCount = selectedItems.filter((item) => item.inventoryAnomalyCount > 0).length;
    const anomalyMessage = selectedAnomalyCount > 0
      ? `\n\n其中 ${selectedAnomalyCount} 筆規劃含可能未同步的庫存批號；你已選擇仍納入建立。`
      : '';
    const ok = await confirmDialog({
      title: '批次建立生產計畫',
      message: `確定要在 Source 建立 ${selectedItems.length} 筆生產計畫？${anomalyMessage}\n\n此步驟不會產生工令單；建立完成後再由使用者逐筆確認並執行。`,
      confirmText: '建立生產計畫',
    });
    if (!ok) return;

    abortBatchRef.current = false;
    setCancelling(false);
    setTransferring(true);
    setTransferProgress({ completed: 0, total: selectedItems.length, failed: [] });

    // 逐筆打已驗證的單筆轉單端點，用 Promise pool 控並發。每筆 resolve 即時更新
    // 進度；單筆失敗只記錄、不拖垮其他筆（沿用原 batch 端點的逐筆獨立語意）。
    const queue = [...selectedItems];
    let succeeded = 0;
    const failed: Array<{ partVersion: string; planSequence: number; error: string }> = [];

    const worker = async () => {
      while (queue.length > 0) {
        if (abortBatchRef.current) break; // 取消：不再取新項（已送出的這筆讓它跑完）
        const item = queue.shift();
        if (!item) break;
        try {
          const res = await fetch(
            `/api/fg-monthly/${encodeURIComponent(item.partVersion)}/suggestions`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId: item.mrpRunId,
                planSequence: item.planSequence,
                isTransferred: true,
                inventoryAnomalyAcknowledged:
                  includeInventoryAnomalies && item.inventoryAnomalyCount > 0,
              }),
            },
          );
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${res.status}`);
          }
          succeeded++;
        } catch (err) {
          failed.push({
            partVersion: item.partVersion,
            planSequence: item.planSequence,
            error: friendlyTransferError(err instanceof Error ? err.message : '未知錯誤'),
          });
        } finally {
          setTransferProgress((p) =>
            p ? { ...p, completed: p.completed + 1, failed: [...failed] } : p,
          );
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(BATCH_TRANSFER_CONCURRENCY, selectedItems.length) }, worker),
      );
      const aborted = abortBatchRef.current;
      const skipped = selectedItems.length - succeeded - failed.length;
      showToast({
        type: failed.length > 0 ? 'error' : 'success',
        message: aborted
          ? `已取消建立：成功 ${succeeded} 筆、失敗 ${failed.length} 筆、未建立 ${skipped} 筆`
          : `生產計畫建立完成：成功 ${succeeded} 筆，失敗 ${failed.length} 筆`,
      });
      // 轉單翻轉整片狀態 + 新增生產計畫列 → 砍 plan-management/production-plans/fg-monthly 快取
      cacheInvalidate((k) =>
        k.startsWith('/api/plan-management') || k.startsWith('/api/production-plans') || k.startsWith('/api/fg-monthly'),
      );
      await fetchData();
      setSelectedIds(new Set());
    } finally {
      setTransferring(false);
      setCancelling(false);
    }
  };

  // Row click → open overlay
  const handleRowClick = (item: PlanItem, e: React.MouseEvent) => {
    // Don't open overlay when clicking interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('input, button, a, [role="button"]')) return;
    setOverlayPartVersion(item.partVersion);
  };

  // Get the first item for a partVersion (for overlay header info)
  const overlayItem = useMemo(
    () => overlayPartVersion ? items.find((i) => i.partVersion === overlayPartVersion) : null,
    [overlayPartVersion, items],
  );

  // Preset handlers
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
    <div className="h-full flex flex-col px-6 pt-6 pb-0 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">開單規劃</h2>
          {runVersionCode && (
            <p className="text-sm text-slate-500 mt-1">
              MRP版本：{runVersionCode} — {items.length} 項規劃
            </p>
          )}
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
              statusFilter === tab.value
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
            <span className="ml-1 opacity-70">({statusCounts[tab.value] || 0})</span>
          </button>
        ))}
      </div>

      {/* Batch action bar */}
      {(selectedIds.size > 0 || anomalySavedItems.length > 0) && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-300 rounded-lg text-sm">
          <span className="font-medium text-amber-800">已選取 {selectedIds.size} 項</span>
          {anomalySavedItems.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={includeInventoryAnomalies}
                onChange={(event) => handleIncludeInventoryAnomalies(event.target.checked)}
                disabled={transferring || isReadOnly}
                className="h-3.5 w-3.5 accent-amber-600"
              />
              納入庫存異常 {anomalySavedItems.length} 項
            </label>
          )}
          <button onClick={handleBatchTransfer} disabled={selectedIds.size === 0 || transferring || isReadOnly}
            className="ml-auto px-4 py-1.5 bg-amber-500 text-white rounded text-xs font-medium hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors">
            {transferring ? '建立中...' : '批次建立生產計畫'}
          </button>
        </div>
      )}

      {/* Batch transfer progress — 轉單中或留有失敗時顯示（選取清空後仍可見失敗清單） */}
      {transferProgress && (transferring || transferProgress.failed.length > 0) && (
        <div data-testid="batch-transfer-progress" className="px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-medium text-slate-700 whitespace-nowrap">
              建立進度 {transferProgress.completed}/{transferProgress.total}
              {transferProgress.failed.length > 0 && `（失敗 ${transferProgress.failed.length}）`}
            </span>
            <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
              <div
                className={`h-full transition-all ${transferProgress.failed.length > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${transferProgress.total ? (transferProgress.completed / transferProgress.total) * 100 : 0}%` }}
              />
            </div>
            {transferring ? (
              <button onClick={() => { abortBatchRef.current = true; setCancelling(true); }} disabled={cancelling}
                className="text-xs text-red-600 hover:text-red-700 disabled:text-slate-400 whitespace-nowrap">{cancelling ? '取消中…' : '取消'}</button>
            ) : (
              <button onClick={() => setTransferProgress(null)} className="text-xs text-slate-500 hover:text-slate-700 whitespace-nowrap">清除</button>
            )}
          </div>
          {transferProgress.failed.length > 0 && (
            <ul className="text-xs text-red-600 space-y-0.5 max-h-32 overflow-auto">
              {transferProgress.failed.map((f) => (
                <li key={`${f.partVersion}#${f.planSequence}`}>{f.partVersion} #{f.planSequence}：{f.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex-1 min-h-0 flex flex-col">
        <TableToolbar
          tableId={TABLE_ID} columns={columns}
          sortFields={sorting.sortState.fields} onAddSort={sorting.addSort} onRemoveSort={sorting.removeSort}
          onToggleSortDirection={sorting.toggleDirection} onReorderSort={sorting.reorderSort}
          onClearSort={sorting.clearSort} onResetSort={sorting.resetSort} onSetSort={sorting.setSort}
          globalSearch={filtering.filterState.globalSearch} onGlobalSearchChange={filtering.setGlobalSearch}
          onSearchDraftChange={filtering.rememberSearchDraft}
          searchStateReady={filtering.hydrated}
          restoredSession={filtering.restoredSession}
          columnFilters={filtering.filterState.columnFilters} onSetColumnFilter={filtering.setColumnFilter}
          onRemoveColumnFilter={filtering.removeColumnFilter} onClearAllFilters={filtering.clearAllFilters}
          filterOptionContext={columnHeader.menuController.optionContext}
          filterOptionRows={columnHeader.menuController.optionRows}
          onSetFilters={filtering.setFilters}
          visibility={colVis.visibility} onToggleColumn={colVis.toggleColumn} onShowAllColumns={colVis.showAll}
          onResetColumns={colVis.resetToDefault} visibleCount={colVis.visibleCount} totalColumnCount={colVis.totalCount}
          onSetColumnVisibility={colVis.setColumnVisibility}
          systemSorting={sorting.defaultSortState} systemFiltering={filtering.defaultFilterState} systemVisibility={colVis.defaultVisibility}
          presets={presets.presets} activePresetId={presets.activePresetId} presetsLoading={presets.loading}
          onLoadPreset={handleLoadPreset} onSavePreset={handleSavePreset} onDeletePreset={presets.deletePreset}
          onUpdatePreset={presets.updatePreset} onSetDefaultPreset={presets.setDefault} onUnsetDefaultPreset={presets.unsetDefault}
          onUseSystemDefault={presets.useSystemDefault}
          filterModalController={columnHeader.filterModalController}
        />
        <ColumnHeaderMenu controller={columnHeader.menuController} />

        {/* Table */}
        <div ref={tableScrollRef} data-mrp-scroll className="flex-1 min-h-0 bg-white border border-t-0 border-slate-200 rounded-b-lg overflow-auto">
          <table className="w-full mrp-table" onContextMenu={cellMenu.handleContextMenu}>
            <thead>
              <tr>
                <th className="w-8 text-center">
                  <input type="checkbox"
                    checked={transferableItems.length > 0 && transferableItems.every((i) => selectedIds.has(i.id))}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="w-3.5 h-3.5 accent-amber-500" disabled={transferableItems.length === 0}
                    title="選取目前篩選結果的所有可建立項目" />
                </th>
                {columns.filter((column) => colVis.isVisible(column.id)).map((column) => (
                  <ColumnHeaderCell key={column.id} column={column} controller={columnHeader.menuController} />
                ))}
                <th className="w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={20}><Loader /></td></tr>
              ) : processed.length === 0 ? (
                <tr><td colSpan={20} className="text-center py-8 text-slate-400">
                  {items.length === 0 ? '尚無規劃建議。請先執行 MRP。' : '無符合篩選條件的結果。'}
                </td></tr>
              ) : (
                pagedProcessed.map((item) => {
                  const isEditing = editingIds.has(item.id);
                  const edit = editState.get(item.id);
                  const isSaving = savingId === item.id;
                  const canSelect = item.status === '已儲存'
                    && (includeInventoryAnomalies || item.inventoryAnomalyCount === 0);
                  const displayQty = isEditing ? parseFloat(edit?.suggestedQty || '0') || 0 : Number(item.suggestedQty) || 0;
                  const displayMaterialKg = computeMaterialKg(displayQty, Number(item.mainMaterialKg) || 0, Number(item.unitWeightG) || 0);

                  return (
                    <tr key={item.id} onClick={(e) => handleRowClick(item, e)}
                      className={`cursor-pointer hover:bg-slate-50 ${
                        item.status === '已轉單' ? 'bg-green-50/50' :
                        item.status === '待確認' ? 'bg-amber-50/60' :
                        item.status === '已儲存' ? 'bg-blue-50/30' : ''
                      }`}>
                      <td className="text-center">
                        <input type="checkbox" checked={selectedIds.has(item.id)}
                          onChange={(e) => handleSelectOne(item.id, e.target.checked)}
                          disabled={!canSelect} className="w-3.5 h-3.5 accent-amber-500 disabled:opacity-30" />
                      </td>
                      {colVis.isVisible('partVersion') && <td data-col="partVersion" data-value={item.partVersion ?? ''} className="font-mono text-xs">{item.partVersion}</td>}
                      {colVis.isVisible('customerPartNo') && <td data-col="customerPartNo" data-value={item.customerPartNo ?? ''} className="text-xs">{item.customerPartNo || '—'}</td>}
                      {colVis.isVisible('customerCode') && <td data-col="customerCode" data-value={item.customerCode ?? ''} className="text-xs">{item.customerCode || '—'}</td>}
                      {colVis.isVisible('erpPartNo') && <td data-col="erpPartNo" data-value={item.erpPartNo ?? ''} className="font-mono text-xs">{item.erpPartNo || '—'}</td>}
                      {colVis.isVisible('forgingMachine') && <td data-col="forgingMachine" data-value={item.forgingMachine ?? ''} className="text-xs text-center">{item.forgingMachine || '—'}</td>}
                      {colVis.isVisible('forgingParent') && <td data-col="forgingParent" data-value={item.forgingParent ?? ''} className="text-xs">{item.forgingParent || '—'}</td>}
                      {colVis.isVisible('planSequence') && <td data-col="planSequence" data-value={String(item.planSequence ?? '')} className="text-xs text-center font-semibold">#{item.planSequence}</td>}
                      {colVis.isVisible('targetStartPeriod') && (
                        <td className="text-center">
                          {isEditing ? (
                            <input type="number" min="0" max="12" value={edit?.targetStartPeriod || ''}
                              onChange={(e) => handleFieldChange(item.id, 'targetStartPeriod', e.target.value)}
                              className="w-14 px-1 py-0.5 border border-slate-300 rounded text-xs font-mono text-center" />
                          ) : (
                            <span className="text-xs font-mono">{item.targetStartPeriod ?? '—'}</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible('fulfillToPeriod') && (
                        <td className="text-center">
                          {isEditing ? (
                            <input type="number" min="0" max="12" step="0.5" value={edit?.fulfillToPeriod || ''}
                              onChange={(e) => handleFieldChange(item.id, 'fulfillToPeriod', e.target.value)}
                              className="w-14 px-1 py-0.5 border border-slate-300 rounded text-xs font-mono text-center" />
                          ) : (
                            <span className="text-xs font-mono">{item.fulfillToPeriod != null ? Number(item.fulfillToPeriod) : '—'}</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible('suggestedQty') && (
                        <td className="text-right">
                          {isEditing ? (
                            <input type="number" min="1" step="1" value={edit?.suggestedQty || ''}
                              onChange={(e) => handleFieldChange(item.id, 'suggestedQty', e.target.value)}
                              className="w-20 px-1 py-0.5 border border-slate-300 rounded text-xs font-mono text-right" />
                          ) : (
                            <span className="text-xs font-mono">{item.suggestedQty != null ? Number(item.suggestedQty).toLocaleString() : '—'}</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible('completionDate') && (
                        <td>
                          {isEditing ? (
                            <input type="date" value={edit?.completionDate || ''}
                              onChange={(e) => handleFieldChange(item.id, 'completionDate', e.target.value)}
                              className="px-1 py-0.5 border border-slate-300 rounded text-xs" />
                          ) : (
                            <span className="text-xs text-slate-500">{item.completionDate ? new Date(item.completionDate).toLocaleDateString('zh-TW') : '—'}</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible('materialWeightKg') && (
                        <td className="text-right"><span className="text-xs font-mono text-slate-500">{displayMaterialKg > 0 ? displayMaterialKg.toFixed(3) : '—'}</span></td>
                      )}
                      {colVis.isVisible('bufferPct') && (
                        <td className="text-right">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <input type="number" min="0" max="100" step="1" value={edit?.bufferPct || ''}
                                onChange={(e) => handleFieldChange(item.id, 'bufferPct', e.target.value)}
                                className="w-12 px-1 py-0.5 border border-slate-300 rounded text-xs font-mono text-right" />
                              <span className="text-xs text-slate-400">%</span>
                            </div>
                          ) : (
                            <span className="text-xs font-mono">{item.bufferPct != null ? `${(Number(item.bufferPct) * 100).toFixed(0)}%` : '—'}</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible('status') && (
                        <td data-col="status" data-value={item.status ?? ''} className="text-center">
                          <div className="flex flex-col items-center gap-1">
                            <StatusBadge status={item.status} />
                            {item.inventoryAnomalyCount > 0 && (
                              <span
                                className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                title={`庫存批號差異絕對值合計 ${item.inventoryAnomalyDiffPc.toLocaleString()} pc`}
                              >
                                <span aria-hidden="true">!</span>庫存待確認 {item.inventoryAnomalyCount}
                              </span>
                            )}
                          </div>
                        </td>
                      )}
                      {colVis.isVisible('sourcePlanNo') && (
                        <td className="font-mono text-xs">
                          {item.sourceUrl ? (
                            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">{item.sourcePlanNo || '—'}</a>
                          ) : item.sourcePlanNo || '—'}
                        </td>
                      )}
                      <td>
                        <div className="flex items-center gap-1">
                          {isEditing && (
                            <>
                              <button onClick={() => handleSave(item)} disabled={isSaving || !edit?.suggestedQty || isReadOnly}
                                className="px-2 py-0.5 bg-blue-600 text-white rounded text-[11px] hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed whitespace-nowrap">
                                {isSaving ? '...' : '儲存'}
                              </button>
                              {item.status === '已儲存' && (
                                <button onClick={() => handleCancelEdit(item)}
                                  className="px-2 py-0.5 border border-slate-300 text-slate-500 rounded text-[11px] hover:bg-slate-100 whitespace-nowrap">取消</button>
                              )}
                            </>
                          )}
                          {!isEditing && item.status === '已儲存' && (
                            <button onClick={() => handleEditClick(item)} disabled={isReadOnly}
                              className="px-2 py-0.5 border border-slate-400 text-slate-600 rounded text-[11px] hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">編輯</button>
                          )}
                          {item.status === '已轉單' && (
                            <>
                              {item.sourceUrl && (
                                <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer"
                                  className="px-2 py-0.5 border border-emerald-300 bg-emerald-50 text-emerald-700 rounded text-[11px] hover:bg-emerald-100 whitespace-nowrap">
                                  生產計畫
                                </a>
                              )}
                              <ProductionPlanWorkOrderAction
                                transferId={item.transferId}
                                sourceRecordId={item.sourceRecordId}
                                sourcePlanNo={item.sourcePlanNo}
                                sourceUrl={item.sourceUrl}
                                initialStatus={item.workOrderStatus}
                                initialError={item.workOrderError}
                                disabled={isReadOnly}
                                compact
                                onChange={(update) => handleWorkOrderChange(item.id, update)}
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && processed.length > 0 && (
          <div className="flex justify-end border-x border-b border-slate-200 bg-white px-3 py-1.5">
            <TablePagination
              page={tablePage}
              totalPages={tableTotalPages}
              total={processed.length}
              limit={tableLimit}
              onPageChange={handleTablePageChange}
              onLimitChange={(limit) => {
                setTableLimit(limit);
                handleTablePageChange(1);
              }}
              unitLabel="項規劃"
            />
          </div>
        )}
      </div>

      {/* Detail overlay */}
      {overlayPartVersion && overlayItem && (
        <PlanDetailOverlay
          partVersion={overlayPartVersion}
          item={overlayItem}
          runVersionCode={runVersionCode}
          onClose={() => setOverlayPartVersion(null)}
          onDataChange={fetchData}
        />
      )}
      <CellContextMenu {...cellMenu.contextMenuProps} />
    </div>
  );
}

// ============================================================
// Detail overlay — period table + plan editing
// ============================================================
function PlanDetailOverlay({
  partVersion,
  item,
  runVersionCode,
  onClose,
  onDataChange,
}: {
  partVersion: string;
  item: PlanItem;
  runVersionCode: string | null;
  onClose: () => void;
  onDataChange: () => Promise<void>;
}) {
  const { isLatestSelected } = useMrpVersion();
  const isReadOnly = !isLatestSelected;
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [periods, setPeriods] = useState<PeriodDetail[]>([]);
  const [suggestions, setSuggestions] = useState<PlanSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState<number | null>(null);

  // Plan editing state (3 slots)
  const [planEdits, setPlanEdits] = useState<Record<number, {
    startPeriod: string;
    fulfillPeriod: string;
    qty: string;
    completionDate: string;
    bufferPct: string;
    isSaved: boolean;
    isTransferred: boolean;
    transferStatus: TransferStatus;
    transferError?: string | null;
    sourcePlanNo?: string | null;
    sourceUrl?: string | null;
    transferId?: number | null;
    sourceRecordId?: string | null;
    workOrderStatus?: WorkOrderStatus | null;
    workOrderError?: string | null;
  }>>({});

  const mainMaterialKg = Number(item.mainMaterialKg) || 0;
  const unitWeightG = Number(item.unitWeightG) || 0;
  const autoRecalculatePlanQty = canAutoRecalculatePlanQty(item.usesSharedErpPool);

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
      // Rule 1: fulfillPeriod >= startPeriod
      if (fp > 0 && sp > 0 && fp < sp) {
        errors[seq].push(`滿足至?期數 (${fp}) 必須 ≥ 目標開始期 (${sp})`);
        fields[seq].add('fulfillPeriod');
      }
      // Rules 2 & 3: strictly increasing vs previous plan
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

  // Fetch period data
  const fetchPeriods = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/fg-monthly/${encodeURIComponent(partVersion)}/periods?runId=${item.mrpRunId}`);
      const json = await res.json();
      setPeriods(json.periods || []);
      setSuggestions(json.suggestions || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [partVersion, item.mrpRunId]);

  useEffect(() => {
    fetchPeriods();
  }, [fetchPeriods]);

  // Initialize plan edits from suggestions — preserve unsaved local edits
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (suggestions.length === 0 && initializedFor === partVersion) return;
    setPlanEdits((prev) => {
      const edits: typeof prev = {};
      for (const s of suggestions) {
        const existing = prev[s.planSequence];
        // If we have a local edit that's not yet saved/transferred, keep it
        if (existing && !existing.isSaved && !existing.isTransferred && initializedFor === partVersion) {
          edits[s.planSequence] = existing;
        } else {
          edits[s.planSequence] = {
            startPeriod: String(s.targetStartPeriod),
            fulfillPeriod: String(s.fulfillToPeriod),
            qty: String(s.suggestedQty),
            completionDate: s.completionDate ? s.completionDate.split('T')[0] : '',
            bufferPct: String((Number(s.bufferPct) * 100).toFixed(0)),
            isSaved: s.useManualQty,
            isTransferred: s.isTransferred,
            transferStatus: s.isTransferred
              ? TRANSFER_STATUS.SUCCEEDED
              : s.transferStatus ?? TRANSFER_STATUS.IDLE,
            transferError: s.transferError,
            sourcePlanNo: s.sourcePlanNo,
            sourceUrl: s.sourceUrl,
            transferId: s.transferId,
            sourceRecordId: s.sourceRecordId,
            workOrderStatus: s.workOrderStatus,
            workOrderError: s.workOrderError,
          };
        }
      }
      for (let seq = 1; seq <= 3; seq++) {
        if (!edits[seq]) {
          const existing = prev[seq];
          if (existing && !existing.isSaved && !existing.isTransferred && initializedFor === partVersion) {
            edits[seq] = existing;
          } else {
            edits[seq] = {
              startPeriod: '', fulfillPeriod: '', qty: '', completionDate: '',
              bufferPct: DEFAULT_BUFFER_PCT, isSaved: false, isTransferred: false,
              transferStatus: TRANSFER_STATUS.IDLE,
            };
          }
        }
      }
      return edits;
    });
    setInitializedFor(partVersion);
  }, [suggestions, partVersion, initializedFor, loading]);

  // Save a single plan
  const savePlan = async (seq: number): Promise<boolean> => {
    const edit = planEdits[seq];
    if (!edit) return false;
    const qty = parsePositivePlanQty(edit.qty);
    if (qty === null) return false;
    const bufferDecimal = (parseFloat(edit.bufferPct) || 0) / 100;
    const materialKg = computeMaterialKg(qty, mainMaterialKg, unitWeightG);
    const res = await fetch(`/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: item.mrpRunId,
        planSequence: seq,
        suggestedQty: qty,
        completionDate: edit.completionDate || undefined,
        targetStartPeriod: parseInt(edit.startPeriod) || 0,
        fulfillToPeriod: parseFloat(edit.fulfillPeriod) || 0,
        materialWeightKg: materialKg,
        bufferPct: bufferDecimal,
      }),
    });
    if (!res.ok) {
      const json = await res.json();
      alert(json.error || `規劃#${seq} 儲存失敗`);
      return false;
    }
    // Mark saved locally so init effect preserves other unsaved edits
    setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, isSaved: true } }));
    return true;
  };

  const handlePlanSave = async (seq: number) => {
    if (isReadOnly) return;
    setSavingPlan(seq);
    try {
      const ok = await savePlan(seq);
      if (ok) {
        await fetchPeriods();
        await onDataChange();
      }
    } catch {
      alert('網路錯誤');
    } finally {
      setSavingPlan(null);
    }
  };

  // Save All — saves all unsaved plans with values, in order
  const handleSaveAll = async () => {
    if (isReadOnly) return;
    setSavingPlan(-1); // -1 = saving all
    try {
      for (let seq = 1; seq <= 3; seq++) {
        const edit = planEdits[seq];
        if (!edit || edit.isSaved || edit.isTransferred) continue;
        if (!edit.qty || planErrors[seq].length > 0) continue;
        const ok = await savePlan(seq);
        if (!ok) break;
      }
      await fetchPeriods();
      await onDataChange();
    } catch {
      alert('網路錯誤');
    } finally {
      setSavingPlan(null);
    }
  };

  // Transfer plan
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
    const inventoryWarning = item.inventoryAnomalyCount > 0
      ? `\n\n注意：此料號有 ${item.inventoryAnomalyCount} 筆庫存批號可能尚未同步，差異絕對值合計 ${item.inventoryAnomalyDiffPc.toLocaleString()} pc。MRP 仍採 Source 原值。`
      : '';
    const ok = await confirmDialog({
      title: item.inventoryAnomalyCount > 0 ? '確認庫存異常後建立生產計畫' : '建立生產計畫',
      message: `確定要在 Source 建立規劃#${seq}的生產計畫？\n數量: ${edit.qty}\n完成日: ${edit.completionDate || '—'}${inventoryWarning}\n\n此步驟不會產生工令單。`,
      confirmText: '建立生產計畫',
    });
    if (!ok) return;
    setSavingPlan(seq);
    try {
      const res = await fetch(`/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: item.mrpRunId,
          planSequence: seq,
          isTransferred: true,
          inventoryAnomalyAcknowledged: item.inventoryAnomalyCount > 0,
        }),
      });
      const resJson = await res.json();
      if (res.ok) {
        const t = resJson.transfer;
        setPlanEdits((prev) => ({
          ...prev,
          [seq]: {
            ...prev[seq]!,
            isTransferred: true,
            isSaved: true,
            transferStatus: TRANSFER_STATUS.SUCCEEDED,
            transferError: null,
            sourcePlanNo: t?.sourcePlanNo || null,
            sourceUrl: t?.sourceUrl || null,
          },
        }));
        const planLabel = t?.sourcePlanNo ? ` ${t.sourcePlanNo}` : '';
        showToast({
          type: 'success',
          message: `生產計畫建立成功！${planLabel}`,
          action: t?.sourceUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(t.sourceUrl, '_blank') }
            : undefined,
        });
        await fetchPeriods();
        await onDataChange();
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
    }
  };

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="relative w-[95vw] max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-auto" onClick={(e) => e.stopPropagation()}>
        {/* Sticky header */}
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-start gap-4">
          <button onClick={onClose}
            className="mt-0.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap">
            ← 返回列表
          </button>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-bold text-slate-800 truncate">
              {item.partVersion}
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 mt-1">
              {runVersionCode && <span>MRP版本: <b className="text-slate-700">{runVersionCode}</b></span>}
              {item.erpPartNo && <span>ERP料號: <b className="text-slate-700 font-mono">{item.erpPartNo}</b></span>}
              {item.forgingMachine && <span>機台: <b className="text-slate-700">{item.forgingMachine}</b></span>}
              {item.firstProcess && <span>製程1: <b className="text-slate-700">{item.firstProcess}</b></span>}
              {item.customerCode && <span>客戶: <b className="text-slate-700">{item.customerCode}</b></span>}
              {item.customerPartNo && <span>客戶料號: <b className="text-slate-700">{item.customerPartNo}</b></span>}
              {item.forgingParent && <span>鍛造母件: <b className="text-slate-700">{item.forgingParent}</b></span>}
              <span>成品庫存pc: <b className="text-slate-700">{Number(item.currentStockPc || 0).toLocaleString()}</b></span>
              {item.inventoryAnomalyCount > 0 && (
                <span className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800">
                  <span aria-hidden="true">!</span>庫存資料待確認 {item.inventoryAnomalyCount} 筆
                </span>
              )}
              {unitWeightG > 0 && <span>單位重g: <b className="text-slate-700">{unitWeightG}</b></span>}
              {mainMaterialKg > 0 && <span>主要用料kg: <b className="text-slate-700">{mainMaterialKg}</b></span>}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5">
          {loading ? (
            <div className="py-8 text-center text-slate-400">載入期間資料...</div>
          ) : (
            <>
              {/* Period table */}
              <div className="overflow-auto border border-slate-300 rounded-lg">
                <table className="text-xs whitespace-nowrap border-collapse w-full">
                  <thead>
                    <tr className="bg-slate-100">
                      <th className="sticky left-0 z-10 px-3 py-1.5 border-r-2 border-slate-400 bg-slate-100 text-left font-semibold">
                        成品庫存pc: {Number(item.currentStockPc || 0).toLocaleString()}
                      </th>
                      {periods.map((p) => (
                        <th key={p.periodIndex} className="px-3 py-1.5 text-center border-r border-slate-200 font-semibold">
                          <div>{p.periodLabel}</div>
                          {p.periodStart && <div className="text-[10px] font-normal text-slate-400">{p.periodStart.split('T')[0]}</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* 剩餘庫存 */}
                    <PeriodRow label="剩餘庫存" periods={periods} field="remainingStock" bgClass="bg-green-600 text-white" cellBg="bg-green-50" />
                    {/* [需求整合] */}
                    <PeriodRow label="[需求整合]" periods={periods} field="demandIntegrated" bgClass="bg-orange-500 text-white" cellBg="bg-orange-50" highlight />
                    {/* [訂單未結] */}
                    <PeriodRow label="[訂單未結]" periods={periods} field="ordersUnshipped" bgClass="bg-slate-400 text-white" cellBg="" />
                    {/* [預示量] */}
                    <PeriodRow label="[預示量]" periods={periods} field="forecastQty" bgClass="bg-blue-500 text-white" cellBg="bg-blue-50" />
                    {/* [計畫前期產出] */}
                    <PeriodRow label="[計畫前期產出]" periods={periods} field="plannedOutput" bgClass="bg-yellow-300 text-yellow-900" cellBg="bg-yellow-50" />
                    {/* [訂單總量] */}
                    <PeriodRow label="[訂單總量]" periods={periods} field="ordersTotal" bgClass="bg-gray-300 text-gray-800" cellBg="bg-gray-50" />
                    {/* 剩餘庫存(無計劃量) */}
                    <tr className="border-b-2 border-slate-400">
                      <td className="sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 bg-teal-700 text-white whitespace-nowrap">
                        剩餘庫存(無計劃量)
                      </td>
                      {periods.map((p) => {
                        const val = Number(p.remainingNoPlan);
                        return (
                          <td key={p.periodIndex} className={`px-2 py-1.5 text-right font-mono border-r border-slate-200 ${
                            val < 0 ? 'bg-red-100 text-red-800 font-bold' : 'bg-teal-50 text-teal-900'
                          }`}>
                            {val.toLocaleString()}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Plan editing section */}
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
                            edit?.sourceUrl ? (
                              <a href={edit.sourceUrl} target="_blank" rel="noopener noreferrer"
                                className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700 transition-colors">
                                生產計畫{edit.sourcePlanNo ? `（${edit.sourcePlanNo}）` : ''}
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

                        {edit?.transferStatus === TRANSFER_STATUS.UNKNOWN && (
                          <TransferReconciliationControls
                            key={`${item.mrpRunId}:${partVersion}:${seq}`}
                            runId={item.mrpRunId}
                            partVersion={partVersion}
                            planSequence={seq}
                            disabled={isReadOnly}
                            onResolved={async () => {
                              await fetchPeriods();
                              await onDataChange();
                            }}
                          />
                        )}

                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 text-xs">
                          {/* #N目標開始期 */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">#{seq}目標開始期</label>
                            <input type="number" min="0" max="12"
                              value={edit?.startPeriod || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                const periodNum = parseInt(val, 10);
                                let autoDate = edit?.completionDate || '';
                                if (periodNum > 0 && periodNum <= periods.length) {
                                  const p = periods[periodNum - 1];
                                  if (p?.periodLabel) {
                                    // Parse "2026/03" → 1st of that month − 7 days
                                    const [y, m] = p.periodLabel.split('/').map(Number);
                                    const d = new Date(y, m - 1, 1);
                                    d.setDate(d.getDate() - 7);
                                    autoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                                  }
                                }
                                setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, startPeriod: val, completionDate: autoDate } }));
                              }}
                              disabled={isLocked}
                              className={`w-full px-2 py-1.5 border rounded text-xs font-mono disabled:bg-slate-100 disabled:text-slate-500 ${planErrorFields[seq].has('startPeriod') ? 'bg-red-100 border-red-400' : 'border-slate-300'}`}
                              placeholder="期數" />
                          </div>

                          {/* #N滿足至?期數 */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">#{seq}滿足至?期數</label>
                            <input type="number" min="0" max="12" step="0.5"
                              value={edit?.fulfillPeriod || ''}
                              title={!autoRecalculatePlanQty ? '共用 ERP 庫存規劃保留共享池建議量；請手動確認數量' : undefined}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (!autoRecalculatePlanQty) {
                                  setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, fulfillPeriod: val } }));
                                  return;
                                }
                                const fp = parseFloat(val) || 0;
                                const bp = parseFloat(edit?.bufferPct || '0') || 0;
                                let priorQty = 0;
                                for (let s = 1; s < seq; s++) priorQty += parseFloat(planEdits[s]?.qty || '0') || 0;
                                const autoQty = computeFulfillmentPlanQty(periods, fp, bp, priorQty);
                                setPlanEdits((prev) => {
                                  const next = { ...prev, [seq]: { ...prev[seq]!, fulfillPeriod: val, qty: String(autoQty || '') } };
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
                              placeholder="期數" />
                          </div>

                          {/* [規劃#N]生產計畫量 */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]生產計畫量</label>
                            <input type="number" min="1" step="1" value={edit?.qty || ''}
                              onChange={(e) => {
                                const newQty = e.target.value;
                                if (!autoRecalculatePlanQty) {
                                  setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, qty: newQty } }));
                                  return;
                                }
                                setPlanEdits((prev) => {
                                  const next = { ...prev, [seq]: { ...prev[seq]!, qty: newQty } };
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
                              placeholder="數量" />
                          </div>

                          {/* [規劃#N]完成日期 */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]完成日期</label>
                            <input type="date" value={edit?.completionDate || ''}
                              onChange={(e) => setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, completionDate: e.target.value } }))}
                              disabled={isLocked}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs disabled:bg-slate-100 disabled:text-slate-500" />
                          </div>

                          {/* [規劃#N]預計用料重kg — read-only */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">[規劃#{seq}]預計用料重kg</label>
                            <input type="text" readOnly
                              value={(() => {
                                const q = parseFloat(edit?.qty || '0') || 0;
                                const kg = computeMaterialKg(q, mainMaterialKg, unitWeightG);
                                return kg > 0 ? kg.toFixed(3) : '';
                              })()}
                              className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs font-mono bg-slate-50 text-slate-500"
                              placeholder="kg" />
                          </div>

                          {/* 加量% */}
                          <div>
                            <label className="block text-slate-500 mb-1 whitespace-nowrap">加量%</label>
                            <div className="flex items-center gap-1">
                              <input type="number" min="0" max="100" step="1"
                                value={edit?.bufferPct || ''}
                                title={!autoRecalculatePlanQty ? '共用 ERP 庫存規劃保留共享池建議量；請手動確認數量' : undefined}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (!autoRecalculatePlanQty) {
                                    setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, bufferPct: val } }));
                                    return;
                                  }
                                  const bp = parseFloat(val) || 0;
                                  const fp = parseFloat(edit?.fulfillPeriod || '0') || 0;
                                  let priorQty = 0;
                                  for (let s = 1; s < seq; s++) priorQty += parseFloat(planEdits[s]?.qty || '0') || 0;
                                  const autoQty = fp > 0 ? computeFulfillmentPlanQty(periods, fp, bp, priorQty) : 0;
                                  setPlanEdits((prev) => {
                                    const next = { ...prev, [seq]: { ...prev[seq]!, bufferPct: val, ...(fp > 0 ? { qty: String(autoQty || '') } : {}) } };
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
                                placeholder="%" />
                              <span className="text-slate-400">%</span>
                            </div>
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-end gap-2 col-span-1">
                            {!isTransferred && !edit?.isSaved && (
                              <button onClick={() => handlePlanSave(seq)} disabled={isSaving || !edit?.qty || planErrors[seq].length > 0 || priorUnsaved || isReadOnly}
                                title={priorUnsaved ? `請先儲存規劃#${seq - 1}` : undefined}
                                className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed whitespace-nowrap">
                                {isSaving ? '...' : '儲存'}
                              </button>
                            )}
                            {edit?.isSaved && !isTransferred && !transferBlocked && (
                              <>
                                <button onClick={() => setPlanEdits((prev) => ({ ...prev, [seq]: { ...prev[seq]!, isSaved: false } }))}
                                  disabled={isReadOnly}
                                  className="px-3 py-1.5 border border-slate-400 text-slate-600 rounded text-xs hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
                                  編輯#{seq}
                                </button>
                                <button onClick={() => handleTransfer(seq)} disabled={isSaving || isReadOnly}
                                  className="px-3 py-1.5 bg-amber-500 text-white rounded text-xs hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed whitespace-nowrap">
                                  {isSaving ? '...' : `建立生產計畫#${seq}`}
                                </button>
                              </>
                            )}
                            {isTransferred && (
                              <ProductionPlanWorkOrderAction
                                transferId={edit?.transferId}
                                sourceRecordId={edit?.sourceRecordId}
                                sourcePlanNo={edit?.sourcePlanNo}
                                sourceUrl={edit?.sourceUrl}
                                initialStatus={edit?.workOrderStatus}
                                initialError={edit?.workOrderError}
                                disabled={isReadOnly}
                                onChange={(update) => {
                                  setPlanEdits((current) => ({
                                    ...current,
                                    [seq]: { ...current[seq]!, ...update },
                                  }));
                                  setSuggestions((current) => current.map((suggestion) => (
                                    suggestion.planSequence === seq
                                      ? { ...suggestion, ...update }
                                      : suggestion
                                  )));
                                  void onDataChange();
                                }}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Shared helpers
// ============================================================

function PeriodRow({ label, periods, field, bgClass, cellBg, highlight }: {
  label: string;
  periods: PeriodDetail[];
  field: keyof PeriodDetail;
  bgClass: string;
  cellBg: string;
  highlight?: boolean;
}) {
  return (
    <tr className="border-b border-slate-200">
      <td className={`sticky left-0 z-10 px-3 py-1.5 font-bold border-r-2 border-slate-400 whitespace-nowrap ${bgClass}`}>
        {label}
      </td>
      {periods.map((p) => {
        const val = Number(p[field]);
        return (
          <td key={p.periodIndex} className={`px-2 py-1.5 text-right font-mono border-r border-slate-200 ${cellBg} ${
            highlight && val > 0 ? 'text-orange-700 font-semibold' : ''
          }`}>
            {val.toLocaleString()}
          </td>
        );
      })}
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styleMap: Record<string, string> = {
    '未儲存': 'bg-slate-100 text-slate-600',
    '已儲存': 'bg-blue-100 text-blue-700',
    '待確認': 'bg-amber-100 text-amber-800',
    '已轉單': 'bg-green-100 text-green-700',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${styleMap[status] || 'bg-slate-100 text-slate-600'}`}>
      {status === '已轉單' ? '已建立生產計畫' : status}
    </span>
  );
}

function itemToEditFields(item: PlanItem): EditFields {
  return {
    targetStartPeriod: String(item.targetStartPeriod ?? ''),
    fulfillToPeriod: String(item.fulfillToPeriod != null ? Number(item.fulfillToPeriod) : ''),
    suggestedQty: String(item.suggestedQty != null ? Number(item.suggestedQty) : ''),
    completionDate: item.completionDate ? String(item.completionDate).split('T')[0] : '',
    bufferPct: String(item.bufferPct != null ? (Number(item.bufferPct) * 100).toFixed(0) : ''),
  };
}
