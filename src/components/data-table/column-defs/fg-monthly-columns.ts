import type { MrpColumnDef, ColumnFilterType } from '../types';
import { WAREHOUSE_STOCK_GROUPS } from '@/lib/mrp/warehouse-stock';

const INVENTORY_DESCRIPTION = '庫存資料檢核結果，不代表庫存足夠。';
const MATERIAL_DESCRIPTION = '依工令 BOM 與元件週推提供提醒；未做逐單配料，材料缺口不等於成品欠產量。';
const SHORTAGE_DESCRIPTION = '成品供需推算結果，不代表原料已備齊。';

export const DB_SOURCE_COLUMN: MrpColumnDef = {
  id: 'dbSource', header: '來源', filterType: 'text', width: 55, align: 'center', defaultVisible: false,
};

// FG Monthly Simple view columns
export const FG_MONTHLY_SIMPLE_COLUMNS: MrpColumnDef[] = [
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'customerPartNo', header: '客戶料號', filterType: 'text' },
  { id: 'customerCode', header: '客戶', filterType: 'enum', enumValues: [] },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'forgingMachine', header: '機台', filterType: 'text', width: 60 },
  { id: 'forgingParent', header: '鍛造母件', filterType: 'text' },
  { id: 'sortGroup', header: '排序', filterType: 'numeric', align: 'center', width: 50 },
  { id: 'currentStockPc', header: '可用成品庫存pc', filterType: 'numeric', align: 'right', mono: true },
  { id: 'inventoryAnomalyCount', header: '庫存資料', description: INVENTORY_DESCRIPTION, filterType: 'numeric', sortable: false, align: 'center', width: 75 },
  { id: 'materialReminder', header: '材料提醒', description: MATERIAL_DESCRIPTION, filterType: 'text', filterable: false, sortable: false, align: 'center', width: 110 },
  { id: 'woScheduled', header: '鍛造已排', filterType: 'numeric', align: 'right', mono: true },
  { id: 'woUnscheduled', header: '鍛造待排', filterType: 'numeric', align: 'right', mono: true },
  { id: 'woTotal', header: '鍛造未結合計', filterType: 'numeric', align: 'right', mono: true },
  { id: 'totalUnshippedQty', header: '訂單未結', filterType: 'numeric', align: 'right', mono: true },
  { id: 'shouldPlanProduction', header: 'ST1-08應排產', filterType: 'boolean', align: 'center' },
  { id: 'shortageStartPeriod', header: '成品缺料期', description: SHORTAGE_DESCRIPTION, filterType: 'numeric', align: 'center' },
  { id: 'shortageStartPeriodNoPlan', header: '成品缺料期（無計劃）', description: SHORTAGE_DESCRIPTION, filterType: 'numeric', align: 'center' },
  { id: 'wfgStockPc', header: WAREHOUSE_STOCK_GROUPS.INTERNAL.label, filterType: 'numeric', align: 'right', mono: true },
  { id: 'ye1StockPc', header: WAREHOUSE_STOCK_GROUPS.YE1.label, filterType: 'numeric', align: 'right', mono: true },
  { id: 'lastPeriodRemainingNoPlan', header: '[期末]剩餘庫存(無計劃量)', filterType: 'numeric', filterable: false, sortable: false, align: 'right', mono: true },
];

// Additional columns shown only in Detailed view
export const FG_MONTHLY_DETAILED_EXTRA_COLUMNS: MrpColumnDef[] = [
  { id: 'firstProcess', header: '製程1', filterType: 'text' },
  { id: 'productStatus', header: '版本狀態', filterType: 'text' },
  { id: 'stockPeriods', header: '備庫期數', filterType: 'numeric', align: 'right' },
  { id: 'unitWeightG', header: '單位重g', filterType: 'numeric', align: 'right', mono: true },
  { id: 'mainMaterialKg', header: '用料kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockPc', header: '不良品庫存pc', filterType: 'numeric', align: 'right', mono: true },
  { id: 'planReportedQty', header: '計畫累計報工', filterType: 'numeric', align: 'right', mono: true },
  { id: 'planClosedQty', header: '計畫累計結案入庫', filterType: 'numeric', align: 'right', mono: true },
  { id: 'priorPlanQty', header: 'ST1-60 前期未結生產計畫', filterType: 'numeric', align: 'right', mono: true },
  { id: 'priorUnshippedQty', header: 'ST1-46 前期訂單未結', filterType: 'numeric', align: 'right', mono: true },
  { id: 'missingForecastPeriods', header: '缺預示期數', filterType: 'numeric', align: 'center' },
];

// All FG Monthly columns (Detailed view shows all)
export const FG_MONTHLY_DETAILED_COLUMNS: MrpColumnDef[] = [
  ...FG_MONTHLY_SIMPLE_COLUMNS,
  ...FG_MONTHLY_DETAILED_EXTRA_COLUMNS,
];

