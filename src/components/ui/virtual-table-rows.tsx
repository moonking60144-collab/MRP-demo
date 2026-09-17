'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react';

export interface VirtualTableWindow {
  start: number;
  end: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

export interface VirtualTableViewport {
  scrollTop: number;
  height: number;
}

interface VirtualTableWindowInput {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan: number;
  enabled: boolean;
}

const ROW_HEIGHT_EPSILON = 0.5;

export function resolveVirtualTableRowHeight(
  current: number,
  measured: number,
): number {
  if (!Number.isFinite(measured) || measured <= 0) return current;
  return Math.abs(current - measured) > ROW_HEIGHT_EPSILON ? measured : current;
}

export function summarizeVirtualTableRowHeights(heights: number[]) {
  const validHeights = heights.filter((height) => Number.isFinite(height) && height > 0);
  if (validHeights.length === 0) return null;
  const min = Math.min(...validHeights);
  const max = Math.max(...validHeights);
  return { min, max, spread: max - min };
}

export interface VirtualTableRowNodeCache<T> {
  items: T[];
  renderVersion: unknown;
  nodes: Map<number, ReactNode>;
}

export function resolveVirtualTableRowNodeCache<T>({
  current,
  end,
  items,
  renderRow,
  renderVersion,
  start,
}: {
  current: VirtualTableRowNodeCache<T> | null;
  end: number;
  items: T[];
  renderRow: (item: T, rowIndex: number) => ReactNode;
  renderVersion: unknown;
  start: number;
}): VirtualTableRowNodeCache<T> {
  const canReuse = current?.items === items && current.renderVersion === renderVersion;
  const nodes = new Map<number, ReactNode>();
  const boundedStart = Math.max(0, Math.min(items.length, Math.floor(start)));
  const boundedEnd = Math.max(
    boundedStart,
    Math.min(items.length, Math.floor(end)),
  );
  for (let rowIndex = boundedStart; rowIndex < boundedEnd; rowIndex++) {
    if (canReuse && current.nodes.has(rowIndex)) {
      nodes.set(rowIndex, current.nodes.get(rowIndex));
      continue;
    }
    nodes.set(rowIndex, renderRow(items[rowIndex], rowIndex));
  }
  return { items, renderVersion, nodes };
}

export function updateVirtualTableWindow(
  current: VirtualTableWindow,
  next: VirtualTableWindow,
): VirtualTableWindow {
  return current.start === next.start
    && current.end === next.end
    && current.topSpacerHeight === next.topSpacerHeight
    && current.bottomSpacerHeight === next.bottomSpacerHeight
    ? current
    : next;
}

export function computeVirtualTableWindow({
  count,
  scrollTop,
  viewportHeight,
  rowHeight,
  overscan,
  enabled,
}: VirtualTableWindowInput): VirtualTableWindow {
  if (!enabled || count === 0) {
    return { start: 0, end: count, topSpacerHeight: 0, bottomSpacerHeight: 0 };
  }

  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewportHeight = viewportHeight > 0 ? viewportHeight : 600;
  const visibleCount = Math.ceil(safeViewportHeight / safeRowHeight);
  const effectiveOverscan = Math.max(0, Math.floor(overscan));
  const windowSize = Math.min(count, visibleCount + effectiveOverscan * 2);
  const desiredStart = Math.max(
    0,
    Math.floor(Math.max(0, scrollTop) / safeRowHeight) - effectiveOverscan,
  );
  const end = Math.min(count, desiredStart + windowSize);
  const start = Math.max(0, end - windowSize);

  return {
    start,
    end,
    topSpacerHeight: start * safeRowHeight,
    bottomSpacerHeight: Math.max(0, (count - end) * safeRowHeight),
  };
}

export function resolveVirtualTableWindow(
  current: VirtualTableWindow,
  input: VirtualTableWindowInput,
): VirtualTableWindow {
  const next = computeVirtualTableWindow(input);
  if (!input.enabled || input.count === 0) return updateVirtualTableWindow(current, next);

  const safeRowHeight = Math.max(1, input.rowHeight);
  const safeViewportHeight = input.viewportHeight > 0 ? input.viewportHeight : 600;
  const safeScrollTop = Math.max(0, input.scrollTop);
  const visibleStart = Math.min(input.count, Math.floor(safeScrollTop / safeRowHeight));
  const visibleEnd = Math.min(
    input.count,
    Math.ceil((safeScrollTop + safeViewportHeight) / safeRowHeight),
  );
  const guardRows = Math.ceil(Math.max(0, Math.floor(input.overscan)) / 2);
  const guardedVisibleStart = Math.max(0, visibleStart - guardRows);
  const guardedVisibleEnd = Math.min(input.count, visibleEnd + guardRows);
  const currentIsValid = current.start >= 0
    && current.end <= input.count
    && current.start <= current.end
    && current.end - current.start === next.end - next.start
    && current.topSpacerHeight === current.start * safeRowHeight
    && current.bottomSpacerHeight === (input.count - current.end) * safeRowHeight;

  if (
    currentIsValid
    && current.start <= guardedVisibleStart
    && current.end >= guardedVisibleEnd
  ) return current;

  return updateVirtualTableWindow(current, next);
}

export function useVirtualTableRows({
  count,
  rowHeight,
  overscan = 8,
  enabled = true,
  geometryKey,
  resetKey,
}: {
  count: number;
  rowHeight: number;
  overscan?: number;
  enabled?: boolean;
  geometryKey?: string | number;
  resetKey?: string | number;
}) {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);
  const frameRef = useRef<number | null>(null);
  const rowMeasurementFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<VirtualTableViewport | null>(null);
  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const [effectiveRowHeight, setEffectiveRowHeight] = useState(rowHeight);
  const [window, setWindow] = useState<VirtualTableWindow>(() => computeVirtualTableWindow({
    count,
    scrollTop: 0,
    viewportHeight: 0,
    rowHeight,
    overscan,
    enabled,
  }));
  const inputRef = useRef({ count, enabled, overscan, rowHeight: effectiveRowHeight });
  inputRef.current = { count, enabled, overscan, rowHeight: effectiveRowHeight };

