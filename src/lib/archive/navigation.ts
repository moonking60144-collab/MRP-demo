import type { ArchiveView } from './browser-contract';

export const ARCHIVE_PAGES: Record<string, { title: string; views: readonly ArchiveView[] }> = {
  '/fg-monthly': { title: '成品月推移', views: ['fg-monthly', 'fg-periods'] },
  '/components': { title: '元件週推移', views: ['component-weekly', 'component-periods'] },
  '/sales-meeting': { title: '產銷會議表', views: ['sales-meeting', 'sales-periods'] },
  '/production-plans': { title: '相關生產計劃', views: ['production-plans'] },
  '/source-data': { title: '原始資料', views: ['inventory', 'orders', 'forecasts', 'production-plans', 'work-orders', 'bom', 'purchases', 'movements'] },
};