// ============================================================
// Traditional view columns —— 單一來源
// 傳統 view 的「渲染」(fg-monthly-traditional.tsx 的 FROZEN_COLS/STATIC_COLS…)
// 與「欄位顯示/篩選」(FG_MONTHLY_TRADITIONAL_ALL_COLUMNS) 都從這裡衍生，
// 避免欄位 key/label/width 在兩個檔各列一份而漂移。
// 期推移群組 (PERIOD_GROUPS) 是動態 per-month，stable visibility ID 在本檔，
// 實際月份欄渲染留在 component。
// ============================================================

/** 傳統 view 單一欄定義：render 欄位(bg/headerBg) + data-table metadata 合一。 */
export interface FgTradCol {
  key: string;
  label: string;
  description?: string;
  width: number;
  filterType: ColumnFilterType;
  align?: 'left' | 'center' | 'right';
  mono?: boolean;
  /** 期推移格底色（WO / PRIOR 群組用） */
  bg?: string;
  /** 表頭底色（WO / PRIOR 群組用） */
  headerBg?: string;
  /**
   * 此欄的數值「加總有意義」嗎？合計列(footer)與框選加總共用這個旗標
   * 當唯一來源。數量欄(庫存/工令/前期)= true；單位重、排序、期數、缺料期
   * 這類「每件屬性 / 索引」加總無意義 = 不標。
   */
  summable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
}

export const FG_TRAD_FROZEN: FgTradCol[] = [
  { key: 'customerCode', label: '客戶代碼', width: 80, filterType: 'enum' },
  { key: 'partVersion', label: '客料版本', width: 180, filterType: 'text', mono: true },
  { key: 'customerPartNo', label: '客戶料號', width: 160, filterType: 'text' },
  { key: 'erpPartNo', label: 'ERP料號', width: 220, filterType: 'text', mono: true },
  { key: 'forgingParent', label: '鍛造母件', width: 140, filterType: 'text' },
  // Ragic 自由文字（如 "五彩三價,膜厚8μm,耐蝕72hr無白鏽…"），單行截斷
  // 至 190px，hover 由 TruncatedText 浮層顯示全文。
  { key: 'surfaceTreatment', label: '表面處理條件', width: 190, filterType: 'text' },
  { key: 'sortGroup', label: '排序', width: 45, filterType: 'numeric', align: 'center' },
  { key: 'forgingMachine', label: '機台', width: 55, filterType: 'text' },
];

// Status 群組緊接 Part Info 之後（對齊 Ragic d4/22 版面）
export const FG_TRAD_STATUS: FgTradCol[] = [
  { key: 'inventoryAnomalyCount', label: '庫存資料', description: INVENTORY_DESCRIPTION, width: 75, filterType: 'numeric', sortable: false, align: 'center' },
  { key: 'materialReminder', label: '材料提醒', description: MATERIAL_DESCRIPTION, width: 110, filterType: 'text', filterable: false, sortable: false, align: 'center' },
  { key: 'stockPeriods', label: '備庫期數', width: 60, filterType: 'numeric', align: 'center' },
  { key: 'missingForecastPeriods', label: '缺預示期數', width: 75, filterType: 'numeric', align: 'center' },
  { key: 'shortageStartPeriod', label: '成品缺料期', description: SHORTAGE_DESCRIPTION, width: 80, filterType: 'numeric', align: 'center' },
  { key: 'shortageStartPeriodNoPlan', label: '成品缺料期\n（無計劃）', description: SHORTAGE_DESCRIPTION, width: 90, filterType: 'numeric', align: 'center' },
  { key: 'shouldPlanProduction', label: 'ST1-08應排產', width: 75, filterType: 'boolean', align: 'center' },
  { key: 'lastPeriodRemainingNoPlan', label: '[期末]剩餘(無計劃)', width: 100, filterType: 'numeric', filterable: false, sortable: false, align: 'right', mono: true },
];

export const FG_TRAD_STATIC: FgTradCol[] = [
  { key: 'unitWeightG', label: '單位重g', width: 65, filterType: 'numeric', align: 'right', mono: true },
  { key: 'mainMaterialKg', label: '用料kg', width: 65, filterType: 'numeric', align: 'right', mono: true },
  { key: 'currentStockPc', label: '可用成品庫存pc', width: 90, filterType: 'numeric', align: 'right', mono: true, summable: true },
  { key: 'badStockPc', label: '不良品pc', width: 70, filterType: 'numeric', align: 'right', mono: true, summable: true },
];

// 顯示於時間軸末端、剩餘庫存（無計劃量）月份區塊左側。
export const FG_TRAD_WAREHOUSE: FgTradCol[] = [
  { key: 'wfgStockPc', label: WAREHOUSE_STOCK_GROUPS.INTERNAL.label, width: 120, filterType: 'numeric', align: 'right', mono: true, summable: true },
  { key: 'ye1StockPc', label: WAREHOUSE_STOCK_GROUPS.YE1.label, width: 85, filterType: 'numeric', align: 'right', mono: true, summable: true },
];