  const cancelScheduledViewport = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingViewportRef.current = null;
  }, []);

  const commitViewport = useCallback((viewport: VirtualTableViewport) => {
    const input = inputRef.current;
    setWindow((current) => resolveVirtualTableWindow(current, {
      count: input.count,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.height,
      rowHeight: input.rowHeight,
      overscan: input.overscan,
      enabled: input.enabled,
    }));
  }, []);

  const measure = useCallback(() => {
    if (!containerNode) return;
    const next = { scrollTop: containerNode.scrollTop, height: containerNode.clientHeight };
    scrollTopRef.current = next.scrollTop;
    viewportHeightRef.current = next.height;
    pendingViewportRef.current = null;
    commitViewport(next);
  }, [commitViewport, containerNode]);

  useLayoutEffect(() => {
    measure();
    if (!containerNode || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(containerNode);
    return () => observer.disconnect();
  }, [containerNode, measure]);

  const measureRowGeometry = useCallback(() => {
    if (!containerNode) return;
    const rows = Array.from(
      containerNode.querySelectorAll<HTMLTableRowElement>('tbody > tr[data-virtual-row]'),
    );
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    const summary = summarizeVirtualTableRowHeights(heights);
    if (!summary) return;

    if (process.env.NODE_ENV !== 'production' && summary.spread > ROW_HEIGHT_EPSILON) {
      console.warn('Virtual table rows are not uniform', {
        geometryKey,
        min: summary.min,
        max: summary.max,
        spread: summary.spread,
      });
    }

    setEffectiveRowHeight((current) => resolveVirtualTableRowHeight(current, heights[0]));
  }, [containerNode, geometryKey]);

  useLayoutEffect(() => {
    measureRowGeometry();
    if (!containerNode || typeof ResizeObserver === 'undefined') return;
    const rows = Array.from(
      containerNode.querySelectorAll<HTMLTableRowElement>('tbody > tr[data-virtual-row]'),
    );
    if (rows.length === 0) return;

    const observer = new ResizeObserver(() => {
      if (rowMeasurementFrameRef.current !== null) return;
      rowMeasurementFrameRef.current = requestAnimationFrame(() => {
        rowMeasurementFrameRef.current = null;
        measureRowGeometry();
      });
    });
    rows.forEach((row) => observer.observe(row));

    return () => {
      observer.disconnect();
      if (rowMeasurementFrameRef.current !== null) {
        cancelAnimationFrame(rowMeasurementFrameRef.current);
        rowMeasurementFrameRef.current = null;
      }
    };
  }, [containerNode, geometryKey, measureRowGeometry, window.end, window.start]);

  useLayoutEffect(() => {
    measure();
  }, [count, effectiveRowHeight, enabled, measure, overscan]);

  useEffect(() => {
    cancelScheduledViewport();
    if (containerNode) containerNode.scrollTop = 0;
    scrollTopRef.current = 0;
    commitViewport({ scrollTop: 0, height: containerNode?.clientHeight ?? 0 });
  }, [cancelScheduledViewport, commitViewport, containerNode, resetKey]);

  useEffect(() => () => {
    cancelScheduledViewport();
    if (rowMeasurementFrameRef.current !== null) {
      cancelAnimationFrame(rowMeasurementFrameRef.current);
    }
  }, [cancelScheduledViewport]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!inputRef.current.enabled) return;
    const node = event.currentTarget;
    const nextScrollTop = node.scrollTop;
    viewportHeightRef.current = node.clientHeight;
    if (nextScrollTop === scrollTopRef.current) return;
    scrollTopRef.current = nextScrollTop;
    pendingViewportRef.current = {
      scrollTop: nextScrollTop,
      height: node.clientHeight,
    };
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (!next) return;
      commitViewport(next);
    });
  }, [commitViewport]);

  const renderWindow = resolveVirtualTableWindow(window, {
    count,
    scrollTop: scrollTopRef.current,
    viewportHeight: viewportHeightRef.current,
    rowHeight: effectiveRowHeight,
    overscan,
    enabled,
  });

  return { containerRef, onScroll, rowHeight: effectiveRowHeight, ...renderWindow };
}

