'use client';

import { useEffect } from 'react';

export function useReportScroll(key: string, context: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const element = document.querySelector<HTMLElement>('[data-mrp-scroll]');
    if (!element) return;
    let top = 0;
    let left = 0;
    let restored = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (saved?.context === context && Number.isFinite(saved.top) && Number.isFinite(saved.left)) {
        top = saved.top;
        left = saved.left;
      }
    } catch { /* optional storage */ }
    // Run after the virtualizer's passive reset, before the next paint.
    const frame = requestAnimationFrame(() => {
      element.scrollTop = top;
      element.scrollLeft = left;
      top = element.scrollTop;
      left = element.scrollLeft;
      restored = true;
    });
    const capture = () => {
      if (!restored) return;
      top = element.scrollTop;
      left = element.scrollLeft;
    };
    const save = () => {
      try { sessionStorage.setItem(key, JSON.stringify({ context, top, left })); } catch { /* optional storage */ }
    };
    // Scroll only updates local coordinates; storage is written when leaving the view.
    element.addEventListener('scroll', capture, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      cancelAnimationFrame(frame);
      save();
      element.removeEventListener('scroll', capture);
      window.removeEventListener('pagehide', save);
    };
  }, [key, context, ready]);
}
