'use client';

/**
 * Lightweight toast notifications — non-blocking replacement for window.alert().
 * Stacked top-right, auto-dismiss, optional action button.
 *
 *   const showToast = useToast();
 *   showToast({ type: 'success', message: '轉單成功', action: { label: '開啟', onClick } });
 */
import { createContext, useCallback, useContext, useState } from 'react';

type ToastType = 'success' | 'error' | 'info';

export interface ToastOptions {
  type?: ToastType;
  message: string;
  /** Optional inline action (e.g. open a link). Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss after ms. 0 = stay until manually closed. Default 4000. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((opts: ToastOptions) => void) | null>(null);

export function useToast(): (opts: ToastOptions) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const STYLES: Record<ToastType, string> = {
  success: 'border-green-500 bg-green-50 text-green-800',
  error:   'border-red-500 bg-red-50 text-red-800',
  info:    'border-slate-400 bg-white text-slate-800',
};

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((opts: ToastOptions) => {
    const id = Date.now() + Math.random();
    const item: ToastItem = { id, type: 'info', duration: 4000, ...opts };
    setToasts((prev) => [...prev, item]);
    if (item.duration && item.duration > 0) {
      setTimeout(() => dismiss(id), item.duration);
    }
  }, [dismiss]);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="fixed top-4 right-4 z-[9998] flex max-w-sm flex-col gap-2">
        {toasts.map((t) => {
          const type = t.type ?? 'info';
          return (
            <div
              key={t.id}
              className={`flex items-start gap-2 rounded border-l-4 px-4 py-3 shadow-lg ${STYLES[type]}`}
            >
              <span className="font-bold leading-5">{ICONS[type]}</span>
              <div className="flex-1 whitespace-pre-line text-sm leading-5">{t.message}</div>
              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                  className="shrink-0 text-sm font-medium underline"
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 leading-5 text-slate-400 hover:text-slate-700"
                aria-label="關閉"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