export function useVirtualTableRowNodes<T>({
  end,
  items,
  renderRow,
  renderVersion,
  start,
}: {
  end: number;
  items: T[];
  renderRow: (item: T, rowIndex: number) => ReactNode;
  renderVersion: unknown;
  start: number;
}) {
  const cacheRef = useRef<VirtualTableRowNodeCache<T> | null>(null);
  const renderRowRef = useRef(renderRow);
  renderRowRef.current = renderRow;

  return useMemo(() => {
    const next = resolveVirtualTableRowNodeCache({
      current: cacheRef.current,
      end,
      items,
      renderRow: renderRowRef.current,
      renderVersion,
      start,
    });
    cacheRef.current = next;
    return [...next.nodes.values()];
  }, [end, items, renderVersion, start]);
}

export function resolveVirtualTableSpacerHeight(height: number, zoom: number) {
  return height / zoom;
}

export function VirtualTableSpacer({
  height,
  colSpan,
  zoom,
}: {
  height: number;
  colSpan: number;
  zoom: number;
}) {
  if (height <= 0) return null;
  const layoutHeight = resolveVirtualTableSpacerHeight(height, zoom);
  return (
    <tr aria-hidden="true" data-virtual-spacer>
      <td
        colSpan={Math.max(1, colSpan)}
        className="border-0 p-0"
        style={{ height: layoutHeight, minHeight: layoutHeight }}
      />
    </tr>
  );
}
