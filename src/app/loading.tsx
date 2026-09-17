import { FullLoader } from '@/components/ui/loader';

// 路由切換 / 首次載入時 Next 自動顯示（在 layout 內，側欄保留、內容區置中轉圈圈）。
export default function Loading() {
  return <FullLoader />;
}
