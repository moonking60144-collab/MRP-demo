'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Like useState but persists to localStorage.
 * SSR-safe: returns defaultValue on first render, hydrates from localStorage on mount.
 */
export function usePersistedState<T>(key: string, defaultValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(defaultValue);
  const [hydrated, setHydrated] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        setValue(JSON.parse(stored));
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [key]);

  // Persist to localStorage on change (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value, hydrated]);

  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(v);
  }, []);

  return [value, set];
}
