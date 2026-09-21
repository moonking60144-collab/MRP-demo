'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { updateVirtualTableWindow, type VirtualTableWindow } from './virtual-table-rows';
import { computeBufferedAxisWindow, directionalVirtualBuffer, resolveBufferedAxisWindow } from './virtual-table-axis';

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

export function useVirtualTableGroups({ groups, zoom, geometryKey, resetKey, overscan = 1, columns }: {
  groups: VirtualTableGroup[];
  zoom: number;
  geometryKey: string;
  resetKey: string;
  overscan?: number;
  columns?: { widths: number[]; offset: number; frozenWidth: number };
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [measurements, setMeasurements] = useState<Map<string, number>>(() => new Map());
  const frame = useRef<number | null>(null);
  const keys = useMemo(() => groups.map(group => `${geometryKey}:${group.key}:${group.estimatedHeight}`), [geometryKey, groups]);
  const heights = useMemo(() => groups.map((group, index) => measurements.get(keys[index]) ?? group.estimatedHeight * zoom), [groups, keys, measurements, zoom]);
  const columnWidths = useMemo(() => columns?.widths.map(width => width * zoom) ?? [], [columns, zoom]);
  const geometry = useRef({ heights, overscan, zoom, columns, columnWidths });
  const viewportSize = useRef({ height: 600 });
  const motion = useRef({ top: 0, left: 0, time: 0, deltaTop: 0, deltaLeft: 0, elapsed: 160 });
  const [window, setWindow] = useState(() => computeVirtualGroupWindow(heights, 0, 600, overscan));
  const renderedWindow = useRef(window);
  const [columnWindow, setColumnWindow] = useState<VirtualTableWindow | null>(null);
  const renderedColumns = useRef(columnWindow);

  useLayoutEffect(() => { renderedWindow.current = window; }, [window]);
  useLayoutEffect(() => { renderedColumns.current = columnWindow; }, [columnWindow]);

  const columnViewport = useCallback(() => {
    const config = geometry.current;
    if (!container || !config.columns) return { left: 0, width: 0 };
    const right = Math.max(0, container.scrollLeft + container.clientWidth - config.columns.offset * config.zoom);
    const left = Math.max(0, Math.min(right, container.scrollLeft + (config.columns.frozenWidth - config.columns.offset) * config.zoom));
    return { left, width: right - left };
  }, [container]);

  const measureViewport = useCallback(() => {
    if (!container) return;
    const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const footerHeight = container.querySelector('tfoot')?.getBoundingClientRect().height ?? 0;
    const top = container.scrollTop;
    const height = Math.max(1, (container.clientHeight || 600) - headerHeight - footerHeight);
    viewportSize.current = { height };
    const config = geometry.current;
    const recent = performance.now() - motion.current.time < 160;
    const base = config.overscan * 24 * config.zoom;
    const verticalBuffer = directionalVirtualBuffer(recent ? motion.current.deltaTop : 0, motion.current.elapsed, base, Math.max(base, 480 * config.zoom));
    setWindow(previous => resolveBufferedAxisWindow(previous, config.heights, top, height, verticalBuffer));
    if (config.columns) {
      const viewport = columnViewport();
      const buffer = directionalVirtualBuffer(recent ? motion.current.deltaLeft : 0, motion.current.elapsed, 240 * config.zoom, 720 * config.zoom);
      setColumnWindow(previous => previous
        ? resolveBufferedAxisWindow(previous, config.columnWidths, viewport.left, viewport.width, buffer)
        : computeBufferedAxisWindow(config.columnWidths, viewport.left, viewport.width, buffer));
    }
  }, [columnViewport, container]);

  useLayoutEffect(() => {
    geometry.current = { heights, overscan, zoom, columns, columnWidths };
    measureViewport();
  }, [heights, overscan, zoom, columns, columnWidths, measureViewport]);

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
          if (Math.abs((next.get(keys[index]) ?? geometry.current.heights[index]) - height) > 0.5) {
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
    const top = container.scrollTop;
    const left = container.scrollLeft;
    if (top === motion.current.top && left === motion.current.left) return;
    const time = performance.now();
    motion.current = { top, left, time, deltaTop: top - motion.current.top, deltaLeft: left - motion.current.left,
      elapsed: Math.max(8, time - motion.current.time) };
    const totalHeight = geometry.current.heights.reduce((sum, height) => sum + height, 0);
    const horizontal = columnViewport();
    const totalWidth = geometry.current.columnWidths.reduce((sum, width) => sum + width, 0);
    const columnsCovered = !geometry.current.columns || !renderedColumns.current || horizontal.width === 0
      || isVirtualGroupViewportCovered(renderedColumns.current, totalWidth, horizontal.left, horizontal.width);
    if (!columnsCovered || !isVirtualGroupViewportCovered(renderedWindow.current, totalHeight, top, viewportSize.current.height)) {
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
  }, [columnViewport, container, measureViewport]);

  return { ...window, columnWindow, containerRef: setContainer, onScroll };
}
