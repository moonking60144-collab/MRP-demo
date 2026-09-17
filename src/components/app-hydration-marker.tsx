'use client';

import { useEffect } from 'react';
import { BOOTSTRAP_HYDRATED_EVENT, clearBootstrapRecoveryAttempts } from '@/lib/bootstrap-recovery';

export function AppHydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.mrpHydrated = 'true';
    clearBootstrapRecoveryAttempts();
    window.dispatchEvent(new Event(BOOTSTRAP_HYDRATED_EVENT));
  }, []);

  return null;
}
