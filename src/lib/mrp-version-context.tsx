'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useToast } from '@/components/toast';
import { cacheInvalidate } from '@/lib/swr-cache';
import { useArchiveMode } from './archive-mode-context';
import {
  MRP_RETENTION_UPDATED_EVENT,
  resolveMissingSelectedRunFallback,
  resolveRetentionFallbackRunId,
} from '@/lib/mrp-retention-client';

export interface MrpRun {
  id: number;
  versionCode: string;
  runDate: string;
  status: string;
  completedAt: string | null;
}

interface MrpVersionContextValue {
  selectedRunId: number | null;
  selectedRun: MrpRun | null;
  latestRun: MrpRun | null;
  isLatestSelected: boolean;
  runs: MrpRun[];
  setSelectedRunId: (id: number) => void;
  isLoading: boolean;
  selectionError: string | null;
  retrySelection: () => void;
  refreshRuns: () => Promise<void>;
  reloadRunsList: () => Promise<void>;
  /** 元件回報忙碌中（轉單/未存編輯…），忙碌時自動切換到最新 run 會延後到不忙才執行。 */
  setBusy: (key: string, busy: boolean) => void;
}

const STORAGE_KEY = 'mrp_selectedRunId';

const MrpVersionContext = createContext<MrpVersionContextValue>({
  selectedRunId: null,
  selectedRun: null,
  latestRun: null,
  isLatestSelected: false,
  runs: [],
  setSelectedRunId: () => {},
  isLoading: true,
  selectionError: null,
  retrySelection: () => {},
  refreshRuns: async () => {},
  reloadRunsList: async () => {},
  setBusy: () => {},
});

