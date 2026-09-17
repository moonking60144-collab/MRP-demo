'use client';

interface TablePaginationProps {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  /** 數量單位（品項 / 料件…），預設「品項」 */
  unitLabel?: string;
}

// 每頁筆數選項 —— 最大 200 即上限，避免一次撈太多影響效能
const PAGE_SIZES = [25, 50, 100, 200];

/** 表格頁碼 —— 每頁筆數 + 翻頁 + 總數，放在標題列右側（取代底部獨立頁碼列）。 */
export function TablePagination({
  page,
  totalPages,
  total,
  limit,
  onPageChange,
  onLimitChange,
  unitLabel = '品項',
}: TablePaginationProps) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500">
      <label className="flex items-center gap-1">
        每頁
        <select
          value={limit}
          onChange={(e) => onLimitChange(parseInt(e.target.value, 10))}
          className="border border-slate-300 rounded px-1 py-0.5 text-xs"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-1.5 py-0.5 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
            aria-label="上一頁"
          >
            ‹
          </button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="px-1.5 py-0.5 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
            aria-label="下一頁"
          >
            ›
          </button>
        </div>
      )}
      <span>{total} {unitLabel}</span>
    </div>
  );
}
