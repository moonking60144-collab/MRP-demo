'use client';

import { useCallback, useState } from 'react';
import type { FilterModalInitialFocus } from './filter-modal';

export interface FilterModalController {
  open: boolean;
  initialFocus: FilterModalInitialFocus;
  openNew: (columnId?: string) => void;
  openEdit: (columnId: string) => void;
  close: () => void;
}

export function useFilterModalController(): FilterModalController {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<FilterModalInitialFocus>(null);

  const openNew = useCallback((columnId?: string) => {
    setInitialFocus({ type: 'new', columnId });
    setOpen(true);
  }, []);

  const openEdit = useCallback((columnId: string) => {
    setInitialFocus({ type: 'edit', columnId });
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return { open, initialFocus, openNew, openEdit, close };
}
