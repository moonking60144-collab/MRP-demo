'use client';

import { useEffect, useState } from 'react';
import { Loader } from './ui/loader';
import type { StorageStatus } from '@/lib/storage-status';

export function formatStorageBytes(bytes: number | null | undefined) {
  if (bytes == null) return '未取得';
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function useStorageCapacity() {
  const [data, setData] = useState<StorageStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/storage-status', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Storage unavailable');
        const value = await response.json();
        if (!value.measuredAt || !Array.isArray(value.volumes) || !Array.isArray(value.files) || !Array.isArray(value.warnings)) {
          throw new Error('Invalid storage response');
        }
        if (!controller.signal.aborted) { setData(value); setError(false); }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return { data, error, loading, refresh: () => setRevision(value => value + 1) };
}

export function StorageCapacityPanel({ state }: { state: ReturnType<typeof useStorageCapacity> }) {
  const { data, error, loading, refresh } = state;
  return (
    <section aria-label="容量控管" aria-busy={loading} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{data?.demo ? '模擬容量' : '磁碟容量'}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {data && <span>{data.demo ? '資料時間' : '量測'} {new Date(data.measuredAt).toLocaleString('zh-TW', { hour12: false })}</span>}
          <button type="button" disabled={loading} onClick={refresh}
            className="min-h-11 rounded border border-slate-200 px-3 text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50">
            {loading ? '讀取中…' : '重新整理'}
          </button>
        </div>
      </div>
      {loading && !data ? <div className="flex min-h-20 items-center gap-2 text-sm text-slate-500"><Loader />正在讀取容量資料…</div> : null}
      {error && <p role="alert" className="mt-2 text-sm text-amber-700">容量讀取失敗。{data ? '下方為上次量測，並非即時狀態。' : '請稍後重新整理。'}</p>}
      {data && <>
        {data.demo && <p className="mt-2 text-xs leading-5 text-slate-500">Demo 合成容量，非這台電腦的實際磁碟量測。</p>}
        <div className="mt-3 grid gap-4">
          {data.volumes.map(volume => <div key={volume.label}>
            <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs">
              <span className="text-slate-600">{volume.label}</span>
              <span className={volume.critical ? 'text-red-700' : volume.warning ? 'text-amber-700' : 'text-slate-600'}>
                {volume.critical ? '空間不足 · ' : volume.warning ? '容量預警 · ' : ''}剩餘 {formatStorageBytes(volume.freeBytes)}／{formatStorageBytes(volume.totalBytes)}
              </span>
            </div>
            <div role="progressbar" aria-label={`${volume.label}已用容量`} aria-valuemin={0}
              aria-valuemax={volume.totalBytes} aria-valuenow={volume.totalBytes - volume.freeBytes}
              className="h-2 overflow-hidden rounded bg-slate-100">
              <div style={{ width: `${Math.max(0, Math.min(100, 100 * (1 - volume.freeBytes / volume.totalBytes)))}%` }}
                className={`h-full ${volume.critical ? 'bg-red-600' : volume.warning ? 'bg-amber-500' : 'bg-slate-400'}`} />
            </div>
          </div>)}
        </div>
        {data.warnings.length > 0 && <p role="status" className="mt-3 text-xs text-slate-500">部分容量資訊暫時無法讀取，請查看明細。</p>}
        <details className="mt-4 border-t border-slate-100 pt-1">
          <summary className="cursor-pointer py-3 text-xs font-medium text-slate-600 focus-visible:outline focus-visible:outline-blue-500">容量明細與規則</summary>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            {[{ label: `目前資料庫 · ${data.databaseMode}`, bytes: data.database?.bytes },
              { label: `永久封存 · ${data.archive?.verifiedRuns ?? '—'} 版`, bytes: data.archive?.bytes }, ...data.files].map(item =>
              <div key={item.label} className="min-w-0"><dt className="text-slate-500">{item.label}</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{formatStorageBytes(item.bytes)}</dd></div>)}
          </dl>
          {data.warnings.length > 0 && <ul className="mt-3 space-y-1 text-xs text-slate-500">{data.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        <p className="mt-2 text-xs text-slate-500">{data.demo ? '容量與歷史版本為合成展示，不會觸發備份、清理或寄信。' : '每分鐘快取量測；低於 50 GiB 或 15% 預警，20 GiB 為預設封存保護門檻。例行備份不含部署回復檔；磁碟已用空間包含其他程式與暫存庫。'}</p>
        </details>
      </>}
    </section>
  );
}