export const FG_TRAD_WO: FgTradCol[] = [
  { key: 'woScheduled', label: '鍛造已排', width: 70, filterType: 'numeric', align: 'right', mono: true, bg: 'bg-green-100', headerBg: 'bg-green-200', summable: true },
  { key: 'woUnscheduled', label: '鍛造待排', width: 70, filterType: 'numeric', align: 'right', mono: true, bg: 'bg-red-50', headerBg: 'bg-red-100', summable: true },
  { key: 'woTotal', label: '鍛造未結合計', width: 90, filterType: 'numeric', align: 'right', mono: true, bg: 'bg-green-100', headerBg: 'bg-green-200', summable: true },
  { key: 'planReportedQty', label: '計畫累計報工', width: 90, filterType: 'numeric', align: 'right', mono: true, bg: 'bg-blue-50', headerBg: 'bg-blue-100', summable: true },
  { key: 'planClosedQty', label: '計畫累計結案入庫', width: 110, filterType: 'numeric', align: 'right', mono: true, bg: 'bg-orange-50', headerBg: 'bg-orange-100', summable: true },
];

export const FG_TRAD_PLAN_PRIOR: FgTradCol = {
  key: 'priorPlanQty', label: 'ST1-60 前期未結生產計畫', width: 90,
  filterType: 'numeric', align: 'right', mono: true,
  bg: 'bg-yellow-50', headerBg: 'bg-yellow-300', summable: true,
};

export const FG_TRAD_ORDER_PRIOR: FgTradCol = {
  key: 'priorUnshippedQty', label: 'ST1-46 前期訂單未結', width: 90,
  filterType: 'numeric', align: 'right', mono: true,
  bg: 'bg-green-50', headerBg: 'bg-green-200', summable: true,
};

/**
 * 「加總有意義」的欄位 key —— 合計列(footer aggregate)與框選加總共用的單一來源。
 * 後端 /api/fg-monthly 用它組 Prisma _sum；前端 selStats 用 col.summable 判定。
 */
export const FG_TRAD_SUMMABLE_KEYS: string[] = [
  ...FG_TRAD_FROZEN, ...FG_TRAD_STATUS, ...FG_TRAD_STATIC, ...FG_TRAD_WAREHOUSE, ...FG_TRAD_WO,
  FG_TRAD_PLAN_PRIOR, FG_TRAD_ORDER_PRIOR,
].filter((c) => c.summable).map((c) => c.key);

export const FG_TRAD_PERIOD_VISIBILITY_IDS = {
  plannedOutput: 'period.plannedOutput',
  demandIntegrated: 'period.demandIntegrated',
  remainingStock: 'period.remainingStock',
  forecastQty: 'period.forecastQty',
  ordersUnshipped: 'period.ordersUnshipped',
  ordersTotal: 'period.ordersTotal',
  remainingNoPlan: 'period.remainingNoPlan',
} as const;

export const FG_TRAD_PERIOD_COLUMNS: MrpColumnDef[] = [
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.plannedOutput, header: '[生產計畫] 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.demandIntegrated, header: '[需求整合] 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.remainingStock, header: '剩餘庫存 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.forecastQty, header: '[預示量] 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.ordersUnshipped, header: '[訂單未結] 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.ordersTotal, header: '[訂單總量] 月份區塊' },
  { id: FG_TRAD_PERIOD_VISIBILITY_IDS.remainingNoPlan, header: '剩餘庫存（無計劃量）月份區塊' },
].map((column) => ({
  ...column,
  group: '月份區塊',
  sortable: false,
}));

// colVis / 篩選用的 MrpColumnDef[] —— 從上面單一來源衍生。
// 前期欄在表格中嵌入各自的動態期推移群組；這裡的 group 供欄位選擇器分類。
export const FG_MONTHLY_TRADITIONAL_ALL_COLUMNS: MrpColumnDef[] = [
  ...[
    ...FG_TRAD_FROZEN.map((c) => ({ c, group: '基本資料' })),
    ...FG_TRAD_STATUS.map((c) => ({ c, group: '狀態' })),
    ...FG_TRAD_STATIC.map((c) => ({ c, group: '庫存/用料' })),
    ...FG_TRAD_WAREHOUSE.map((c) => ({ c, group: '倉庫在庫' })),
    ...FG_TRAD_WO.map((c) => ({ c, group: '鍛造與生產進度' })),
    { c: FG_TRAD_PLAN_PRIOR, group: '生產計畫' },
    { c: FG_TRAD_ORDER_PRIOR, group: '訂單需求' },
  ].map(({ c, group }) => ({
    id: c.key,
    header: c.label,
    description: c.description,
    group,
    filterType: c.filterType,
    width: c.width,
    ...(c.align ? { align: c.align } : {}),
    ...(c.mono ? { mono: c.mono } : {}),
    ...(c.filterable === false ? { filterable: false } : {}),
    ...(c.sortable === false ? { sortable: false } : {}),
  })),
  ...FG_TRAD_PERIOD_COLUMNS,
];
