'use client';

import { useEffect, useState } from 'react';
import { archiveReportCache, isArchiveReportUrl } from './report-cache';
import { archiveRunListCache, isArchiveRunListUrl, validateArchiveRunPage } from './run-list-cache';

export function useArchiveResource<T>(url: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ url: string | null; attempt: number; data?: T; error?: string; loading: boolean }>({ url: null, attempt: 0, loading: false });
  const list = Boolean(url && isArchiveRunListUrl(url));
  const cache = list ? archiveRunListCache : archiveReportCache;
  const cacheable = list || Boolean(url && isArchiveReportUrl(url));
  const cached = url && cacheable ? cache.peek<T>(url) : undefined;
  useEffect(() => {
    if (!url) return;
    const cached = cacheable ? cache.get<T>(url) : undefined;
    if (cached !== undefined) {
      setResult({ url, attempt, data: cached, loading: false });
      return;
    }
    const controller = new AbortController();
    let current = true;
    setResult({ url, attempt, loading: true });
    void fetch(url, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '讀取歷史資料失敗');
      if (list) validateArchiveRunPage(body, url);
      else if (cacheable && body.run?.id !== url.split('/')[4]) throw new Error('歷史版本回應不一致');
      if (current) {
        if (cacheable) cache.set(url, body);
        setResult({ url, attempt, data: body, loading: false });
      }
    }).catch(error => {
      if (current) setResult({ url, attempt, error: error instanceof Error ? error.message : '讀取歷史資料失敗', loading: false });
    });
    return () => { current = false; controller.abort(); };
  }, [url, attempt, cacheable, cache, list]);
  // A changed selection must never render the preceding request's rows, even before its effect runs.
  const matches = result.url === url && result.attempt === attempt;
  return { data: matches ? result.data : cached,
    error: matches ? result.error : undefined,
    loading: Boolean(url) && (matches ? result.loading : cached === undefined),
    retry: () => { if (url) cache.delete(url); setAttempt(value => value + 1); } };
}
