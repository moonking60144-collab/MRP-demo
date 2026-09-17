'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArchiveRunItem } from './archive/browser-contract';

const storageKey = 'mrp_archiveRunId';
const ArchiveModeContext = createContext<{
  run: ArchiveRunItem | null;
  restoring: boolean;
  error: string | null;
  selectRun: (run: ArchiveRunItem) => void;
  exitArchive: () => void;
  retry: () => void;
} | null>(null);

export function ArchiveModeProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<ArchiveRunItem | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    let id: string | null;
    try { id = sessionStorage.getItem(storageKey); } catch { id = null; }
    if (!id) { setRestoring(false); return; }
    const current = ++generation.current;
    let active = true;
    const controller = new AbortController();
    setRestoring(true);
    setError(null);
    void fetch(`/api/archive/runs/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const body = await response.json();
      if (!response.ok || body.id !== id) throw new Error(body.error || '無法恢復歷史版本');
      if (active && current === generation.current) setRun(body);
    }).catch(error => {
      if (active && current === generation.current) setError(error instanceof Error ? error.message : '無法恢復歷史版本');
    }).finally(() => {
      if (active && current === generation.current) setRestoring(false);
    });
    return () => { active = false; controller.abort(); };
  }, [attempt]);

  const selectRun = (selected: ArchiveRunItem) => {
    generation.current++;
    try { sessionStorage.setItem(storageKey, selected.id); } catch { /* Selection still works for this page session. */ }
    setRun(selected);
    setError(null);
    setRestoring(false);
  };
  const exitArchive = () => {
    generation.current++;
    try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
    setRun(null);
    setError(null);
    setRestoring(false);
  };

  return <ArchiveModeContext.Provider value={{ run, restoring, error, selectRun, exitArchive, retry: () => setAttempt(value => value + 1) }}>{children}</ArchiveModeContext.Provider>;
}

export function useArchiveMode() {
  const context = useContext(ArchiveModeContext);
  if (!context) throw new Error('ArchiveModeProvider is required');
  return context;
}
