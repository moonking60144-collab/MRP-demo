'use client';

import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GripHorizontal,
  Pencil,
  RotateCw,
  Save,
  X,
} from 'lucide-react';
import { cacheIsFresh, cachePeek, cacheSet } from '@/lib/swr-cache';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { ISSUED_QTY_ERROR_LABELS, type IssuedQtyError } from '@/lib/mrp/work-order-bom-usage';
import {
  formatComponentWeeklyLeadTime,
  hasKnownComponentWeeklyLeadTime,
  presentComponentWeeklyPurchaseAction,
  presentComponentWeeklyShortage,
  type ComponentWeeklyDecisionSummary,
  type ComponentWeeklyDecisionTone,
} from '@/lib/mrp/component-weekly-purchase';
import { resolveComponentWeeklyMovementInventoryFeedback } from '@/lib/mrp/component-weekly-movement-feedback';
import { buildSourceRecordUrl, type SourceRecordType } from '@/lib/source-record-links';
import { Loader } from './ui/loader';
import { readPurchaseLeadTimeResponse } from '@/lib/component-weekly-lead-time-response';

const MIN_WEEKLY_PANE_HEIGHT = 104;
const MIN_DETAIL_PANE_HEIGHT = 144;
const SPLITTER_KEYBOARD_STEP = 32;

export type ComponentWeeklyUsageDetailTab =
  | 'calculation'
  | 'work-orders'
  | 'inventory'
  | 'supply'
  | 'movements';

export type ComponentWeeklyUsageMetric =
  | 'avgWeeklyUsage'
  | 'badStock'
  | 'consumedQty'
  | 'grossIssuedQty'
  | 'initialStock'
  | 'netIssuedQty'
  | 'overIssuedQty'
  | 'plannedUsage'
  | 'purchaseLeadWeeks'
  | 'receipts'
  | 'remainingStock'
  | 'remainingUsage'
  | 'reservedQty'
  | 'returnedQty'
  | 'shortageStartWeek'
  | 'stockWeeks'
  | 'supplyQty'
  | 'usage'
  | 'weeksUntilOrder';

export interface ComponentWeeklyUsageTarget {
  materialPartNo: string;
  mrpType: string;
  mrpRunId: number;
  dbSource?: string;
  weekIndex: number | null;
  weekLabel: string;
  initialTab?: ComponentWeeklyUsageDetailTab;
  focusMetric?: ComponentWeeklyUsageMetric;
}

interface UsageDetailRow {
  sourceRecordId: string | null;
  workOrderSourceRecordId: string | null;
  woNumber: string | null;
  finishedErpPartNo: string | null;
  workOrderStatus: string | null;
  startDate: string | null;
  scheduleStartDate: string | null;
  bomStartDate: string | null;
  dateSource: 'work_order' | 'bom' | 'missing';
  dateMismatch: boolean;
  plannedUsage: number;
  grossIssuedQty: number | null;
  consumedQty: number | null;
  returnedQty: number | null;
  netIssuedQty: number | null;
  reservedQty: number | null;
  remainingUsage: number | null;
  overIssuedQty: number;
  unit: string | null;
  alreadyPicked: string | null;
  issuedQtyState: string;
  issuedDetailCount: number;
  movementState: string;
  movementDetailCount: number;
  settlementState: 'not_issued' | 'reserved' | 'pending' | 'settled' | 'returned' | 'unknown';
  sourceAnomaly: string | null;
  reason: string | null;
  status: 'not_issued' | 'partial' | 'fully_issued' | 'over_issued' | 'unknown';
}

interface WeeklyProjectionRow {
  weekIndex: number;
  weekLabel: string | null;
  weekStart: string | null;
  openingStock: number;
  receipts: number;
  usage: number;
  calculatedEndingStock: number;
  endingStock: number;
  difference: number;
}

interface InventoryLotRow {
  sourceRecordId: string;
  lotNo: string | null;
  warehouseCode: string | null;
  qualityStatus: string | null;
  stockStatus: string | null;
  stockPc: number;
  stockKg: number;
  sourceWorkOrderNo: string | null;
  sourceWorkOrderSourceRecordId: string | null;
}

interface PurchaseOrderRow {
  sourceRecordId: string | null;
  productNo: string | null;
  deliveryDate: string | null;
  unreceivedQty: number;
  category: string | null;
  status: string | null;
  isOverdue: boolean;
  arrivesAfterShortage: boolean;
  countsAsProjectedSupply: boolean;
  requiresExpedite: boolean;
  inSelectedScope: boolean;
}

interface SupplyWorkOrderRow {
  sourceRecordId: string | null;
  woNumber: string | null;
  erpPartNo: string | null;
  endDate: string | null;
  woQty: number;
  status: string | null;
}

interface MovementRow {
  sourceRecordId: string;
  workOrderNo: string;
  bomItemKey: string | null;
  inventoryLotNo: string | null;
  componentNo: string | null;
  movementDate: string | null;
  basisType: string | null;
  movementType: string | null;
  inputUnit: string | null;
  inputQtyPc: number | null;
  inputQtyKg: number | null;
  movementQtyPc: number | null;
  movementQtyKg: number | null;
}

interface MaterialSummary extends Omit<ComponentWeeklyDecisionSummary, 'mrpType'> {
  unit: string | null;
  initialStock: number;
  badStock: number;
  supplyQty: number;
  plannedUsage: number;
  grossIssuedQty: number | null;
  consumedQty: number | null;
  returnedQty: number | null;
  netIssuedQty: number | null;
  reservedQty: number | null;
  remainingUsage: number | null;
  overIssuedQty: number;
  avgWeeklyUsage: number;
  stockWeeks: number;
  movementState: 'known' | 'fallback' | 'mixed' | 'unknown';
  expeditePurchaseQty: number;
  expeditePurchaseCount: number;
}

interface InventorySource {
  sourceRecordId: string | null;
  erpPartNo: string;
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean | null;
  ambiguous: boolean;
  candidateCount: number;
}

interface UsageDetailResponse {
  materialPartNo: string;
  mrpType: string;
  runId: number;
  dbSource: string | null;
  runVersionCode: string;
  runDate: string;
  usesLegacyPurchaseProjection: boolean;
  weekIndex: number | null;
  weekLabel: string | null;
  weekStart: string | null;
  inventorySource: InventorySource | null;
  materialSummary: MaterialSummary;
  weeklyProjection: WeeklyProjectionRow[];
  inventoryLots: InventoryLotRow[];
  purchaseOrders: PurchaseOrderRow[];
  supplyWorkOrders: SupplyWorkOrderRow[];
  movements: MovementRow[];
  movementContext: MovementRow[];
  unscheduledDemand: {
    count: number;
    qty: number;
  };
  included: UsageDetailRow[];
  excluded: UsageDetailRow[];
  includedTotal: number;
  expectedUsage: number;
  difference: number;
  reconciled: boolean;
  unitMismatchCount: number;
}

