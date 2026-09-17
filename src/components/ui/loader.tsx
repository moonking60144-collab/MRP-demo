/** 置中的 CSS 轉圈圈 + 「讀取中」文字。整區/整頁載入狀態統一用這個。 */
export function Loader({ label = '讀取中', className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-12 text-slate-400 ${className}`}>
      <div className="w-8 h-8 border-[3px] border-slate-200 border-t-blue-600 rounded-full animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** 填滿父層高度並置中（給整頁 / 路由切換用）。 */
export function FullLoader({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center w-full h-full min-h-[60vh]">
      <Loader label={label} />
    </div>
  );
}
