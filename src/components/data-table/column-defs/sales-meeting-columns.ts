import type { MrpColumnDef } from '../types';

export const DB_SOURCE_COLUMN: MrpColumnDef = {
  id: 'dbSource', header: '來源', filterType: 'text', width: 55, align: 'center', defaultVisible: false,
};

export const SALES_MEETING_PERIOD_VISIBILITY_IDS = {
  remainingStock: 'period.remainingStock',
  demand: 'period.demand',
  supply: 'period.supply',
} as const;

export const SALES_MEETING_PERIOD_COLUMNS: MrpColumnDef[] = [
  { id: SALES_MEETING_PERIOD_VISIBILITY_IDS.remainingStock, header: '剩餘庫存' },
  { id: SALES_MEETING_PERIOD_VISIBILITY_IDS.demand, header: '訂單需求' },
  { id: SALES_MEETING_PERIOD_VISIBILITY_IDS.supply, header: '生產計畫' },
].map(column => ({ ...column, group: '大列', filterable: false, sortable: false, freezeable: false, headerMenu: false }));

export const SALES_MEETING_COLUMNS: MrpColumnDef[] = [
  { id: 'customerCode', header: '客戶代碼', filterType: 'enum', enumValues: [], width: 90, align: 'center' },
  { id: 'customerPartNo', header: '客戶料號', filterType: 'text', mono: true, width: 200 },
  {
    id: 'partVersion',
    header: '客戶料號版本（追溯）',
    filterType: 'text',
    mono: true,
    width: 200,
    defaultVisible: false,
  },
  { id: 'erpPartNo', header: 'ERP料號', description: 'Ragic A01：此客戶料號對應的成品 ERP 料號。', filterType: 'text', mono: true, width: 200 },
  { id: 'unit', header: '單位', filterType: 'text', width: 50, align: 'center' },
  { id: 'goodStockPc', header: '良品庫存pc', description: 'Ragic A03：此 Run 保存的可用良品庫存。同 ERP 共享庫存不可跨列重複加總。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'goodStockKg', header: '良品庫存kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'wfgStockPc', header: '廠內HD庫存pc', filterType: 'numeric', align: 'right', mono: true },
  { id: 'ye1StockPc', header: 'YE1在庫pc', filterType: 'numeric', align: 'right', mono: true },
  {
    id: 'inventoryAnomalyCount',
    header: '庫存檢核',
    description: '檢查 Run 庫存彙總與批號資料是否一致；待確認時可開啟異常來源。',
    filterType: 'numeric',
    width: 74,
    align: 'center',
    sortable: false,
  },
  { id: 'badStockPc', header: '不良品庫存pc', description: 'Ragic A05：不良品庫存，不納入可用良品供給。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockKg', header: '不良品kg', filterType: 'numeric', align: 'right', mono: true },
  { id: 'avgDemandPerWeek', header: '平均訂單需求/週', description: 'Ragic A10：未出貨訂單總量（含前期與遠期）除以13；不是過去13週的實際耗用量。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'stockWeeks', header: '庫存可支應週數', description: 'Ragic A08：可用庫存除以平均訂單需求；共享 ERP 使用共享池需求。這是估計週數，不是承諾交期。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'purchaseLeadWeeks', header: '採購前置期(週)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'shortageStartWeek', header: '預計缺貨週', description: 'Ragic A11：納入生產計畫後首次出現庫存缺口的週次；— 表示此 Run 未推算出缺貨週。', filterType: 'numeric', align: 'center' },
  { id: 'outstanding04', header: '近期訂單量', description: 'Ragic A14：前期＋前4週的未出貨訂單量；點數字查看訂單明細。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'fgDiff04', header: '近期成品餘缺', description: 'Ragic A15：前期＋前4週訂單扣用後的庫存餘缺，不含生產計畫；負數為缺口。共享 ERP 依共同庫存分配，點數字查看計算依據。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'fgStatus04', header: '近期供需狀態', description: 'Ragic A16：依近期成品餘缺判斷無訂單、足夠或不足，不含生產計畫。', filterType: 'text', align: 'center' },
  { id: 'totalOrderDemand', header: '未出貨訂單總量', description: 'Ragic U99：此 Run 已納入的全部未出貨訂單，包含前期與12週以外的遠期訂單；點數字查看全部訂單。', filterType: 'numeric', align: 'right', mono: true },
  { id: 'totalFgDiff', header: '總訂單成品餘缺', description: 'Ragic A17：全部訂單扣用後的庫存餘缺，包含遠期，不含生產計畫；負數為缺口。共享 ERP 不可只用本列庫存減本列需求，點數字查看計算依據。', filterType: 'numeric', align: 'right', mono: true },
];
