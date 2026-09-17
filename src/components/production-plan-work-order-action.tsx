'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, Factory, Link2, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { cacheInvalidate } from '@/lib/swr-cache';
import { WORK_ORDER_STATUS, type WorkOrderStatus } from '@/lib/work-order-state';
import { subscribeWorkOrderStatus } from '@/lib/work-order-events-client';

export interface ProductionPlanWorkOrderUpdate {
  workOrderStatus: WorkOrderStatus;
  workOrderError: string | null;
  workOrderStartedAt?: string | null;
  workOrderCompletedAt?: string | null;
  sourceRecordId?: string | null;
  sourcePlanNo?: string | null;
  sourceUrl?: string | null;
}

function invalidateWorkOrderCaches() {
  cacheInvalidate((key) =>
    key.startsWith('/api/fg-monthly')
    || key.startsWith('/api/plan-management')
    || key.startsWith('/api/production-plans'),
  );
}

interface ProductionPlanWorkOrderActionProps {
  transferId: number | null | undefined;
  sourceRecordId: string | null | undefined;
  sourcePlanNo?: string | null;
  sourceUrl?: string | null;
  initialStatus?: WorkOrderStatus | null;
  initialError?: string | null;
  disabled?: boolean;
  compact?: boolean;
  onChange?: (update: ProductionPlanWorkOrderUpdate) => void;
}