export function MrpVersionProvider({ children }: { children: React.ReactNode }) {
  const showToast = useToast();
  const archive = useArchiveMode();
  const historicalMode = Boolean(archive.run || archive.restoring || archive.error);
  const historicalModeRef = useRef(historicalMode);
  historicalModeRef.current = historicalMode;
  const showVersionToast = useCallback((toast: Parameters<typeof showToast>[0]) => {
    if (!historicalModeRef.current) showToast(toast);
  }, [showToast]);
  const [runs, setRuns] = useState<MrpRun[]>([]);
  const [selectedRunId, setSelectedRunIdState] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionAttempt, setSelectionAttempt] = useState(0);
  const deletedRunIdsRef = useRef(new Set<number>());
  const selectionStatusRef = useRef<'pending' | 'ready' | 'error' | 'empty'>('pending');
  const receivedInitialSyncRef = useRef(false);
  const pendingSyncRef = useRef<{ latestRunId?: number | null; versionCode?: string | null } | null>(null);
  const retrySelection = useCallback(() => {
    selectionStatusRef.current = 'pending';
    setSelectionError(null);
    setIsLoading(true);
    setSelectionAttempt(value => value + 1);
  }, []);
  const [latestCompletedRunId, setLatestCompletedRunId] = useState<number | null>(null);

  // SSE handler 在掛載時建立一次，靠 ref 讀當下值（避免 stale closure）
  const selectedRunIdRef = useRef<number | null>(null);
  const busyKeysRef = useRef<Set<string>>(new Set());
  const pendingFollowRef = useRef<{ runId: number; versionCode: string } | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      if (!res.ok) throw new Error('Run list unavailable');
      const json = await res.json();
      const completed: MrpRun[] = (json.runs || [])
        .filter((r: MrpRun) => r.status === 'completed' && !deletedRunIdsRef.current.has(r.id))
        .map((r: MrpRun) => ({
          id: r.id,
          versionCode: r.versionCode,
          runDate: typeof r.runDate === 'string' ? r.runDate.split('T')[0] : r.runDate,
          status: r.status,
          completedAt: r.completedAt,
        }));
      // Sort newest first by id (higher id = newer)
      completed.sort((a: MrpRun, b: MrpRun) => b.id - a.id);
      setLatestCompletedRunId(completed[0]?.id ?? null);
      return completed;
    } catch {
      return [];
    }
  }, []);

  // Initial load
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    (async () => {
      let storedId: number | null = null;
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && Number.isSafeInteger(Number(stored)) && Number(stored) > 0) storedId = Number(stored);
      } catch {
        // ignore
      }

      void fetchRuns().then(completed => {
        if (!active) return completed;
        completed = completed.filter(run => !deletedRunIdsRef.current.has(run.id));
        if (completed.length > 0) setRuns(previous => {
          const available = completed.filter(run => !deletedRunIdsRef.current.has(run.id));
          const selected = previous.find(run => run.id === selectedRunIdRef.current && !deletedRunIdsRef.current.has(run.id));
          return selected && !available.some(run => run.id === selected.id)
            ? [...available, selected].sort((a, b) => b.id - a.id) : available;
        });
        return completed;
      });
      try {
        const response = await fetch(`/api/runs/selection${storedId ? `?runId=${storedId}` : ''}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('selection unavailable');
        const { run, fallback } = await response.json();
        if (!active || selectedRunIdRef.current !== null) return;
        if (!run) {
          selectionStatusRef.current = 'empty';
          setSelectionError('目前沒有已完成的 MRP 版本，請稍後重試。');
          return;
        }
        if (deletedRunIdsRef.current.has(run.id)) throw new Error('selected Run was deleted');
        {
          selectionStatusRef.current = 'ready';
          selectedRunIdRef.current = run.id;
          setSelectedRunIdState(run.id);
          setRuns(previous => deletedRunIdsRef.current.has(run.id) || previous.some(item => item.id === run.id) ? previous
            : [...previous, { ...run, runDate: run.runDate.split('T')[0] }].sort((a, b) => b.id - a.id));
          setSelectionError(null);
          setIsLoading(false);
          if (fallback) {
            try { localStorage.setItem(STORAGE_KEY, String(run.id)); } catch { /* optional storage */ }
            showVersionToast({ type: 'info', message: `原選取 MRP 已無法使用，已切換到 ${run.versionCode}` });
          }
        }
      } catch {
        if (active && selectedRunIdRef.current === null) {
          selectionStatusRef.current = 'error';
          const message = '無法確認 MRP 版本，請重試或從版本選單重新選擇。';
          setSelectionError(message);
          showVersionToast({ type: 'error', message });
        }
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [fetchRuns, showVersionToast, selectionAttempt]);

  const setSelectedRunId = useCallback((id: number) => {
    if (deletedRunIdsRef.current.has(id)) return;
    selectionStatusRef.current = 'ready';
    selectedRunIdRef.current = id; // 同步更新，讓連續 SSE 事件立即讀到最新值（不等 effect）
    setSelectedRunIdState(id);
    setIsLoading(false);
    setSelectionError(null);
    try {
      localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      // ignore
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    const completed = await fetchRuns();
    setRuns(() => completed.filter(run => !deletedRunIdsRef.current.has(run.id)));
    // Auto-select the newest run if it's newer than current selection
    if (completed.length > 0) {
      const currentIdx = completed.findIndex((r) => r.id === selectedRunId);
      if (currentIdx === -1 || completed[0].id > (selectedRunId ?? 0)) {
        setSelectedRunId(completed[0].id);
      }
    }
  }, [fetchRuns, selectedRunId, setSelectedRunId]);

  // 只更新清單、不切換選取（供「自動跟最新」延後 / 關閉時用，不動使用者目前的 run）
  const reloadRunsList = useCallback(async () => {
    const completed = await fetchRuns();
    setRuns(previous => {
      const available = completed.filter(run => !deletedRunIdsRef.current.has(run.id));
      const selected = previous.find(run => run.id === selectedRunIdRef.current && !deletedRunIdsRef.current.has(run.id));
      return selected && !available.some(run => run.id === selected.id)
        ? [...available, selected].sort((a, b) => b.id - a.id) : available;
    });
  }, [fetchRuns]);

  const forgetDeletedRuns = useCallback((ids: readonly number[]) => {
    if (ids.length === 0) return;
    for (const id of ids) deletedRunIdsRef.current.add(id);
    setRuns(previous => previous.filter(run => !deletedRunIdsRef.current.has(run.id)));
    // 即時報表包含 URL 與複合 periods key；確認刪除後一起失效，封存快取不受影響。
    cacheInvalidate(() => true);
    if (pendingFollowRef.current && deletedRunIdsRef.current.has(pendingFollowRef.current.runId)) pendingFollowRef.current = null;
  }, []);

  useEffect(() => { selectedRunIdRef.current = selectedRunId; }, [selectedRunId]);

  // 元件回報忙碌；忙碌清空且有待切換 → 立刻執行延後的切換
  const setBusy = useCallback((key: string, busy: boolean) => {
    const keys = busyKeysRef.current;
    if (busy) keys.add(key); else keys.delete(key);
    if (!busy && keys.size === 0 && pendingFollowRef.current) {
      const pending = pendingFollowRef.current;
      pendingFollowRef.current = null;
      setSelectedRunId(pending.runId);
      showVersionToast({ type: 'success', message: `已切換到最新 MRP ${pending.versionCode}` });
    }
  }, [setSelectedRunId, showVersionToast]);

  // 收到 SSE 事件：依全域設定 + 是否忙碌決定切換（一律以最新 run 為準；忙碌中延後）
  const handleStreamEvent = useCallback(async (data: {
    type?: string;
    latestRunId?: number | null;
    versionCode?: string | null;
    autoFollow?: boolean;
    deletedRunIds?: number[];
  }) => {
    const selectionWasReady = selectionStatusRef.current === 'ready';
    const initialSync = data.type === 'sync' && !receivedInitialSyncRef.current;
    if (data.type === 'sync') receivedInitialSyncRef.current = true;
    if (data.type === 'sync' && !selectionWasReady) {
      pendingSyncRef.current = { latestRunId: data.latestRunId, versionCode: data.versionCode };
    }
    if (data.type === 'run-retention-completed') forgetDeletedRuns(data.deletedRunIds ?? []);
    await reloadRunsList(); // 不論切不切，先讓清單/下拉反映實際
    // 版本尚未確認時，事件只更新選單，不能代替 selection 選版。
    if (!selectionWasReady || selectionStatusRef.current !== 'ready') return;
    const isNewRun = data.type === 'run-completed';
    const isRetentionCompleted = data.type === 'run-retention-completed';
    const latestRunId = data.latestRunId ?? null;
    const versionCode = data.versionCode ?? '';

    if (data.type === 'sync') {
      try {
        const checkedRunId = selectedRunIdRef.current;
        const reconnectFallbackRunId = await resolveMissingSelectedRunFallback(
          checkedRunId,
          latestRunId,
          async (runId) => {
            const response = await fetch(`/api/runs/${runId}`);
            if (response.status === 404) { forgetDeletedRuns([runId]); return false; }
            if (!response.ok) throw new Error('無法確認目前選取的 MRP Run');
            return true;
          },
        );
        if (selectedRunIdRef.current !== checkedRunId) return;
        if (reconnectFallbackRunId !== null && selectedRunIdRef.current === checkedRunId) {
          pendingFollowRef.current = null;
          setSelectedRunId(reconnectFallbackRunId);
          showVersionToast({
            type: 'info',
            message: `原選取 MRP 已不存在，已切換到最新 MRP ${versionCode}`,
          });
          window.dispatchEvent(new Event(MRP_RETENTION_UPDATED_EVENT));
          return;
        }
      } catch {
        // 精確 existence check 失敗時保留目前選取，不從截斷 Run 清單推論刪除。
        return;
      }
    }

    // 首次 sync 仍須確認已選版本存在，但不能僅因 autoFollow 就覆蓋有效的原選擇。
    if (initialSync) return;

    if (isRetentionCompleted) {
      cacheInvalidate((k) =>
        k === '/api/runs' ||
        k.startsWith('/api/dashboard') ||
        k === '/api/maintenance-status');
      const fallbackRunId = resolveRetentionFallbackRunId(
        selectedRunIdRef.current,
        latestRunId,
        data.deletedRunIds ?? [],
      );
      if (fallbackRunId !== null) {
        pendingFollowRef.current = null;
        setSelectedRunId(fallbackRunId);
        showVersionToast({
          type: 'info',
          message: `原選取 MRP 已由自動整理移除，已切換到最新 MRP ${versionCode}`,
        });
      }
      window.dispatchEvent(new Event(MRP_RETENTION_UPDATED_EVENT));
      return;
    }

    if (latestRunId == null) return;
    // 新 run 完成 → 砍「不帶 runId 的全域 endpoint」快取，否則 run 歷史/儀表板會殘留舊資料、
    // 與版本下拉打架。per-run 的頁面快取因 key 含新 runId 自然 miss、會抓新的，不必砍。
    if (isNewRun) cacheInvalidate((k) => k === '/api/runs' || k.startsWith('/api/dashboard'));

    if (!data.autoFollow) {
      if (isNewRun) showVersionToast({ type: 'info', message: `有新 MRP ${versionCode}（自動切換已關閉），可手動切換` });
      return;
    }
    if (latestRunId === selectedRunIdRef.current) return; // 已在最新

    if (busyKeysRef.current.size > 0) {
      // 編輯/轉單進行中 → 延後，等忙碌清空再切（見 setBusy）
      pendingFollowRef.current = { runId: latestRunId, versionCode };
      if (isNewRun) showVersionToast({ type: 'info', message: `有新 MRP ${versionCode}，完成目前操作後自動切換` });
      return;
    }

    setSelectedRunId(latestRunId);
    // 只有真實的「新 run 完成」才提示；連線補課(sync)靜默對齊，避免每次載入跳通知
    if (isNewRun) showVersionToast({ type: 'success', message: `已切換到最新 MRP ${versionCode}` });
  }, [reloadRunsList, setSelectedRunId, showVersionToast, forgetDeletedRuns]);

  useEffect(() => {
    if (selectedRunId === null || selectionStatusRef.current !== 'ready' || !pendingSyncRef.current) return;
    const pending = pendingSyncRef.current;
    pendingSyncRef.current = null;
    // selection 回應可能早於 retention 讀取；補做存在性檢查，不重播自動切版。
    void handleStreamEvent({ type: 'sync', ...pending, autoFollow: false });
  }, [selectedRunId, handleStreamEvent]);

  // 訂閱 SSE：零輪詢，run 完成時 server 推；瀏覽器 EventSource 內建自動重連
  useEffect(() => {
    const es = new EventSource('/api/runs/stream');
    es.onmessage = (e) => {
      try { handleStreamEvent(JSON.parse(e.data)); } catch { /* 忽略非 JSON（心跳註解不會進這） */ }
    };
    // onerror 不處理：EventSource 會自動重連，重連後 server 會再推一次 sync 補課
    return () => es.close();
  }, [handleStreamEvent]);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
  const latestRun = runs[0] ?? null;
  const isLatestSelected = selectedRunId !== null && selectedRunId === latestCompletedRunId;

  return (
    <MrpVersionContext.Provider
      value={{ selectedRunId, selectedRun, latestRun, isLatestSelected, runs, setSelectedRunId, isLoading, selectionError, retrySelection, refreshRuns, reloadRunsList, setBusy }}
    >
      {children}
    </MrpVersionContext.Provider>
  );
}

export function useMrpVersion() {
  return useContext(MrpVersionContext);
}