function detailKey(target: ComponentWeeklyUsageTarget): string {
  const params = new URLSearchParams({
    mrpType: target.mrpType,
    runId: String(target.mrpRunId),
    weekIndex: target.weekIndex === null ? 'all' : String(target.weekIndex),
  });
  if (target.dbSource) params.set('dbSource', target.dbSource);
  return `/api/component-weekly/${encodeURIComponent(target.materialPartNo)}/usage-details?${params}`;
}

function formatNumber(value: number | string | null, maximumFractionDigits = 3): string {
  if (value === null) return '—';
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '—';
  return numericValue.toLocaleString(undefined, { maximumFractionDigits });
}

function formatDate(value: string | Date | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function decisionToneClasses(tone: ComponentWeeklyDecisionTone): string {
  if (tone === 'danger') return 'border-red-200 bg-red-50 text-red-800';
  if (tone === 'warning') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (tone === 'info') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (tone === 'safe') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function reasonLabel(row: UsageDetailRow): string {
  if (row.reason === 'fully_issued') return '已領足，剩餘用量為 0';
  if (row.reason === 'unit_mismatch') return 'BOM 單位與計算單位不一致，未納入 MRP';
  if (row.reason === 'over_issued') {
    return `淨領用超過 BOM ${formatNumber(row.overIssuedQty)} ${row.unit || ''}`.trim();
  }
  if (row.reason && row.reason in ISSUED_QTY_ERROR_LABELS) {
    return ISSUED_QTY_ERROR_LABELS[row.reason as IssuedQtyError];
  }
  return row.reason || '—';
}

function rowStatus(row: UsageDetailRow) {
  if (row.status === 'not_issued') {
    return <span className="inline-flex rounded-sm bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">待領用</span>;
  }
  if (row.status === 'partial') {
    return <span className="inline-flex rounded-sm bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">部分領用</span>;
  }
  if (row.status === 'fully_issued') {
    return <span className="inline-flex rounded-sm bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">已領足</span>;
  }
  if (row.status === 'over_issued') {
    return <span className="inline-flex rounded-sm bg-orange-100 px-1.5 py-0.5 font-medium text-orange-800">{reasonLabel(row)}</span>;
  }
  return <span className="inline-flex rounded-sm bg-red-100 px-1.5 py-0.5 font-medium text-red-700">{reasonLabel(row)}</span>;
}

function settlementStatus(row: UsageDetailRow) {
  if (row.settlementState === 'not_issued') {
    return <span className="inline-flex rounded-sm bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">尚未領料</span>;
  }
  if (row.settlementState === 'reserved') {
    return <span className="inline-flex rounded-sm bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">保留未耗用</span>;
  }
  if (row.settlementState === 'pending') {
    return <span className="inline-flex rounded-sm bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">本 Run 待結算</span>;
  }
  if (row.settlementState === 'settled') {
    return <span className="inline-flex rounded-sm bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">已結算</span>;
  }
  if (row.settlementState === 'returned') {
    return <span className="inline-flex rounded-sm bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">已退清</span>;
  }
  return <span className="inline-flex rounded-sm bg-red-100 px-1.5 py-0.5 font-medium text-red-700">歸屬待確認</span>;
}

function SourceLink({
  type,
  recordId,
  label,
}: {
  type: SourceRecordType;
  recordId: string | null;
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

function movementQty(row: MovementRow, unit: string | null): number | null {
  return unit?.trim().toLowerCase() === 'kg' ? row.movementQtyKg : row.movementQtyPc;
}

export function ComponentWeeklyUsageDrawer({
  target,
  onClose,
}: {
  target: ComponentWeeklyUsageTarget;
  onClose: () => void;
}) {
  const { selectedRunId, isLatestSelected } = useMrpVersion();
  const readOnly = !isLatestSelected || selectedRunId !== target.mrpRunId;
  const key = useMemo(() => detailKey(target), [target]);
  const initial = cachePeek<UsageDetailResponse>(key) ?? null;
  const [data, setData] = useState<UsageDetailResponse | null>(initial);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ComponentWeeklyUsageDetailTab>(target.initialTab ?? 'work-orders');
  const [focusMetric, setFocusMetric] = useState<ComponentWeeklyUsageMetric | null>(
    target.focusMetric ?? null,
  );
  const [workOrderScope, setWorkOrderScope] = useState<'included' | 'excluded'>('included');
  const [retryToken, setRetryToken] = useState(0);
  const [weeklyPaneHeight, setWeeklyPaneHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [leadTimeEditorOpen, setLeadTimeEditorOpen] = useState(false);
  const [leadTimeDraft, setLeadTimeDraft] = useState('');
  const [leadTimeSaving, setLeadTimeSaving] = useState(false);
  const [leadTimeError, setLeadTimeError] = useState<string | null>(null);
  const [leadTimeSuccess, setLeadTimeSuccess] = useState<string | null>(null);
  const [leadTimeUpdateCompleted, setLeadTimeUpdateCompleted] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const splitAreaRef = useRef<HTMLDivElement>(null);
  const weeklyPaneRef = useRef<HTMLElement>(null);
  const detailNavRef = useRef<HTMLElement>(null);
  const splitterRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const getWeeklyPaneLimits = useCallback(() => {
    const splitAreaHeight = splitAreaRef.current?.getBoundingClientRect().height ?? 0;
    const detailNavHeight = detailNavRef.current?.getBoundingClientRect().height ?? 0;
    const splitterHeight = splitterRef.current?.getBoundingClientRect().height ?? 0;
    return {
      min: MIN_WEEKLY_PANE_HEIGHT,
      max: Math.max(
        MIN_WEEKLY_PANE_HEIGHT,
        Math.floor(splitAreaHeight - detailNavHeight - splitterHeight - MIN_DETAIL_PANE_HEIGHT),
      ),
    };
  }, []);

  const clampWeeklyPaneHeight = useCallback((height: number) => {
    const limits = getWeeklyPaneLimits();
    return Math.min(limits.max, Math.max(limits.min, Math.round(height)));
  }, [getWeeklyPaneLimits]);

  const resizeWeeklyPaneByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentHeight = weeklyPaneRef.current?.getBoundingClientRect().height
      ?? weeklyPaneHeight
      ?? MIN_WEEKLY_PANE_HEIGHT;
    const limits = getWeeklyPaneLimits();
    let nextHeight: number | null = null;

    if (event.key === 'ArrowUp') nextHeight = currentHeight - SPLITTER_KEYBOARD_STEP;
    if (event.key === 'ArrowDown') nextHeight = currentHeight + SPLITTER_KEYBOARD_STEP;
    if (event.key === 'PageUp') nextHeight = currentHeight - SPLITTER_KEYBOARD_STEP * 3;
    if (event.key === 'PageDown') nextHeight = currentHeight + SPLITTER_KEYBOARD_STEP * 3;
    if (event.key === 'Home') nextHeight = limits.min;
    if (event.key === 'End') nextHeight = limits.max;
    if (nextHeight === null) return;

    event.preventDefault();
    setWeeklyPaneHeight(Math.min(limits.max, Math.max(limits.min, Math.round(nextHeight))));
  };

  const startWeeklyPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const startHeight = weeklyPaneRef.current?.getBoundingClientRect().height;
    if (!startHeight) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
    };
    setIsResizing(true);
  };

  const moveWeeklyPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    setWeeklyPaneHeight(clampWeeklyPaneHeight(
      resizeState.startHeight + event.clientY - resizeState.startY,
    ));
  };

  const stopWeeklyPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeStateRef.current = null;
    setIsResizing(false);
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const cached = cachePeek<UsageDetailResponse>(key);
    setData(cached ?? null);
    setLoading(!cached);
    setError(null);
    setTab(target.initialTab ?? 'work-orders');
    setFocusMetric(target.focusMetric ?? null);
    setWorkOrderScope(cached && cached.included.length === 0 && cached.excluded.length > 0 ? 'excluded' : 'included');
    setWeeklyPaneHeight(null);
    resizeStateRef.current = null;
    setIsResizing(false);
    setLeadTimeEditorOpen(false);
    setLeadTimeDraft('');
    setLeadTimeSaving(false);
    setLeadTimeError(null);
    setLeadTimeSuccess(null);
    setLeadTimeUpdateCompleted(false);
    if (cached && cacheIsFresh(key)) return;

    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(key, { signal: controller.signal });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || `明細讀取失敗 (${response.status})`);
        const responseSource = json.dbSource ?? undefined;
        if (
          json.materialPartNo !== target.materialPartNo
          || json.mrpType !== target.mrpType
          || json.runId !== target.mrpRunId
          || json.weekIndex !== target.weekIndex
          || responseSource !== target.dbSource
        ) {
          throw new Error('明細回應與選取的 MRP 資料不一致');
        }
        cacheSet(key, json);
        setData(json);
        setWorkOrderScope(json.included.length === 0 && json.excluded.length > 0 ? 'excluded' : 'included');
      } catch (loadError) {
        if ((loadError as Error).name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : '明細讀取失敗');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [key, retryToken, target]);

  useLayoutEffect(() => {
    if (!data || weeklyPaneHeight !== null || !weeklyPaneRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const height = weeklyPaneRef.current?.getBoundingClientRect().height;
      if (height) setWeeklyPaneHeight(clampWeeklyPaneHeight(height));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [clampWeeklyPaneHeight, data, weeklyPaneHeight]);

  useEffect(() => {
    if (!data) return;
    const resize = () => {
      setWeeklyPaneHeight((currentHeight) => {
        if (currentHeight === null) return currentHeight;
        return clampWeeklyPaneHeight(currentHeight);
      });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [clampWeeklyPaneHeight, data]);

  const rows = data?.[workOrderScope] ?? [];
  const unit = data?.materialSummary.unit || '';
  const selectedProjection = data?.weeklyProjection.find((row) => row.weekIndex === target.weekIndex) ?? null;
  const decisionSummary: ComponentWeeklyDecisionSummary | null = data
    ? { ...data.materialSummary, mrpType: data.mrpType }
    : null;
  const shortagePresentation = decisionSummary
    ? presentComponentWeeklyShortage(decisionSummary)
    : null;
  const purchasePresentation = decisionSummary
    ? presentComponentWeeklyPurchaseAction(decisionSummary)
    : null;
  const leadTimeKnown = data?.inventorySource
    ? hasKnownComponentWeeklyLeadTime(data.inventorySource)
    : decisionSummary
      ? hasKnownComponentWeeklyLeadTime(decisionSummary)
      : false;

  const openLeadTimeEditor = () => {
    if (!data?.inventorySource) return;
    setLeadTimeDraft(
      hasKnownComponentWeeklyLeadTime(data.inventorySource)
        ? String(data.inventorySource.purchaseLeadWeeks)
        : '',
    );
    setLeadTimeError(null);
    setLeadTimeSuccess(null);
    setLeadTimeEditorOpen(true);
  };

  const saveLeadTime = async (clearValue: boolean) => {
    if (!data?.inventorySource?.sourceRecordId || leadTimeSaving) return;
    const draftValue = Number(leadTimeDraft);
    if (
      !clearValue
      && (
        leadTimeDraft.trim() === ''
        || !Number.isInteger(draftValue)
        || draftValue < 0
        || draftValue > 260
      )
    ) {
      setLeadTimeError('請輸入 0 到 260 的整數週數；要移除設定請按「清除設定」。');
      return;
    }

    setLeadTimeSaving(true);
    setLeadTimeError(null);
    setLeadTimeSuccess(null);
    try {
      const params = new URLSearchParams({
        runId: String(data.runId),
        mrpType: data.mrpType,
      });
      if (data.dbSource) params.set('dbSource', data.dbSource);
      const response = await fetch(
        `/api/component-weekly/${encodeURIComponent(data.materialPartNo)}/purchase-lead-time?${params}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceRecordId: data.inventorySource.sourceRecordId,
            expectedPurchaseLeadWeeks: data.inventorySource.purchaseLeadWeeks,
            expectedConfigured: data.inventorySource.purchaseLeadWeeksConfigured,
            purchaseLeadWeeks: clearValue ? null : draftValue,
          }),
        },
      );
      const result = await readPurchaseLeadTimeResponse(response);

      const currentLabel = result.purchaseLeadWeeksConfigured
        ? `${result.purchaseLeadWeeks} 週`
        : '未設定';
      setLeadTimeSuccess(
        result.updated
          ? `Source 已更新為「${currentLabel}」；本 Run 仍保留原快照，建立下一個 Run 後才會套用。`
          : `Source 已是「${currentLabel}」，沒有重複寫入；本 Run 不需變更。`,
      );
      setLeadTimeUpdateCompleted(Boolean(result.updated));
      setLeadTimeEditorOpen(false);
    } catch (saveError) {
      setLeadTimeError(saveError instanceof TypeError
        ? '連線中斷，前置期更新結果無法確認；請先開啟 Source 原單核對，確認前不要重送。'
        : saveError instanceof Error ? saveError.message : '前置期更新失敗');
    } finally {
      setLeadTimeSaving(false);
    }
  };

  const summaryMetrics = data
    ? ([
        ['可用庫存', data.materialSummary.initialStock, 'inventory', 'initialStock'],
        [
          data.mrpType === 'D' ? '工令供給' : '採購未交',
          data.materialSummary.supplyQty,
          'supply',
          'supplyQty',
        ],
        ['工令需求', data.materialSummary.plannedUsage, 'work-orders', 'plannedUsage'],
        ['總領用', data.materialSummary.grossIssuedQty, 'work-orders', 'grossIssuedQty'],
        ['帳面出庫淨額', data.materialSummary.consumedQty, 'movements', 'consumedQty'],
        ['正式退料', data.materialSummary.returnedQty, 'movements', 'returnedQty'],
        ['淨領用', data.materialSummary.netIssuedQty, 'work-orders', 'netIssuedQty'],
        ['工令保留', data.materialSummary.reservedQty, 'work-orders', 'reservedQty'],
        ['剩餘需求', data.materialSummary.remainingUsage, 'work-orders', 'remainingUsage'],
        ['淨領用超過 BOM', data.materialSummary.overIssuedQty, 'work-orders', 'overIssuedQty'],
        ['不良庫存', data.materialSummary.badStock, 'inventory', 'badStock'],
      ] as Array<[
        string,
        number | null,
        ComponentWeeklyUsageDetailTab,
        ComponentWeeklyUsageMetric,
      ]>)
    : [];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/30 p-3 sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="component-usage-title"
        className="relative flex h-full max-h-[calc(100dvh-1.5rem)] w-full max-w-[1440px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
        data-component-usage-drawer
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h3 id="component-usage-title" className="text-base font-bold text-slate-900">元件供需與工令領用明細</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">{target.materialPartNo}</span>
              <span>{target.weekIndex === null ? '全部週期' : data?.weekLabel || target.weekLabel}</span>
              <span>{data?.runVersionCode || `Run #${target.mrpRunId}`}</span>
              {target.dbSource && <span>來源：{target.dbSource}</span>}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="關閉元件供需明細"
            title="關閉"
          >
            <X size={16} />
          </button>
        </header>

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center"><Loader label="讀取元件供需明細" /></div>
        ) : error && !data ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle size={24} className="text-amber-600" />
            <p className="text-sm text-slate-700">{error}</p>
            <button
              type="button"
              onClick={() => setRetryToken((value) => value + 1)}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              <RotateCw size={14} />
              重新讀取
            </button>
          </div>
        ) : data ? (
          <>
            <div className="min-h-0 shrink overflow-y-auto overscroll-contain">
              <section className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 sm:grid-cols-4 xl:grid-cols-11">
              {summaryMetrics.map(([label, value, targetTab, metric]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setTab(targetTab);
                    setFocusMetric(metric);
                  }}
                  className={`border-b border-r border-slate-200 px-3 py-2.5 text-left hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 xl:border-b-0 ${
                    focusMetric === metric ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : ''
                  }`}
                  title={`查看${label}來源明細`}
                >
                  <div className="text-[11px] text-slate-500">{label}</div>
                  <div className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${
                    label === '淨領用超過 BOM' && Number(value) > 0 ? 'text-orange-700' : 'text-slate-900'
                  }`}>
                    {formatNumber(value)} <span className="text-[10px] font-normal text-slate-400">{unit}</span>
                  </div>
                </button>
              ))}
              </section>

              {data.unitMismatchCount > 0 && (
                <section className="flex items-center gap-1.5 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800 sm:px-5">
                  <AlertTriangle size={15} />
                  <span>
                    {data.unitMismatchCount} 筆 BOM 單位與本 Run 計算單位 {unit || '未知'} 不一致，已排除需求；原始數值未換算、未改標。
                  </span>
                </section>
              )}

              {data.unscheduledDemand.count > 0 && (
                <section className="flex items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900 sm:px-5">
                  <AlertTriangle size={15} />
                  <span>
                    此範圍包含 {data.unscheduledDemand.count} 筆未排程需求，共 {formatNumber(data.unscheduledDemand.qty)} {unit}；排程與 BOM 都沒有日期，因此保守列入前期。
                  </span>
                </section>
              )}

              <section className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs sm:px-5 ${
              data.materialSummary.movementState === 'known'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : data.materialSummary.movementState === 'unknown'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}>
              <div className="flex items-center gap-1.5">
                {data.materialSummary.movementState === 'known'
                  ? <CheckCircle2 size={15} />
                  : <AlertTriangle size={15} />}
                <span className="font-semibold">
                  {data.materialSummary.movementState === 'known'
                    ? '領用、帳面出庫、正式退料與工令保留已依本 Run 的移動快照計算；歷史 Run 不會因工令後續結案而回寫，請以正式退料與最新 Run 判讀'
                    : data.materialSummary.movementState === 'unknown'
                      ? '部分耗用／退料無法唯一歸屬，該工令不納入需求'
                      : data.materialSummary.movementState === 'mixed'
                        ? '部分工令依移動快照計算，其餘沿用 BOM 領料結果'
                      : '此 Run 尚無移動快照，沿用 BOM 領料結果'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-slate-600">
                <span>平均用量／週：<b className="font-mono">{formatNumber(data.materialSummary.avgWeeklyUsage)}</b></span>
                <span>庫存週數：<b className="font-mono">{formatNumber(data.materialSummary.stockWeeks, 1)}</b></span>
                <span>採購前置：<b className="font-mono">{formatComponentWeeklyLeadTime(decisionSummary!)}</b></span>
              </div>
              </section>

              {data.mrpType !== 'D' && shortagePresentation && purchasePresentation && (
                <section className="grid border-b border-slate-200 bg-white sm:grid-cols-3">
                <div className={`border-b px-4 py-2.5 sm:border-b-0 sm:border-r sm:px-5 ${decisionToneClasses(shortagePresentation.tone)}`}>
                  <div className="text-[11px] font-medium opacity-75">缺料時間</div>
                  <div className="mt-0.5 font-semibold">{shortagePresentation.label}</div>
                  {shortagePresentation.detail && (
                    <div className="mt-0.5 font-mono text-xs tabular-nums">{shortagePresentation.detail}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setTab(
                    data.materialSummary.purchaseAction === 'no_action'
                      || data.materialSummary.purchaseAction === 'lead_time_missing'
                      || data.materialSummary.purchaseAction === 'order_now'
                      || data.materialSummary.purchaseAction === 'plan_order'
                      ? 'calculation'
                      : 'supply',
                  )}
                  className={`border-b px-4 py-2.5 text-left hover:brightness-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 sm:border-b-0 sm:border-r sm:px-5 ${decisionToneClasses(purchasePresentation.tone)}`}
                  title="查看採購判斷依據"
                >
                  <div className="text-[11px] font-medium opacity-75">採購行動</div>
                  <div className="mt-0.5 font-semibold">{purchasePresentation.label}</div>
                  {purchasePresentation.detail && (
                    <div className="mt-0.5 text-xs">{purchasePresentation.detail}</div>
                  )}
                </button>
                <div className="px-4 py-2.5 text-slate-700 sm:px-5">
                  <div className="text-[11px] text-slate-500">判斷依據</div>
                  <div className="mt-0.5 font-semibold">
                    前置期 {formatComponentWeeklyLeadTime(data.materialSummary)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {data.usesLegacyPurchaseProjection && data.materialSummary.overduePurchaseCount > 0
                      ? `舊 Run 有逾期未交 ${data.materialSummary.overduePurchaseCount} 筆，當時仍計入週推供給`
                      : data.materialSummary.futurePurchaseCount > 0
                      ? `未交 PO ${data.materialSummary.futurePurchaseCount} 筆，最近 ${formatDate(data.materialSummary.nextPurchaseReceiptDate)}`
                      : '目前沒有可計入週推的未交 PO'}
                  </div>
                </div>
                </section>
              )}
            </div>

            <div ref={splitAreaRef} className="flex min-h-[327px] flex-1 flex-col sm:min-h-[303px]">
            <section
              ref={weeklyPaneRef}
              className={`flex shrink-0 flex-col ${weeklyPaneHeight === null ? 'h-44 sm:h-[34vh] sm:min-h-44 sm:max-h-72' : ''}`}
              style={weeklyPaneHeight === null
                ? undefined
                : { height: weeklyPaneHeight, minHeight: weeklyPaneHeight, maxHeight: weeklyPaneHeight }}
            >
              <div className="flex items-center justify-between px-4 py-2 sm:px-5">
                <h4 className="text-xs font-bold text-slate-700">週別供需平衡</h4>
                <div className={`flex items-center gap-1.5 text-xs font-semibold ${
                  data.reconciled ? 'text-emerald-700' : 'text-red-700'
                }`}>
                  {data.reconciled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                  <span>
                    {data.reconciled
                      ? `工令明細與表格一致：${formatNumber(data.expectedUsage)} ${unit}`
                      : `差異 ${formatNumber(data.difference)} ${unit}`}
                  </span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[860px] border-separate border-spacing-0 text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                    <tr>
                      <th className="border-y border-r border-slate-200 px-3 py-1.5 text-left">週別</th>
                      <th className="border-y border-r border-slate-200 px-3 py-1.5 text-left">週起始</th>
                      <th className="border-y border-r border-slate-200 px-3 py-1.5 text-right">期初</th>
                      <th className="border-y border-r border-slate-200 px-3 py-1.5 text-right">採購／工令進貨</th>
                      <th className="border-y border-r border-slate-200 px-3 py-1.5 text-right">工令剩餘需求</th>
                      <th className="border-y border-slate-200 px-3 py-1.5 text-right">期末</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.weeklyProjection.map((row) => (
                      <tr
                        key={row.weekIndex}
                        className={row.weekIndex === target.weekIndex ? 'bg-blue-50' : 'odd:bg-white even:bg-slate-50/70'}
                      >
                        <td className="border-b border-r border-slate-100 px-3 py-1.5 font-semibold">{row.weekLabel || `W${row.weekIndex}`}</td>
                        <td className="border-b border-r border-slate-100 px-3 py-1.5">{formatDate(row.weekStart)}</td>
                        <td className="border-b border-r border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums">{formatNumber(row.openingStock)}</td>
                        <td className={`border-b border-r border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums ${
                          row.weekIndex === target.weekIndex && focusMetric === 'receipts' ? 'ring-2 ring-inset ring-blue-400' : ''
                        }`}>{formatNumber(row.receipts)}</td>
                        <td className={`border-b border-r border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums ${
                          row.weekIndex === target.weekIndex && focusMetric === 'usage' ? 'ring-2 ring-inset ring-blue-400' : ''
                        }`}>{formatNumber(row.usage)}</td>
                        <td className={`border-b border-slate-100 px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${
                          row.endingStock < 0 ? 'bg-red-50 text-red-700' : ''
                        } ${
                          row.weekIndex === target.weekIndex && focusMetric === 'remainingStock' ? 'ring-2 ring-inset ring-blue-400' : ''
                        }`}>{formatNumber(row.endingStock)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div
              ref={splitterRef}
              role="separator"
              aria-label="調整週別供需表與下方明細的高度"
              aria-orientation="horizontal"
              aria-valuemin={getWeeklyPaneLimits().min}
              aria-valuemax={getWeeklyPaneLimits().max}
              aria-valuenow={Math.round(weeklyPaneHeight ?? MIN_WEEKLY_PANE_HEIGHT)}
              aria-valuetext="向上拖曳可顯示更多下方明細，向下拖曳可顯示更多週別"
              tabIndex={0}
              data-component-weekly-splitter
              onPointerDown={startWeeklyPaneResize}
              onPointerMove={moveWeeklyPaneResize}
              onPointerUp={stopWeeklyPaneResize}
              onPointerCancel={stopWeeklyPaneResize}
              onKeyDown={resizeWeeklyPaneByKeyboard}
              onDoubleClick={() => setWeeklyPaneHeight(null)}
              className={`group relative z-20 flex h-11 shrink-0 touch-none cursor-row-resize items-center justify-center border-y text-[10px] font-medium outline-none transition-colors sm:h-5 ${
                isResizing
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus-visible:border-blue-400 focus-visible:bg-blue-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400'
              }`}
              title="拖曳調整上下區域；雙擊重設。也可使用方向鍵、Page Up／Page Down、Home／End。"
            >
              <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-white px-2 py-0.5 shadow-sm">
                <GripHorizontal size={13} aria-hidden="true" />
                <span>拖曳調整</span>
              </span>
            </div>

            <nav ref={detailNavRef} className="flex shrink-0 items-center overflow-x-auto border-b border-slate-200 px-4 sm:px-5" aria-label="元件明細分類">
              {([
                ['calculation', '計算來源'],
                ['work-orders', `工令用料 ${data.included.length + data.excluded.length}`],
                ['inventory', `庫存批號 ${data.inventoryLots.length}`],
                ['supply', data.mrpType === 'D'
                  ? `工令供給 ${data.supplyWorkOrders.length}`
                  : `採購未交 ${data.purchaseOrders.length}`],
                ['movements', `耗用／退料 ${data.movements.length}`],
              ] as Array<[ComponentWeeklyUsageDetailTab, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  className={`shrink-0 border-b-2 px-3 py-2 text-xs font-semibold ${
                    tab === value
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-auto">
              {tab === 'calculation' && (
                <div className="grid gap-4 p-4 text-sm text-slate-700 lg:grid-cols-2 sm:p-5">
                  <section className="rounded border border-slate-200 bg-slate-50 p-4">
                    <h5 className="font-bold text-slate-900">週別庫存公式</h5>
                    {selectedProjection ? (
                      <>
                        <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 font-mono text-xs tabular-nums">
                          <span>期初庫存</span><b>{formatNumber(selectedProjection.openingStock)} {unit}</b>
                          <span>＋ 採購／工令進貨</span><b>{formatNumber(selectedProjection.receipts)} {unit}</b>
                          <span>－ 工令剩餘需求</span><b>{formatNumber(selectedProjection.usage)} {unit}</b>
                          <span className="border-t border-slate-300 pt-2">＝ 計算期末</span>
                          <b className="border-t border-slate-300 pt-2">{formatNumber(selectedProjection.calculatedEndingStock)} {unit}</b>
                          <span>MRP 儲存期末</span><b>{formatNumber(selectedProjection.endingStock)} {unit}</b>
                          <span>差異</span>
                          <b className={Math.abs(selectedProjection.difference) > 0.001 ? 'text-red-700' : 'text-emerald-700'}>
                            {formatNumber(selectedProjection.difference)} {unit}
                          </b>
                        </div>
                        <p className="mt-3 text-xs text-slate-500">
                          {selectedProjection.weekLabel || `W${selectedProjection.weekIndex}`} 的進貨、工令需求與期末值可由上方週別表及其他來源頁籤逐筆核對。
                        </p>
                      </>
                    ) : (
                      <p className="mt-3 text-xs text-slate-500">目前顯示全部週期；請由表格中的特定週別數字開啟，即可核對該週公式。</p>
                    )}
                  </section>
                  <section className="rounded border border-slate-200 bg-white p-4">
                    <h5 className="font-bold text-slate-900">缺料與採購判斷</h5>
                    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
                      <dt>平均用量／週</dt><dd className="font-mono font-bold">{formatNumber(data.materialSummary.avgWeeklyUsage)} {unit}</dd>
                      <dt>庫存週數</dt><dd className="font-mono font-bold">{formatNumber(data.materialSummary.stockWeeks, 1)}</dd>
                      <dt>採購前置期</dt><dd className="font-mono font-bold">{formatComponentWeeklyLeadTime(decisionSummary!)}</dd>
                      <dt>首個缺料點</dt>
                      <dd className={`text-right font-semibold ${shortagePresentation?.tone === 'danger' ? 'text-red-700' : ''}`}>
                        {shortagePresentation?.label || '—'}
                        {shortagePresentation?.detail && <span className="block font-mono font-normal">{shortagePresentation.detail}</span>}
                      </dd>
                      <dt>採購行動</dt>
                      <dd className={`text-right font-semibold ${purchasePresentation?.tone === 'danger' ? 'text-red-700' : ''}`}>
                        {purchasePresentation?.label || '—'}
                        {purchasePresentation?.detail && <span className="block font-normal">{purchasePresentation.detail}</span>}
                      </dd>
                      <dt>最晚下單日</dt><dd className="font-mono font-bold">{formatDate(data.materialSummary.orderByDate)}</dd>
                      <dt>逾期未交</dt>
                      <dd className={`font-mono font-bold ${data.materialSummary.overduePurchaseCount > 0 ? 'text-red-700' : ''}`}>
                        {data.materialSummary.overduePurchaseCount} 筆／{formatNumber(data.materialSummary.overduePurchaseQty)} {unit}
                      </dd>
                      <dt>未來未交</dt>
                      <dd className="text-right font-mono font-bold">
                        {data.materialSummary.futurePurchaseCount} 筆／{formatNumber(data.materialSummary.futurePurchaseQty)} {unit}
                        <span className="block font-sans font-normal text-slate-500">最近 {formatDate(data.materialSummary.nextPurchaseReceiptDate)}</span>
                      </dd>
                      <dt>需催交單據</dt>
                      <dd className={`text-right font-mono font-bold ${data.materialSummary.expeditePurchaseCount > 0 ? 'text-red-700' : ''}`}>
                        {data.materialSummary.expeditePurchaseCount} 筆／{formatNumber(data.materialSummary.expeditePurchaseQty)} {unit}
                      </dd>
                    </dl>
                    <div className={`mt-3 border-t pt-3 text-xs ${
                      data.inventorySource?.ambiguous
                        || !leadTimeKnown
                        ? 'border-amber-200 text-amber-900'
                        : 'border-slate-200 text-slate-600'
                    }`}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold">
                            {data.inventorySource?.ambiguous
                              ? `同一 ERP 料號有 ${data.inventorySource.candidateCount} 筆主檔來源`
                              : !leadTimeKnown
                                ? data.inventorySource?.purchaseLeadWeeksConfigured === null
                                  ? '舊 Run 未保存採購前置期設定狀態'
                                  : 'Source 料號主檔尚未設定採購前置期'
                                : '採購前置期來源：Source 料號主檔'}
                          </div>
                          {data.inventorySource?.ambiguous && (
                            <div className="mt-1 text-[11px] font-medium">
                              已停用主檔連結與前置期寫回；請先整理 Source 的重複 ERP 料號。
                            </div>
                          )}
                          <div className="mt-0.5 text-[11px] opacity-80">
                            {data.inventorySource
                              ? `${data.inventorySource.erpPartNo}／本 Run 快照 ${formatComponentWeeklyLeadTime(data.inventorySource)}`
                              : `${data.materialPartNo}／本 Run 找不到對應的料號主檔快照`}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {data.inventorySource?.sourceRecordId ? (
                            <SourceLink
                              type="inventory-master"
                              recordId={data.inventorySource.sourceRecordId}
                              label="開啟 Source 料號主檔"
                            />
                          ) : (
                            <span className="font-medium text-slate-400">無可用主檔連結</span>
                          )}
                          {!readOnly && data.mrpType !== 'D' && data.inventorySource?.sourceRecordId && (
                            <button
                              type="button"
                              onClick={openLeadTimeEditor}
                              disabled={leadTimeSaving || leadTimeUpdateCompleted}
                              className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2 py-1 font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                            >
                              <Pencil size={11} aria-hidden="true" />
                              {leadTimeUpdateCompleted ? '等待下一個 Run' : '在 MRP 設定'}
                            </button>
                          )}
                        </div>
                      </div>

                      {leadTimeEditorOpen && data.inventorySource && (
                        <div className="mt-3 rounded border border-blue-200 bg-blue-50/70 p-3 text-slate-700">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                            <label className="min-w-0 flex-1">
                              <span className="block text-[11px] font-semibold text-slate-700">採購前置期（整數週）</span>
                              <input
                                type="number"
                                min={0}
                                max={260}
                                step={1}
                                inputMode="numeric"
                                value={leadTimeDraft}
                                onChange={(event) => setLeadTimeDraft(event.target.value)}
                                disabled={leadTimeSaving}
                                autoFocus
                                className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-slate-100 sm:max-w-40"
                              />
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void saveLeadTime(false)}
                                disabled={leadTimeSaving}
                                className="inline-flex h-8 items-center gap-1.5 rounded bg-blue-600 px-3 font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-300"
                              >
                                {leadTimeSaving ? <RotateCw size={12} className="animate-spin" /> : <Save size={12} />}
                                寫入 Source
                              </button>
                              <button
                                type="button"
                                onClick={() => void saveLeadTime(true)}
                                disabled={leadTimeSaving}
                                className="h-8 rounded border border-amber-300 bg-white px-3 font-semibold text-amber-800 hover:bg-amber-50 disabled:cursor-wait disabled:text-amber-300"
                              >
                                清除設定
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setLeadTimeEditorOpen(false);
                                  setLeadTimeError(null);
                                }}
                                disabled={leadTimeSaving}
                                className="h-8 rounded border border-slate-300 bg-white px-3 font-semibold text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
                              >
                                取消
                              </button>
                            </div>
                          </div>
                          <p className="mt-2 text-[11px] leading-5 text-slate-500">
                            只更新 Source 料號主檔欄位；本 Run 是不可變快照，仍顯示目前數值，下一個 MRP Run 才會採用新設定。
                          </p>
                        </div>
                      )}

                      {leadTimeError && (
                        <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium leading-5 text-red-800">
                          {leadTimeError}
                        </div>
                      )}
                      {leadTimeSuccess && (
                        <div aria-live="polite" className="mt-3 flex items-start gap-1.5 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium leading-5 text-emerald-800">
                          <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                          <span>{leadTimeSuccess}</span>
                        </div>
                      )}
                    </div>
                    <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-500">
                      本表依本 Run 的良品庫存、未結採購與未結工令 BOM 剩餘需求推估；不含尚未轉成工令的預示量或生產計畫。
                      {data.usesLegacyPurchaseProjection
                        ? ' 此為舊 Run，週別數字保留當時曾將逾期 PO 計入供給的結果；請以新版 Run 判讀採購行動。'
                        : ' 逾期未交 PO 不當成已到貨，請至「採購未交」核對並開啟 Source 原單。'}
                    </p>
                  </section>
                </div>
              )}

              {tab === 'work-orders' && (
                <>
                  <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 sm:px-5">
                    {(['included', 'excluded'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setWorkOrderScope(value)}
                        className={`rounded border px-2.5 py-1 text-xs font-semibold ${
                          workOrderScope === value
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        {value === 'included'
                          ? `待領用需求 ${data.included.length}`
                          : `已領足／待確認 ${data.excluded.length}`}
                      </button>
                    ))}
                  </div>
                  {rows.length === 0 ? (
                    <div className="flex h-48 items-center justify-center text-sm text-slate-400">
                      此範圍沒有{workOrderScope === 'included' ? '待領用的' : '已領足或待確認的'}工令用料
                    </div>
                  ) : (
                    <table className="w-full min-w-[1460px] border-separate border-spacing-0 text-xs">
                      <thead className="sticky top-[41px] z-10 bg-slate-100 text-slate-600">
                        <tr>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">工令單號</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">完工 ERP 料號</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">工令指定開始日</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">原需求</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">總領用</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">帳面出庫淨額</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">正式退料</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">淨領用</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">工令保留</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">剩餘</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">耗用判讀</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">狀態</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-left">來源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={`${row.sourceRecordId || row.woNumber || 'row'}-${index}`} className="odd:bg-white even:bg-slate-50/70">
                            <td className="border-b border-slate-100 px-3 py-2 font-mono font-medium">
                              <SourceLink type="work-order" recordId={row.workOrderSourceRecordId} label={row.woNumber || '工令'} />
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 font-mono">{row.finishedErpPartNo || '—'}</td>
                            <td className="border-b border-slate-100 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-1.5" title={row.dateMismatch
                                ? `排程：${row.scheduleStartDate || '—'}；BOM：${row.bomStartDate || '—'}`
                                : undefined}
                              >
                                <span>{row.startDate || '未排程'}</span>
                                {row.dateMismatch && (
                                  <span className="border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                                    排程優先
                                  </span>
                                )}
                                {row.dateSource === 'bom' && (
                                  <span className="border border-slate-300 bg-slate-50 px-1 py-0.5 text-[10px] font-medium text-slate-600">
                                    BOM fallback
                                  </span>
                                )}
                                {row.dateSource === 'missing' && (
                                  <span className="border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                                    未排程 · 列入前期
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.plannedUsage)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.grossIssuedQty)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.consumedQty)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.returnedQty)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatNumber(row.netIssuedQty)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.reservedQty)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatNumber(row.remainingUsage)} {row.unit || ''}</td>
                            <td className="border-b border-slate-100 px-3 py-2">{settlementStatus(row)}</td>
                            <td className="border-b border-slate-100 px-3 py-2">{rowStatus(row)}</td>
                            <td className="border-b border-slate-100 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <SourceLink type="work-order-bom" recordId={row.sourceRecordId} label="BOM" />
                                {row.reason === 'unit_mismatch' && (
                                  <span className="inline-flex border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-800">
                                    單位異常
                                  </span>
                                )}
                                {row.sourceAnomaly === 'issue_state_mismatch' && (
                                  <span className="inline-flex border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                    主子表狀態不一致
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {tab === 'inventory' && (
                data.inventoryLots.length === 0 ? (
                  <div className="flex h-48 items-center justify-center text-sm text-slate-400">此 Run 沒有庫存批號快照</div>
                ) : (
                  <table className="w-full min-w-[860px] border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">庫存批號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">倉庫</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">品質／狀態</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">在庫 pc</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">在庫 kg</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">來源工令</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">來源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.inventoryLots.map((row) => (
                        <tr key={row.sourceRecordId} className="odd:bg-white even:bg-slate-50/70">
                          <td className="border-b border-slate-100 px-3 py-2 font-mono font-medium">{row.lotNo || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">{row.warehouseCode || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">{[row.qualityStatus, row.stockStatus].filter(Boolean).join(' / ') || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.stockPc)}</td>
                          <td className="border-b border-slate-100 px-3 py-2 text-right font-mono tabular-nums">{formatNumber(row.stockKg)}</td>
                          <td className="border-b border-slate-100 px-3 py-2 font-mono">
                            <SourceLink
                              type="work-order"
                              recordId={row.sourceWorkOrderSourceRecordId}
                              label={row.sourceWorkOrderNo || '—'}
                            />
                          </td>
                          <td className="border-b border-slate-100 px-3 py-2">
                            <SourceLink type="inventory-lot" recordId={row.sourceRecordId} label="批號" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {tab === 'supply' && data.mrpType !== 'D' && (
                data.purchaseOrders.length === 0 ? (
                  <div className="flex h-48 items-center justify-center text-sm text-slate-400">本 Run 沒有未結採購資料</div>
                ) : (
                  <table className="w-full min-w-[920px] border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">ERP 料號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">預定交貨日</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">未進貨量</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">週推判讀</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">類別</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">狀態</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">來源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.purchaseOrders.map((row, index) => (
                        <tr
                          key={`${row.sourceRecordId || 'po'}-${index}`}
                          className={row.isOverdue
                            ? 'bg-red-50/80'
                            : row.inSelectedScope
                              ? 'odd:bg-white even:bg-slate-50/70'
                              : 'bg-slate-50/40 text-slate-500'}
                        >
                          <td className="border-b border-slate-100 px-3 py-2 font-mono">{row.productNo || '—'}</td>
                          <td className={`border-b border-slate-100 px-3 py-2 ${row.isOverdue ? 'font-semibold text-red-700' : ''}`}>
                            {formatDate(row.deliveryDate)}
                          </td>
                          <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatNumber(row.unreceivedQty)} {unit}</td>
                          <td className="border-b border-slate-100 px-3 py-2">
                            {row.isOverdue ? (
                              <span className="inline-flex rounded-sm bg-red-100 px-1.5 py-0.5 font-semibold text-red-700">
                                {data.usesLegacyPurchaseProjection
                                  ? '逾期未交；舊 Run 曾計入供給'
                                  : '逾期未交，不計入供給'}
                              </span>
                            ) : row.requiresExpedite ? (
                              <span className="inline-flex rounded-sm bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">晚於缺貨點，需催交</span>
                            ) : row.countsAsProjectedSupply ? (
                              <span className="inline-flex rounded-sm bg-blue-100 px-1.5 py-0.5 font-semibold text-blue-700">
                                {row.inSelectedScope ? '計入所選週別' : '計入未來週別'}
                              </span>
                            ) : (
                              <span className="text-slate-400">不計入</span>
                            )}
                          </td>
                          <td className="border-b border-slate-100 px-3 py-2">{row.category || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">{row.status || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">
                            <SourceLink type="purchase-order" recordId={row.sourceRecordId} label="採購" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {tab === 'supply' && data.mrpType === 'D' && (
                data.supplyWorkOrders.length === 0 ? (
                  <div className="flex h-48 items-center justify-center text-sm text-slate-400">此範圍沒有工令供給資料</div>
                ) : (
                  <table className="w-full min-w-[760px] border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">工令單號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">完工 ERP 料號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">預計完成日</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">生產數量</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">狀態</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">來源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.supplyWorkOrders.map((row, index) => (
                        <tr key={`${row.sourceRecordId || 'wo'}-${index}`} className="odd:bg-white even:bg-slate-50/70">
                          <td className="border-b border-slate-100 px-3 py-2 font-mono font-medium">{row.woNumber || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2 font-mono">{row.erpPartNo || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">{formatDate(row.endDate)}</td>
                          <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatNumber(row.woQty)} {unit}</td>
                          <td className="border-b border-slate-100 px-3 py-2">{row.status || '—'}</td>
                          <td className="border-b border-slate-100 px-3 py-2">
                            <SourceLink type="work-order" recordId={row.sourceRecordId} label="工令" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {tab === 'movements' && (
                data.movements.length === 0 ? (
                  <div className="flex h-48 items-center justify-center px-6 text-center text-sm text-slate-400">
                    此範圍沒有耗用／退料快照；若上方顯示 fallback，代表此 Run 沿用 BOM 領料資料
                  </div>
                ) : (
                  <table className="w-full min-w-[1180px] border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">日期</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">工令單號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">基礎類型</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">異動</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">庫存批號</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">同單位異動量</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">本 Run 批號狀態</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">BOM 關聯鍵</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-left">來源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.movements.map((row) => {
                        const quantity = movementQty(row, data.materialSummary.unit);
                        const movementContextIndex = data.movementContext.findIndex(
                          (candidate) => candidate.sourceRecordId === row.sourceRecordId,
                        );
                        const inventoryFeedback = resolveComponentWeeklyMovementInventoryFeedback({
                          movement: row,
                          movementIndex: movementContextIndex,
                          movements: data.movementContext,
                          inventoryLots: data.inventoryLots,
                          unit: data.materialSummary.unit,
                        });
                        return (
                          <tr key={row.sourceRecordId} className="odd:bg-white even:bg-slate-50/70">
                            <td className="border-b border-slate-100 px-3 py-2">{formatDate(row.movementDate)}</td>
                            <td className="border-b border-slate-100 px-3 py-2 font-mono">{row.workOrderNo}</td>
                            <td className="border-b border-slate-100 px-3 py-2">{row.basisType || '—'}</td>
                            <td className="border-b border-slate-100 px-3 py-2">{row.movementType || '—'}</td>
                            <td className="border-b border-slate-100 px-3 py-2 font-mono">{row.inventoryLotNo || '—'}</td>
                            <td className={`border-b border-slate-100 px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                              quantity !== null && quantity < 0 ? 'text-red-700' : 'text-emerald-700'
                            }`}>{formatNumber(quantity)} {unit}</td>
                            <td className="border-b border-slate-100 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {inventoryFeedback.state === 'in_stock' && (
                                  <>
                                    <span className="inline-flex border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800">
                                      本 Run 在庫 {formatNumber(inventoryFeedback.availableQty)} {unit}
                                    </span>
                                    {inventoryFeedback.inventoryLots.map((inventoryLot) => (
                                      <SourceLink
                                        key={inventoryLot.sourceRecordId}
                                        type="inventory-lot"
                                        recordId={inventoryLot.sourceRecordId}
                                        label={[inventoryLot.warehouseCode, inventoryLot.qualityStatus]
                                          .filter(Boolean)
                                          .join(' / ') || '批號'}
                                      />
                                    ))}
                                  </>
                                )}
                                {inventoryFeedback.state === 'unavailable' && (
                                  <>
                                    <span className="inline-flex border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900">
                                      有庫存紀錄但不可用 {formatNumber(inventoryFeedback.currentQty)} {unit}
                                    </span>
                                    {inventoryFeedback.inventoryLots.map((inventoryLot) => (
                                      <SourceLink
                                        key={inventoryLot.sourceRecordId}
                                        type="inventory-lot"
                                        recordId={inventoryLot.sourceRecordId}
                                        label={[inventoryLot.warehouseCode, inventoryLot.qualityStatus, inventoryLot.stockStatus]
                                          .filter(Boolean)
                                          .join(' / ') || '批號'}
                                      />
                                    ))}
                                  </>
                                )}
                                {(inventoryFeedback.state === 'reissued' || inventoryFeedback.state === 'not_in_stock') && (
                                  <span className="text-slate-500">本 Run 不在庫</span>
                                )}
                                {inventoryFeedback.state === 'unknown' && (
                                  <span className="text-slate-400">無批號，無法核對</span>
                                )}
                                {inventoryFeedback.subsequentIssueWorkOrderNos.map((workOrderNo) => (
                                  <span
                                    key={workOrderNo}
                                    className="inline-flex border border-blue-300 bg-blue-50 px-1.5 py-0.5 font-medium text-blue-800"
                                  >
                                    退料後再領用 · {workOrderNo}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 font-mono text-slate-500">{row.bomItemKey || '—'}</td>
                            <td className="border-b border-slate-100 px-3 py-2">
                              <SourceLink type="inventory-movement" recordId={row.sourceRecordId} label="異動" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              )}
            </div>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