export function ProductionPlanWorkOrderAction({
  transferId,
  sourceRecordId,
  sourcePlanNo,
  sourceUrl,
  initialStatus,
  initialError,
  disabled = false,
  compact = false,
  onChange,
}: ProductionPlanWorkOrderActionProps) {
  const confirmDialog = useConfirm();
  const showToast = useToast();
  const { isLatestSelected, setBusy } = useMrpVersion();
  const [status, setStatus] = useState<WorkOrderStatus>(initialStatus ?? WORK_ORDER_STATUS.IDLE);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [recordIdInput, setRecordIdInput] = useState('');
  const [linkedRecordId, setLinkedRecordId] = useState<string | null>(sourceRecordId ?? null);
  const [linkedPlanNo, setLinkedPlanNo] = useState<string | null>(sourcePlanNo ?? null);
  const [linkedUrl, setLinkedUrl] = useState<string | null>(sourceUrl ?? null);
  const onChangeRef = useRef(onChange);
  const statusRef = useRef(status);
  const errorRef = useRef(error);
  const busy = submitting || linking;

  useEffect(() => {
    const nextStatus = initialStatus ?? WORK_ORDER_STATUS.IDLE;
    setStatus(nextStatus);
    statusRef.current = nextStatus;
    setError(initialError ?? null);
    errorRef.current = initialError ?? null;
    setLinkedRecordId(sourceRecordId ?? null);
    setLinkedPlanNo(sourcePlanNo ?? null);
    setLinkedUrl(sourceUrl ?? null);
  }, [initialStatus, initialError, sourcePlanNo, sourceRecordId, sourceUrl, transferId]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!transferId) return;
    return subscribeWorkOrderStatus(transferId, (event) => {
      const previousStatus = statusRef.current;
      statusRef.current = event.workOrderStatus;
      errorRef.current = event.workOrderError;
      setStatus(event.workOrderStatus);
      setError(event.workOrderError);
      invalidateWorkOrderCaches();
      onChangeRef.current?.({
        workOrderStatus: event.workOrderStatus,
        workOrderError: event.workOrderError,
        workOrderStartedAt: event.workOrderStartedAt,
        workOrderCompletedAt: event.workOrderCompletedAt,
      });

      if (previousStatus === event.workOrderStatus) return;
      if (event.workOrderStatus === WORK_ORDER_STATUS.SUCCEEDED) {
        showToast({
          type: 'success',
          message: `生產計畫${linkedPlanNo ? ` ${linkedPlanNo}` : ''}的工令已產生完成。`,
          action: linkedUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(linkedUrl, '_blank') }
            : undefined,
        });
      } else if (event.workOrderStatus === WORK_ORDER_STATUS.FAILED) {
        showToast({ type: 'error', message: event.workOrderError || '工令產生失敗，可修正後重新排程。' });
      } else if (event.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN) {
        showToast({
          type: 'info',
          message: event.workOrderError || '工令產生結果待確認，系統不會自動重跑。',
          action: linkedUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(linkedUrl, '_blank') }
            : undefined,
        });
      }
    });
  }, [linkedPlanNo, linkedUrl, showToast, transferId]);

  useEffect(() => {
    if (!transferId) return;
    const key = `work-order-${transferId}`;
    setBusy(key, busy);
    return () => setBusy(key, false);
  }, [busy, setBusy, transferId]);

  useEffect(() => {
    if (!busy) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [busy]);

  const linkRecord = async () => {
    if (!transferId || !recordIdInput || disabled || !isLatestSelected || busy) return;
    const confirmed = await confirmDialog({
      title: '連結既有生產計畫',
      message: `系統只會唯讀核對 Record ${recordIdInput} 的客料版本、MRP 版本、數量與完成日，再補上本機連結。\n\n不會重新建立生產計畫，也不會執行 Button 92。`,
      confirmText: '驗證並連結',
    });
    if (!confirmed) return;

    setLinking(true);
    try {
      const response = await fetch(`/api/production-plans/${transferId}/record-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRecordId: recordIdInput }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '連結生產計畫失敗。');

      const linked = result.linked as {
        sourceRecordId: string;
        sourcePlanNo: string | null;
        sourceUrl: string;
        workOrderStatus: WorkOrderStatus;
        workOrderError: string | null;
      };
      setLinkedRecordId(linked.sourceRecordId);
      setLinkedPlanNo(linked.sourcePlanNo);
      setLinkedUrl(linked.sourceUrl);
      setStatus(linked.workOrderStatus);
      setError(linked.workOrderError);
      statusRef.current = linked.workOrderStatus;
      errorRef.current = linked.workOrderError;
      setLinkOpen(false);
      setRecordIdInput('');
      invalidateWorkOrderCaches();
      onChange?.({
        workOrderStatus: linked.workOrderStatus,
        workOrderError: linked.workOrderError,
        sourceRecordId: linked.sourceRecordId,
        sourcePlanNo: linked.sourcePlanNo,
        sourceUrl: linked.sourceUrl,
      });
      showToast({
        type: 'success',
        message: `已驗證並連結生產計畫${linked.sourcePlanNo ? ` ${linked.sourcePlanNo}` : ''}。`,
        action: { label: '開啟生產計畫', onClick: () => window.open(linked.sourceUrl, '_blank') },
      });
    } catch (linkError) {
      showToast({
        type: 'error',
        message: linkError instanceof Error ? linkError.message : '連結生產計畫失敗。',
        duration: 7000,
      });
    } finally {
      setLinking(false);
    }
  };

  const run = async () => {
    if (!transferId || !linkedRecordId || disabled || !isLatestSelected || busy) return;

    if (status !== WORK_ORDER_STATUS.UNKNOWN) {
      const confirmed = await confirmDialog({
        title: '產生工令單',
        message: `將把 Source 生產計畫${linkedPlanNo ? ` ${linkedPlanNo}` : ''}加入背景佇列，依序執行「載入製程並推估時間」。\n\n此動作會展開製程、計算時程並產生工令單。送出後可離開此頁，系統會持續執行並更新進度。`,
        confirmText: '加入背景佇列',
      });
      if (!confirmed) return;
    }

    setSubmitting(true);
    const statusAtSubmit = statusRef.current;
    try {
      const response = await fetch(`/api/production-plans/${transferId}/work-orders`, {
        method: 'POST',
      });
      const result = await response.json().catch(() => ({}));
      const responseStatus = (result.workOrderStatus ?? status) as WorkOrderStatus;
      const eventArrivedDuringRequest = statusRef.current !== statusAtSubmit;
      const nextStatus = responseStatus === WORK_ORDER_STATUS.QUEUED && eventArrivedDuringRequest
        ? statusRef.current
        : responseStatus;
      const nextError = nextStatus !== responseStatus
        ? errorRef.current
        : response.ok ? null : result.error || '產生工令單失敗。';
      statusRef.current = nextStatus;
      errorRef.current = nextError;
      setStatus(nextStatus);
      setError(nextError);
      invalidateWorkOrderCaches();
      onChange?.({ workOrderStatus: nextStatus, workOrderError: nextError });

      if (!response.ok) {
        showToast({
          type: nextStatus === WORK_ORDER_STATUS.UNKNOWN ? 'info' : 'error',
          message: result.error || '產生工令單失敗。',
          action: linkedUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(linkedUrl, '_blank') }
            : undefined,
        });
        return;
      }

      if (response.status === 202 || nextStatus === WORK_ORDER_STATUS.QUEUED) {
        showToast({
          type: 'info',
          message: '已加入背景佇列。系統會依序產生工令，現在可以離開此頁。',
          action: linkedUrl
            ? { label: '開啟生產計畫', onClick: () => window.open(linkedUrl, '_blank') }
            : undefined,
        });
        return;
      }

      showToast({
        type: 'success',
        message: result.alreadyGenerated ? 'Source 已有工令單，狀態已同步。' : '工令單產生完成。',
        action: linkedUrl
          ? { label: '開啟生產計畫', onClick: () => window.open(linkedUrl, '_blank') }
          : undefined,
      });
    } catch {
      try {
        const statusResponse = await fetch(`/api/production-plans/${transferId}/work-orders`);
        const current = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) throw new Error();
        const currentStatus = current.workOrderStatus as WorkOrderStatus;
        const currentError = (current.workOrderError ?? null) as string | null;
        statusRef.current = currentStatus;
        errorRef.current = currentError;
        setStatus(currentStatus);
        setError(currentError);
        onChangeRef.current?.({
          workOrderStatus: currentStatus,
          workOrderError: currentError,
          workOrderStartedAt: current.workOrderStartedAt ?? null,
          workOrderCompletedAt: current.workOrderCompletedAt ?? null,
        });
        showToast({
          type: 'info',
          message: currentStatus === WORK_ORDER_STATUS.QUEUED || currentStatus === WORK_ORDER_STATUS.PENDING
            ? '送出回應中斷，但背景工作已被系統接手，可離開頁面。'
            : currentError || '已重新讀取工令產生狀態。',
        });
      } catch {
        showToast({
          type: 'info',
          message: '目前無法確認是否已加入背景佇列；請重新整理「相關生產計劃」查看狀態。',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (status === WORK_ORDER_STATUS.SUCCEEDED) {
    return (
      <span
        data-testid="work-order-succeeded"
        className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded border border-emerald-300 bg-emerald-50 px-2 text-[11px] font-medium text-emerald-700"
        title="Source 生產計畫已產生工令單"
      >
        <CheckCircle2 size={13} aria-hidden="true" />
        工令已產生
      </span>
    );
  }

  if (!transferId) {
    return (
      <span className="text-[11px] text-slate-400" title="缺少本機轉單紀錄，無法產生工令單">
        無法產生工令
      </span>
    );
  }

  if (!linkedRecordId) {
    if (!linkOpen) {
      return (
        <button
          type="button"
          onClick={() => setLinkOpen(true)}
          disabled={disabled || !isLatestSelected || busy}
          title="生產計畫已建立，但 Source 成功回應未附 Record ID；可唯讀驗證後補上連結"
          className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2 size={13} aria-hidden="true" />
          補 Record ID
        </button>
      );
    }
    return (
      <div className="inline-flex items-center gap-1 whitespace-nowrap">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={recordIdInput}
          onChange={(event) => setRecordIdInput(event.target.value.replace(/\D/g, ''))}
          onKeyDown={(event) => { if (event.key === 'Enter') void linkRecord(); }}
          disabled={disabled || linking}
          placeholder="Record ID"
          aria-label="Source 生產計畫 Record ID"
          className="h-7 w-24 rounded border border-amber-300 bg-white px-1.5 font-mono text-[11px] outline-none focus:border-blue-500 disabled:bg-slate-100"
        />
        <button
          type="button"
          onClick={linkRecord}
          disabled={disabled || linking || !recordIdInput}
          className="inline-flex h-7 items-center gap-1 rounded border border-blue-600 bg-blue-600 px-2 text-[11px] font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
        >
          {linking ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
          驗證連結
        </button>
        <button
          type="button"
          onClick={() => { setLinkOpen(false); setRecordIdInput(''); }}
          disabled={linking}
          title="取消"
          aria-label="取消補 Record ID"
          className="inline-flex size-7 items-center justify-center rounded border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const isUnknown = status === WORK_ORDER_STATUS.UNKNOWN;
  const isQueued = status === WORK_ORDER_STATUS.QUEUED;
  const isRunning = status === WORK_ORDER_STATUS.PENDING;
  const isProcessing = isQueued || isRunning || submitting;
  const label = submitting
    ? '送出中…'
    : isQueued
      ? '排隊中'
      : isRunning
        ? 'Source 執行中'
    : isUnknown
      ? '檢查工令狀態'
      : status === WORK_ORDER_STATUS.FAILED
        ? '重新排程'
      : compact
        ? '產生工令'
        : '產生工令單';
  const Icon = submitting || isRunning
    ? LoaderCircle
    : isQueued
      ? Clock3
      : isUnknown
        ? RefreshCw
        : Factory;

  return (
    <button
      type="button"
      data-testid="generate-work-orders"
      onClick={run}
      disabled={disabled || !isLatestSelected || isProcessing}
      title={error || (isUnknown
        ? '只會重新讀取 Source 狀態，不會在結果不明時重跑 Button 92'
        : isQueued
          ? '已加入背景佇列，尚未輪到此筆'
          : isRunning
            ? 'Source 正在展開製程、推估時間並產生工令'
            : '加入背景佇列，在 Source 執行「載入製程並推估時間」')}
      className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        isUnknown
          ? 'border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100'
          : status === WORK_ORDER_STATUS.FAILED
            ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
            : isQueued
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
          : 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
      }`}
    >
      <Icon size={13} className={submitting || isRunning ? 'animate-spin' : ''} aria-hidden="true" />
      {label}
    </button>
  );
}
