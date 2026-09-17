'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PresetCreateInput, TablePreset } from '../types';
import {
  createLocalTablePreset,
  readLocalTablePresets,
  setDefaultLocalTablePreset,
  tablePresetStorageKey,
  writeLocalTablePresets,
} from '../preset-storage';

export function useTablePresets(tableId: string) {
  const [presets, setPresets] = useState<TablePreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const presetsRef = useRef<TablePreset[]>([]);

  const commitPresets = useCallback((next: TablePreset[]) => {
    presetsRef.current = next;
    setPresets(next);
    try {
      writeLocalTablePresets(localStorage, tableId, next);
    } catch {
      // localStorage 不可用時仍保留本次分頁內的設定。
    }
  }, [tableId]);

  const loadFromStorage = useCallback(() => {
    let next: TablePreset[] = [];
    try {
      next = readLocalTablePresets(localStorage, tableId);
    } catch {
      // localStorage 被瀏覽器停用時，安全回到沒有個人預設。
    }
    presetsRef.current = next;
    setPresets(next);
    setActivePresetId(null);
    setLoading(false);
    return next;
  }, [tableId]);

  useLayoutEffect(() => {
    setLoading(true);
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    const storageKey = tablePresetStorageKey(tableId);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      loadFromStorage();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [tableId, loadFromStorage]);

  const savePreset = useCallback((input: PresetCreateInput) => {
    const existingIds = presetsRef.current.map((preset) => preset.id);
    const id = Math.max(Date.now(), ...existingIds.map((value) => value + 1));
    const preset = createLocalTablePreset(input, id);
    const current = input.isDefault
      ? setDefaultLocalTablePreset(presetsRef.current, null)
      : presetsRef.current;
    commitPresets([...current, preset]);
    setActivePresetId(id);
    return preset;
  }, [commitPresets]);

  const updatePreset = useCallback((
    id: number,
    updates: Partial<PresetCreateInput>,
  ) => {
    const now = new Date().toISOString();
    let next = presetsRef.current.map((preset) => (
      preset.id === id
        ? {
          ...preset,
          ...updates,
          tableId,
          presetName: updates.presetName?.trim() || preset.presetName,
          updatedAt: now,
        }
        : preset
    ));
    if (updates.isDefault === true) next = setDefaultLocalTablePreset(next, id);
    commitPresets(next);
    setActivePresetId(id);
  }, [commitPresets, tableId]);

  const deletePreset = useCallback((id: number) => {
    commitPresets(presetsRef.current.filter((preset) => preset.id !== id));
    setActivePresetId((current) => current === id ? null : current);
  }, [commitPresets]);

  const setDefault = useCallback((id: number) => {
    commitPresets(setDefaultLocalTablePreset(presetsRef.current, id));
  }, [commitPresets]);

  const unsetDefault = useCallback((id: number) => {
    if (!presetsRef.current.some((preset) => preset.id === id && preset.isDefault)) return;
    commitPresets(setDefaultLocalTablePreset(presetsRef.current, null));
  }, [commitPresets]);

  const loadPreset = useCallback((preset: TablePreset) => {
    setActivePresetId(preset.id);
  }, []);

  const useSystemDefault = useCallback(() => {
    setActivePresetId(null);
  }, []);

  const defaultPreset = presets.find((preset) => preset.isDefault) ?? null;

  return {
    presets,
    activePresetId,
    setActivePresetId,
    defaultPreset,
    loading,
    savePreset,
    updatePreset,
    deletePreset,
    setDefault,
    unsetDefault,
    loadPreset,
    useSystemDefault,
    fetchPresets: loadFromStorage,
  };
}
