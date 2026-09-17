'use client';

import { useRef, useState, useEffect } from 'react';

/**
 * Dynamically compute the height a table container should occupy based on
 * its position in the viewport — fills the remaining vertical space below
 * the table, with a sensible minimum so the table area never collapses to
 * just a few rows when the surrounding chrome is large.
 *
 * Returns BOTH `maxHeight` (legacy callers) and `height` (preferred — set
 * as a fixed height so the container always claims the available space and
 * scrolls internally when content overflows).
 *
 * Usage:
 *   const { containerRef, height } = useAutoTableHeight();
 *   <div ref={containerRef} style={{ height }}>...</div>
 */
// Default 80px reserves space for the sticky pagination row + horizontal
// scrollbar at the viewport bottom. Without this, the table extends past the
// viewport bottom and the pagination/scrollbar become unreachable until the
// user scrolls the entire page down. Callers without bottom UI can pass a
// smaller value (e.g. 16).
export function useAutoTableHeight(bottomPadding = 80, minHeight = 400) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(600);

  useEffect(() => {
    const recalc = () => {
      const el = containerRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const available = window.innerHeight - top - bottomPadding;
      // Floor at minHeight so a small viewport doesn't squash the table
      // into a few rows; ceil at the natural available space so it expands
      // to fill larger viewports.
      setHeight(Math.max(minHeight, Math.round(available)));
    };

    recalc();
    window.addEventListener('resize', recalc);
    // Recalc after a short delay to catch any late layout shifts
    const timer = setTimeout(recalc, 150);

    return () => {
      window.removeEventListener('resize', recalc);
      clearTimeout(timer);
    };
  }, [bottomPadding, minHeight]);

  return { containerRef, height, maxHeight: height };
}
