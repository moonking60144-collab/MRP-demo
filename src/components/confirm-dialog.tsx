'use client';

/**
 * Promise-based confirm dialog — styled replacement for window.confirm().
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ message: '確定要轉單？' }))) return;
 *
 * Resolves true on confirm, false on cancel / backdrop click / Escape.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  // Escape cancels the dialog (only while open).
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
          onClick={() => close(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {opts.title && (
              <div className="border-b px-5 py-3 text-base font-semibold text-slate-800">
                {opts.title}
              </div>
            )}
            <div className="whitespace-pre-line px-5 py-4 text-sm leading-6 text-slate-700">
              {opts.message}
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <button
                onClick={() => close(false)}
                className="rounded px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              >
                {opts.cancelText ?? '取消'}
              </button>
              <button
                onClick={() => close(true)}
                className={`rounded px-4 py-1.5 text-sm font-medium text-white ${
                  opts.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {opts.confirmText ?? '確定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
