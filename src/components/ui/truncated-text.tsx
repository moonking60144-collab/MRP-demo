'use client';

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface TruncatedTextProps {
  value: string;
  /** 套用在截斷文字 div 上的 className（字型/顏色等） */
  className?: string;
  /** 截斷 div 的 maxWidth（px） */
  maxWidth?: number;
}

const TIP_WIDTH = 360;

/**
 * 單行截斷文字 + hover 浮層顯示全文。
 *
 * 浮層用 portal 掛到 <body> 並 position:fixed，才不會被表格的 overflow-auto
 * 容器裁掉；只有文字真的被截斷時才顯示。靠近視窗底部時自動往上翻。
 */
export function TruncatedText({ value, className, maxWidth }: TruncatedTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return; // 沒被截斷就不顯示
    const r = el.getBoundingClientRect();
    const above = r.bottom > window.innerHeight - 180;
    setTip({
      left: Math.min(Math.max(8, r.left), window.innerWidth - TIP_WIDTH - 12),
      top: above ? r.top - 4 : r.bottom + 4,
      above,
    });
  }, []);

  return (
    <>
      <div
        ref={ref}
        className={`truncate ${className ?? ''}`}
        style={maxWidth != null ? { maxWidth } : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
      >
        {value}
      </div>
      {tip &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[100] rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs leading-relaxed text-slate-100 shadow-2xl whitespace-pre-wrap break-words"
            style={{
              left: tip.left,
              top: tip.top,
              width: TIP_WIDTH,
              transform: tip.above ? 'translateY(-100%)' : undefined,
            }}
          >
            {value}
          </div>,
          document.body,
        )}
    </>
  );
}
