'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Calculator, GripHorizontal, X } from 'lucide-react';
import type { SelectionStats } from '@/lib/mrp/fg-monthly-selection';

export interface FloatingPanelPoint {
  x: number;
  y: number;
}

export interface FloatingPanelSize {
  width: number;
  height: number;
}

const VIEWPORT_MARGIN = 8;
const INITIAL_RIGHT_GAP = 24;
const INITIAL_TOP = 112;

export function clampFloatingPanelPosition(
  point: FloatingPanelPoint,
  panel: FloatingPanelSize,
  viewport: FloatingPanelSize,
  margin = VIEWPORT_MARGIN,
): FloatingPanelPoint {
  const safeMargin = Math.max(0, margin);
  const maxX = Math.max(safeMargin, viewport.width - panel.width - safeMargin);
  const maxY = Math.max(safeMargin, viewport.height - panel.height - safeMargin);
  return {
    x: Math.min(maxX, Math.max(safeMargin, point.x)),
    y: Math.min(maxY, Math.max(safeMargin, point.y)),
  };
}

export function resolveFloatingPanelInitialPosition(
  panel: FloatingPanelSize,
  viewport: FloatingPanelSize,
): FloatingPanelPoint {
  return clampFloatingPanelPosition({
    x: viewport.width - panel.width - INITIAL_RIGHT_GAP,
    y: INITIAL_TOP,
  }, panel, viewport);
}

function samePoint(a: FloatingPanelPoint, b: FloatingPanelPoint) {
  return a.x === b.x && a.y === b.y;
}

interface FloatingSelectionSummaryProps {
  stats: SelectionStats | null;
  isSelecting?: boolean;
  warning?: string | null;
  onShowCalculation?: (() => void) | null;
  onClear: () => void;
}

export function FloatingSelectionSummary({
  stats,
  isSelecting = false,
  warning,
  onShowCalculation,
  onClear,
}: FloatingSelectionSummaryProps) {
  const hasCalculationAction = Boolean(onShowCalculation);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<FloatingPanelPoint | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPosition: FloatingPanelPoint;
  } | null>(null);

  const panelSize = useCallback((): FloatingPanelSize | null => {
    const panel = panelRef.current;
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  const viewportSize = useCallback((): FloatingPanelSize => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }), []);

  const placeWithinViewport = useCallback((next: FloatingPanelPoint) => {
    const size = panelSize();
    if (!size) return next;
    return clampFloatingPanelPosition(next, size, viewportSize());
  }, [panelSize, viewportSize]);

  const resetPosition = useCallback(() => {
    const size = panelSize();
    if (!size) return;
    setPosition(resolveFloatingPanelInitialPosition(size, viewportSize()));
  }, [panelSize, viewportSize]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (stats) return;
    dragRef.current = null;
    setIsDragging(false);
  }, [stats]);

  useLayoutEffect(() => {
    if (!mounted || !stats) return;
    const size = panelSize();
    if (!size) return;
    setPosition((current) => {
      const next = current
        ? clampFloatingPanelPosition(current, size, viewportSize())
        : resolveFloatingPanelInitialPosition(size, viewportSize());
      return current && samePoint(current, next) ? current : next;
    });
  }, [hasCalculationAction, mounted, panelSize, stats, viewportSize, warning]);

  useEffect(() => {
    if (!mounted) return;
    const handleResize = () => {
      setPosition((current) => {
        if (!current) return current;
        const next = placeWithinViewport(current);
        return samePoint(current, next) ? current : next;
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [mounted, placeWithinViewport]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isSelecting || !position) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: position,
    };
    setIsDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPosition(placeWithinViewport({
      x: drag.startPosition.x + event.clientX - drag.startClientX,
      y: drag.startPosition.y + event.clientY - drag.startClientY,
    }));
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const moveByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!position) return;
    if (event.key === 'Home') {
      event.preventDefault();
      resetPosition();
      return;
    }
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    setPosition(placeWithinViewport({
      x: position.x + direction[0] * step,
      y: position.y + direction[1] * step,
    }));
  };

  if (!mounted || !stats) return null;

  const formattedSum = stats.sum.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const formattedAverage = stats.avg.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return createPortal(
    <div
      ref={panelRef}
      role="region"
      aria-label="框選計算"
      className={`fixed left-0 top-0 z-[80] overflow-hidden rounded-md border border-slate-400 bg-white shadow-[0_16px_40px_-16px_rgba(15,23,42,0.55)] ${
        isSelecting ? 'pointer-events-none' : 'pointer-events-auto'
      }`}
      style={{
        width: 'min(21rem, calc(100vw - 1rem))',
        maxHeight: 'calc(100vh - 1rem)',
        transform: `translate3d(${position?.x ?? 0}px, ${position?.y ?? 0}px, 0)`,
        visibility: position ? 'visible' : 'hidden',
        willChange: isDragging ? 'transform' : undefined,
      }}
      data-floating-selection-summary
    >
      <div className="flex min-h-9 items-stretch border-b border-slate-300 bg-slate-100">
        <div
          role="button"
          tabIndex={0}
          aria-label="拖曳框選計算視窗；方向鍵可移動，Home 重設位置"
          className={`flex min-w-0 flex-1 touch-none select-none items-center gap-2 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onKeyDown={moveByKeyboard}
          onDoubleClick={resetPosition}
        >
          <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-xs font-bold text-slate-800">框選計算</div>
        </div>
        <button
          type="button"
          onClick={onClear}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-l border-slate-300 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
          aria-label="清除框選"
          title="清除框選"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200">
        <div className="min-w-0 px-2 py-1">
          <div className="text-[10px] font-medium text-slate-500">數字格</div>
          <div className="break-all font-mono text-sm font-bold tabular-nums text-blue-700">{stats.count.toLocaleString()}</div>
        </div>
        <div className="min-w-0 px-2 py-1">
          <div className="text-[10px] font-medium text-slate-500">合計</div>
          <div className="break-all font-mono text-sm font-bold tabular-nums text-slate-900" title={formattedSum}>{formattedSum}</div>
        </div>
        <div className="min-w-0 px-2 py-1">
          <div className="text-[10px] font-medium text-slate-500">平均</div>
          <div className="break-all font-mono text-sm font-bold tabular-nums text-slate-900" title={formattedAverage}>{formattedAverage}</div>
        </div>
      </div>

      {(warning || hasCalculationAction) && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
          {warning && (
            <div
              className="flex min-w-0 flex-1 items-start gap-1.5 text-[11px] leading-snug text-amber-800"
              title={warning}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{warning}</span>
            </div>
          )}
          {onShowCalculation && (
            <button
              type="button"
              onClick={onShowCalculation}
              className="ml-auto inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded border border-blue-300 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
              查看算式
            </button>
          )}
        </div>
      )}

      <span className="sr-only" aria-live={isSelecting ? 'off' : 'polite'}>
        框選 {stats.count} 個數字格，合計 {formattedSum}，平均 {formattedAverage}
      </span>
    </div>,
    document.body,
  );
}
