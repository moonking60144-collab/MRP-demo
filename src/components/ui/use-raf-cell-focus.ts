'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

interface SelectionCell {
  r: number;
  c: number;
}

function isSameCell(left: SelectionCell | null, right: SelectionCell | null): boolean {
  return left?.r === right?.r && left?.c === right?.c;
}

export function useRafCellFocus<T extends SelectionCell>(
  currentRef: RefObject<T | null>,
  commit: (value: T | null) => void,
) {
  const pendingRef = useRef<T | null>(null);
  const frameRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const schedule = useCallback((next: T): boolean => {
    const previous = pendingRef.current ?? currentRef.current;
    if (isSameCell(previous, next)) return false;
    pendingRef.current = next;
    if (frameRef.current !== null) return true;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending && !isSameCell(currentRef.current, pending)) commit(pending);
    });
    return true;
  }, [commit, currentRef]);

  const flush = useCallback((fallback?: T | null): T | null => {
    const next = fallback ?? pendingRef.current ?? currentRef.current;
    cancel();
    if (!isSameCell(currentRef.current, next)) commit(next);
    return next;
  }, [cancel, commit, currentRef]);

  return { cancel, flush, schedule };
}
