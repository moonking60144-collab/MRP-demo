'use client';

import { useCallback, useEffect, useState } from 'react';

interface ReportPage { context: string; page: number }

export function parseReportPage(raw: string | null): ReportPage | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    return value && typeof value.context === 'string'
      && Number.isSafeInteger(value.page) && value.page > 0
      ? { context: value.context, page: value.page } : null;
  } catch {
    return null;
  }
}

export function useReportPage(key: string, context: string, ready: boolean) {
  const [saved, setSaved] = useState<ReportPage | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try { setSaved(parseReportPage(sessionStorage.getItem(key))); } catch { /* optional storage */ }
    setHydrated(true);
  }, [key]);
  const queryReady = hydrated && ready;
  const page = saved?.context === context ? saved.page : 1;
  // Reset before querying, not in a later effect that would first fetch the old page.
  if (queryReady && saved?.context !== context) setSaved({ context, page: 1 });
  useEffect(() => {
    if (!queryReady) return;
    try { sessionStorage.setItem(key, JSON.stringify({ context, page })); } catch { /* optional storage */ }
  }, [key, context, page, queryReady]);
  const setPage = useCallback((value: number) => {
    setSaved({ context, page: Math.max(1, value) });
  }, [context]);
  return { page, setPage, queryReady };
}
