import type { VirtualTableWindow } from './virtual-table-rows';

export interface VirtualAxisBuffer {
  before: number;
  after: number;
}

export function directionalVirtualBuffer(delta: number, elapsed: number, base: number, maximum: number): VirtualAxisBuffer {
  const ahead = Math.min(maximum, base + Math.abs(delta) / Math.max(8, elapsed) * 80);
  return delta < 0 ? { before: ahead, after: base } : { before: base, after: ahead };
}

export function computeBufferedAxisWindow(sizes: number[], position: number, extent: number, buffer: VirtualAxisBuffer): VirtualTableWindow {
  const offsets = [0];
  for (const size of sizes) offsets.push(offsets[offsets.length - 1] + size);
  const firstPixel = Math.max(0, position - buffer.before);
  const lastPixel = Math.max(0, position) + Math.max(0, extent) + buffer.after;
  let start = 0;
  while (start < sizes.length && offsets[start + 1] <= firstPixel) start++;
  let end = start;
  while (end < sizes.length && offsets[end] < lastPixel) end++;
  return { start, end, topSpacerHeight: offsets[start], bottomSpacerHeight: offsets[sizes.length] - offsets[end] };
}

export function resolveBufferedAxisWindow(current: VirtualTableWindow, sizes: number[], position: number, extent: number, buffer: VirtualAxisBuffer): VirtualTableWindow {
  const guard = computeBufferedAxisWindow(sizes, position, extent, { before: buffer.before / 2, after: buffer.after / 2 });
  const valid = current.end <= sizes.length
    && Math.abs(current.topSpacerHeight - sizes.slice(0, current.start).reduce((sum, size) => sum + size, 0)) < 0.000001
    && Math.abs(current.bottomSpacerHeight - sizes.slice(current.end).reduce((sum, size) => sum + size, 0)) < 0.000001;
  if (valid && current.start <= guard.start && current.end >= guard.end) return current;
  const next = computeBufferedAxisWindow(sizes, position, extent, buffer);
  return current.start === next.start && current.end === next.end
    && current.topSpacerHeight === next.topSpacerHeight && current.bottomSpacerHeight === next.bottomSpacerHeight ? current : next;
}

export function virtualSectionWindow(window: { start: number; end: number }, offset: number, count: number) {
  const start = Math.max(0, Math.min(count, window.start - offset));
  const end = Math.max(start, Math.min(count, window.end - offset));
  return { start, end, before: start, after: count - end };
}
