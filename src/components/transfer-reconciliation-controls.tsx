'use client';

import { useEffect, useState } from 'react';
import { useConfirm } from './confirm-dialog';
import { useToast } from './toast';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { cacheInvalidate } from '@/lib/swr-cache';

interface ReconciliationResult {
  action: 'confirm_created' | 'confirm_not_created';
  transferStatus: 'succeeded' | 'failed';
  sourceRecordId: string | null;
  sourcePlanNo: string | null;
  sourceUrl: string | null;
}

interface ReconciliationCandidate {
  sourceRecordId: string;
  sourcePlanNo: string | null;
  suggestedQty: number;
  completionDate: string;
  createdAt: string | null;
  mrpSourceCode: string | null;
  sourceUrl: string;
}

interface InspectionResult {
  action: 'inspect';
  matchStatus: 'not_found' | 'single_match' | 'multiple_matches';
  candidates: ReconciliationCandidate[];
}

export function TransferReconciliationControls({
  runId,
  partVersion,
  planSequence,
  disabled = false,
  onResolved,
}: {
  runId: number;
  partVersion: string;
  planSequence: number;
  disabled?: boolean;
  onResolved: () => void | Promise<void>;
}) {
  const [recordId, setRecordId] = useState('');
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState<'confirm_created' | 'confirm_not_created' | null>(null);
  const confirmDialog = useConfirm();
  const showToast = useToast();
  const { setBusy } = useMrpVersion();
  const busyKey = `transfer-reconciliation:${runId}:${partVersion}:${planSequence}`;

  useEffect(() => {
    setBusy(busyKey, checking || submitting !== null);
    return () => setBusy(busyKey, false);
  }, [busyKey, checking, setBusy, submitting]);

  const inspectSource = async () => {
    setChecking(true);
    setInspectionError(null);
    try {
      const response = await fetch(
        `/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions/reconcile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, planSequence, action: 'inspect' }),
        },
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || '無法檢查 Source。');
      setInspection(json.inspection as InspectionResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : '無法檢查 Source。';
      setInspection(null);
      setInspectionError(message);
      showToast({ type: 'error', message, duration: 7000 });
    } finally {
      setChecking(false);
    }
  };

  const submit = async (
    action: 'confirm_created' | 'confirm_not_created',
    selectedRecordId?: string,
  ) => {
    setSubmitting(action);
    try {
      const response = await fetch(
        `/api/fg-monthly/${encodeURIComponent(partVersion)}/suggestions/reconcile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            planSequence,
            action,
            sourceRecordId: action === 'confirm_created' ? selectedRecordId : undefined,
          }),
        },
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || '轉單對帳失敗。');

      const result = json.reconciliation as ReconciliationResult;
      cacheInvalidate((key) =>
        key.startsWith('/api/fg-monthly')
        || key.startsWith('/api/plan-management')
        || key.startsWith('/api/production-plans'),
      );
      showToast({
        type: 'success',
        message: action === 'confirm_created'
          ? `已核對並連結 Source 生產計畫${result.sourcePlanNo ? ` ${result.sourcePlanNo}` : ''}。`
          : '已標記為未建單，可重新執行轉單。',
        action: result.sourceUrl
          ? { label: '開啟 Source', onClick: () => window.open(result.sourceUrl!, '_blank') }
          : undefined,
      });
      try {
        await onResolved();
      } catch {
        showToast({ type: 'info', message: '對帳已完成，但畫面同步失敗，請重新整理確認。' });
      }
    } catch (error) {
      showToast({
        type: 'error',
        message: error instanceof Error ? error.message : '轉單對帳失敗。',
        duration: 7000,
      });
    } finally {
      setSubmitting(null);
    }
  };

  const confirmCreated = async (selectedRecordId: string) => {
    if (!selectedRecordId) {
      showToast({ type: 'error', message: '請先輸入 Source Record ID。' });
      return;
    }
    const confirmed = await confirmDialog({
      title: '確認 Source 已建單',
      message: `系統會唯讀檢查 Record ${selectedRecordId} 的客料版本、數量、完成日，以及有保存時的 MRP 來源。全部吻合後，才會把規劃#${planSequence}標記為已轉單。`,
      confirmText: '驗證並連結',
    });
    if (confirmed) await submit('confirm_created', selectedRecordId);
  };

  const confirmNotCreated = async () => {
    const confirmed = await confirmDialog({
      title: '確認 Source 未建單',
      message: `請先在 Source 確認規劃#${planSequence}確實沒有建立生產計畫。確認後會解除鎖定，允許重新轉單。`,
      confirmText: '確認未建單',
      danger: true,
    });
    if (confirmed) await submit('confirm_not_created');
  };

  const isBusy = checking || submitting !== null;

  return (
    <div className="-mx-3 mb-3 space-y-2.5 border-y border-amber-200 bg-amber-50 px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-amber-950">
          上次建立時與 Source 連線中斷。系統已暫停重送，避免產生重複生產計畫。
        </div>
        <button
          type="button"
          onClick={inspectSource}
          disabled={disabled || isBusy}
          className="border border-amber-500 bg-white px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
        >
          {checking ? '檢查中...' : inspection ? '重新檢查 Source' : '檢查 Source 是否已建單'}
        </button>
      </div>

      {inspectionError && (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          {inspectionError}
        </div>
      )}

      {inspection?.matchStatus === 'not_found' && (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2">
          <div className="text-emerald-800">
            Source 目前找不到客料版本、數量與完成日相符的生產計畫。
          </div>
          <button
            type="button"
            onClick={confirmNotCreated}
            disabled={disabled || isBusy}
            className="border border-emerald-600 bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
          >
            {submitting === 'confirm_not_created' ? '再次確認中...' : '確認未建立，解除鎖定'}
          </button>
        </div>
      )}

      {inspection && inspection.candidates.length > 0 && (
        <div className="space-y-2 border border-blue-200 bg-blue-50 px-3 py-2">
          <div className="font-medium text-blue-900">
            {inspection.matchStatus === 'single_match'
              ? '找到 1 筆相符生產計畫，請確認後連結。'
              : `找到 ${inspection.candidates.length} 筆相符生產計畫，請選擇正確單據。`}
          </div>
          {inspection.candidates.map((candidate) => (
            <div
              key={candidate.sourceRecordId}
              className="flex flex-wrap items-center justify-between gap-2 border border-blue-100 bg-white px-2.5 py-2"
            >
              <div className="text-slate-700">
                <span className="font-semibold text-slate-900">
                  {candidate.sourcePlanNo || `Record ${candidate.sourceRecordId}`}
                </span>
                <span className="ml-2">#{candidate.sourceRecordId}</span>
                <span className="ml-2">{candidate.suggestedQty.toLocaleString()} ／ {candidate.completionDate}</span>
                {candidate.createdAt && <span className="ml-2 text-slate-500">建立 {candidate.createdAt}</span>}
                {!candidate.mrpSourceCode && (
                  <span className="ml-2 text-amber-700">MRP 來源欄未保存</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => confirmCreated(candidate.sourceRecordId)}
                disabled={disabled || isBusy}
                className="border border-blue-600 bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
              >
                {submitting === 'confirm_created' ? '驗證中...' : '驗證並連結此筆'}
              </button>
            </div>
          ))}
        </div>
      )}

      <details className="text-slate-600">
        <summary className="cursor-pointer select-none text-slate-600 hover:text-slate-900">
          進階：輸入已知的 Source Record ID
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="min-w-44 flex-1 sm:max-w-56">
            <span className="mb-1 block">Source Record ID</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={recordId}
              onChange={(event) => setRecordId(event.target.value.replace(/\D/g, ''))}
              disabled={disabled || isBusy}
              placeholder="例如 5188"
              aria-label={`規劃${planSequence}的 Source Record ID`}
              className="w-full border border-slate-300 bg-white px-2 py-1.5 font-mono text-slate-800 outline-none focus:border-blue-500 disabled:bg-slate-100"
            />
          </label>
          <button
            type="button"
            onClick={() => confirmCreated(recordId)}
            disabled={disabled || isBusy || !recordId}
            className="border border-blue-600 bg-white px-3 py-1.5 font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
          >
            {submitting === 'confirm_created' ? '驗證中...' : '驗證並連結'}
          </button>
        </div>
      </details>
    </div>
  );
}
