'use client';

import { useCallback, useRef, useState } from 'react';
import {
  RunDetailRequestTracker,
  type RunDetailRequestToken,
} from '@/lib/run-detail-request-tracker';
import {
  cacheGet,
  cacheInvalidate,
  cacheIsFresh,
  cacheSet,
} from '@/lib/swr-cache';

const RUN_DETAIL_TTL_MS = 30_000;

export interface RunDetail {
  id: number;
  stepStatus: Record<string, unknown> | null;
  syncCounts: Record<string, number> | null;
  errorMessage: string | null;
  logs: Array<{
    ts: number;
    level: 'info' | 'warn' | 'error';
    msg: string;
  }>;
}

export function useRunDetailCache() {
  const requestTrackerRef = useRef(new RunDetailRequestTracker<RunDetail | null>());
  const [details, setDetails] = useState<Record<number, RunDetail>>({});
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});

  const loadRunDetail = useCallback((
    runId: number,
    options?: { force?: boolean },
  ): Promise<RunDetail | null> => {
    const cacheKey = `/api/runs/${runId}`;
    const isFresh = cacheIsFresh(cacheKey, RUN_DETAIL_TTL_MS);
    const cached = cacheGet<RunDetail>(cacheKey);
    if (cached) {
      setDetails((current) => ({ ...current, [runId]: cached }));
      if (!options?.force && isFresh) return Promise.resolve(cached);
    }

    const tracker = requestTrackerRef.current;
    const inFlight = tracker.get(runId);
    if (inFlight) return inFlight;

    if (!cached) {
      setLoadingIds((current) => new Set(current).add(runId));
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });

    const token: RunDetailRequestToken = tracker.capture(runId);
    const request = fetch(`/api/runs/${runId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        const run = json.run as RunDetail | undefined;
        if (!run) throw new Error('Run detail not found');
        const detail: RunDetail = {
          ...run,
          stepStatus: run.stepStatus ?? null,
          syncCounts: run.syncCounts ?? null,
          errorMessage: run.errorMessage ?? null,
          logs: Array.isArray(run.logs) ? run.logs : [],
        };
        if (!tracker.isCurrent(token)) return null;
        cacheSet(cacheKey, detail);
        setDetails((current) => ({ ...current, [runId]: detail }));
        return detail;
      })
      .catch((error) => {
        if (!tracker.isCurrent(token)) return null;
        setErrors((current) => ({
          ...current,
          [runId]: error instanceof Error ? error.message : String(error),
        }));
        return null;
      })
      .finally(() => {
        if (!tracker.finish(token)) return;
        setLoadingIds((current) => {
          const next = new Set(current);
          next.delete(runId);
          return next;
        });
      });

    tracker.track(token, request);
    return request;
  }, []);

  const invalidateRunDetail = useCallback((runId: number) => {
    requestTrackerRef.current.invalidate(runId);
    cacheInvalidate((key) => key === `/api/runs/${runId}`);
    setDetails((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    setErrors((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    setLoadingIds((current) => {
      const next = new Set(current);
      next.delete(runId);
      return next;
    });
  }, []);

  return {
    details,
    loadingIds,
    errors,
    loadRunDetail,
    invalidateRunDetail,
  };
}
