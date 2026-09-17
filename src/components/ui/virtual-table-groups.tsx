'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { updateVirtualTableWindow } from './virtual-table-rows';

export interface VirtualTableGroup {
  key: string;
  start: number;
  end: number;
  estimatedHeight: number;
  stripeStart?: number;
}

export function computeVirtualGroupWindow(heights: number[], scrollTop: number, viewportHeight: number, overscan = 1) {
  const offsets = [0];
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  let first = 0;
  while (first < heights.length && offsets[first + 1] <= Math.max(0, scrollTop)) first++;
  let end = first;
  while (end < heights.length && offsets[end] < Math.max(0, scrollTop) + viewportHeight) end++;
  const start = Math.max(0, first - overscan);
  end = Math.min(heights.length, end + overscan);
  return { start, end, topSpacerHeight: offsets[start], bottomSpacerHeight: offsets[heights.length] - offsets[end] };
}

export function isVirtualGroupViewportCovered(
  window: { topSpacerHeight: number; bottomSpacerHeight: number },
  totalHeight: number,
  top: number,
  height: number,
) {
  return top >= window.topSpacerHeight
    && Math.min(totalHeight, top + height) <= totalHeight - window.bottomSpacerHeight;
}

export function resolveBufferedGroupWindow(
  current: ReturnType<typeof computeVirtualGroupWindow>,
  heights: number[], top: number, height: number, overscan: number,
) {
  const guard = computeVirtualGroupWindow(heights, top, height, Math.ceil(overscan / 2));
  const valid = current.end <= heights.length
    && current.topSpacerHeight === heights.slice(0, current.start).reduce((sum, value) => sum + value, 0)
    && current.bottomSpacerHeight === heights.slice(current.end).reduce((sum, value) => sum + value, 0);
  if (valid && current.start <= guard.start && current.end >= guard.end) return current;
  return updateVirtualTableWindow(current, computeVirtualGroupWindow(heights, top, height, overscan));
}

export function useVirtualTableGroups({ groups, zoom, geometryKey, resetKey, overscan = 1 }: {
  groups: VirtualTableGroup[];
  zoom: number;
  geometryKey: string;
  resetKey: string;
  overscan?: number;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [measurements, setMeasurements] = useState<Map<string, number>>(() => new Map());
  const frame = useRef<number | null>(null);
  const keys = useMemo(() => groups.map(group => `${geometryKey}:${group.key}:${group.estimatedHeight}`), [geometryKey, groups]);
  const heights = useMemo(() => groups.map((group, index) => measurements.get(keys[index]) ?? group.estimatedHeight * zoom), [groups, keys, measurements, zoom]);
  const geometry = useRef({ heights, overscan });
  const viewportSize = useRef({ headerHeight: 0, height: 600 });
  const [window, setWindow] = useState(() => computeVirtualGroupWindow(heights, 0, 600, overscan));
  const renderedWindow = useRef(window);

  useLayoutEffect(() => { renderedWindow.current = window; }, [window]);

  const measureViewport = useCallback(() => {
    if (!container) return;
    const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const top = Math.max(0, container.scrollTop - headerHeight);
    const height = container.clientHeight || 600;
    viewportSize.current = { headerHeight, height };
    setWindow(previous => resolveBufferedGroupWindow(previous, geometry.current.heights, top, height, geometry.current.overscan));
  }, [container]);

  useLayoutEffect(() => {
    geometry.current = { heights, overscan };
    measureViewport();
  }, [heights, overscan, measureViewport]);

  useLayoutEffect(() => {
    measureViewport();
    if (!container) return;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, measureViewport]);

  useLayoutEffect(() => {
    if (!container) return;
    const nodes = [...container.querySelectorAll<HTMLElement>('tbody[data-virtual-group]')];
    const measure = () => {
      // Read every group before committing state; never interleave geometry reads and DOM writes.
      const sizes = nodes.map(node => [Number(node.dataset.virtualGroup), node.getBoundingClientRect().height] as const);
      setMeasurements(previous => {
        const next = new Map(keys.flatMap(key => previous.has(key) ? [[key, previous.get(key)!] as const] : []));
        let changed = next.size !== previous.size;
        for (const [index, height] of sizes) {
          if (height <= 0 || !keys[index]) continue;
          if (Math.abs((next.get(keys[index]) ?? 0) - height) > 0.5) {
            next.set(keys[index], height);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [container, keys, window.start, window.end]);

  useLayoutEffect(() => {
    if (container) container.scrollTop = 0;
    measureViewport();
  }, [container, measureViewport, resetKey]);

  useLayoutEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const onScroll = useCallback(() => {
    if (!container) return;
    const top = Math.max(0, container.scrollTop - viewportSize.current.headerHeight);
    const totalHeight = geometry.current.heights.reduce((sum, height) => sum + height, 0);
    if (!isVirtualGroupViewportCovered(renderedWindow.current, totalHeight, top, viewportSize.current.height)) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      // A large scroll has exhausted overscan; do not paint spacers while waiting another frame.
      flushSync(measureViewport);
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measureViewport();
    });
  }, [container, measureViewport]);

  return { ...window, containerRef: setContainer, onScroll };
}
