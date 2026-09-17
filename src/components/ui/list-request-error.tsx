'use client';

export function ListRequestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <span className="min-w-0 flex-1">資料讀取失敗：{message}</span>
      <button type="button" onClick={onRetry} className="shrink-0 rounded border border-red-300 bg-white px-3 py-1 hover:bg-red-100">
        重試
      </button>
    </div>
  );
}
