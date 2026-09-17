import type { MrpColumnDef } from '../types';

export const SOURCE_PART_VERSIONS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'customerPartNo', header: '客戶料號', filterType: 'text' },
  { id: 'customerCode', header: '客戶', filterType: 'enum', enumValues: [] },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'forgingMachine', header: '機台', filterType: 'text' },
  { id: 'firstProcess', header: '製程1', filterType: 'text' },
  { id: 'forgingParent', header: '鍛造母件', filterType: 'text' },
  { id: 'sortGroup', header: '排序群組', filterType: 'numeric', align: 'center' },
  { id: 'targetStockPeriods', header: '備庫期數', filterType: 'numeric', align: 'right' },
  { id: 'unitWeightG', header: '單重(g)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'mainMaterialKg', header: '主材料(kg)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'versionStatus', header: '版本狀態', filterType: 'text' },
  { id: 'skipFgInventory', header: '略過成品', filterType: 'boolean', align: 'center' },
];

export const SOURCE_INVENTORY_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'subtypeCode', header: '子類型', filterType: 'text' },
  { id: 'goodStockPc', header: '良品(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'goodStockKg', header: '良品(kg)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockPc', header: '不良品(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'badStockKg', header: '不良品(kg)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'purchaseLeadWeeks', header: '採購前置週', filterType: 'numeric', align: 'right', mono: true },
];

export const SOURCE_ORDERS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'orderNo', header: '訂單編號', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'customerPartNo', header: '客戶料號', filterType: 'text', mono: true },
  { id: 'orderType', header: '訂單類型', filterType: 'text' },
  { id: 'orderQty', header: '原始訂單(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'preparedQty', header: '實際已備貨(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'unprepQty', header: '原始未備貨(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'shippedQty', header: '實際已出庫(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'unshippedQty', header: '原始未出庫(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'soldQty', header: '實際已銷貨(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'unsoldQty', header: '原始未銷貨(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'deliveryDate', header: '客戶訂單需求日', filterType: 'date' },
  { id: 'designatedShipDate', header: '營業指定出貨日', filterType: 'date' },
  { id: 'prepStatus', header: '備貨狀態', filterType: 'text' },
  { id: 'shipmentStatus', header: '出貨狀態', filterType: 'text' },
  { id: 'salesStatus', header: '銷貨狀態', filterType: 'text' },
];

export const SOURCE_FORECASTS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'forecastQty', header: '預示量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'forecastStart', header: '需求月起始', filterType: 'date' },
];

export const SOURCE_WORK_ORDERS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'jobOrderCode', header: '工令單號', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'subProcessCode', header: '子製程', filterType: 'text' },
  { id: 'woQty', header: '數量(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'startDate', header: '開始日', filterType: 'date' },
  { id: 'endDate', header: '結束日', filterType: 'date' },
  { id: 'status', header: '狀態', filterType: 'text' },
];

export const SOURCE_WORK_ORDER_BOM_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'woNumber', header: '工令單號', filterType: 'text', mono: true },
  { id: 'componentNo', header: '組件料號', filterType: 'text', mono: true },
  { id: 'sourceType', header: '來源方式', filterType: 'text' },
  { id: 'processCode', header: '製程', filterType: 'text' },
  { id: 'unit', header: '單位', filterType: 'text' },
  { id: 'minUsage', header: '標準用量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'alreadyPicked', header: '已領料', filterType: 'text' },
  { id: 'grossIssuedQty', header: 'MRP總領用', filterType: 'numeric', align: 'right', mono: true },
  { id: 'consumedQty', header: 'MRP帳面出庫淨額', filterType: 'numeric', align: 'right', mono: true },
  { id: 'returnedQty', header: 'MRP正式退料', filterType: 'numeric', align: 'right', mono: true },
  { id: 'netIssuedQty', header: 'MRP淨領用', filterType: 'numeric', align: 'right', mono: true },
  { id: 'reservedQty', header: 'MRP工令保留', filterType: 'numeric', align: 'right', mono: true },
  { id: 'remainingUsage', header: 'MRP剩餘需求', filterType: 'numeric', align: 'right', mono: true },
  { id: 'overIssuedQty', header: 'MRP淨領用超過BOM', filterType: 'numeric', align: 'right', mono: true },
  { id: 'issuedQtyState', header: '領用狀態', filterType: 'text' },
  { id: 'issuedDetailCount', header: '領料明細數', filterType: 'numeric', align: 'right', mono: true },
  { id: 'issuedQtyError', header: '領用錯誤', filterType: 'text' },
  { id: 'movementState', header: '耗退狀態', filterType: 'text' },
  { id: 'movementDetailCount', header: '耗退明細數', filterType: 'numeric', align: 'right', mono: true },
  { id: 'movementError', header: '耗退錯誤', filterType: 'text' },
  { id: 'anomalyLevel', header: '異常等級', filterable: false, sortable: false },
  { id: 'anomalyReason', header: '異常原因', filterable: false, sortable: false },
  { id: 'startDate', header: '開始日', filterType: 'date' },
];

export const SOURCE_INVENTORY_LOTS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'lotNo', header: '庫存批號', filterType: 'text', mono: true },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'warehouseCode', header: '倉庫', filterType: 'text' },
  { id: 'stockStatus', header: '庫存狀態', filterType: 'text' },
  { id: 'qualityStatus', header: '品質狀態', filterType: 'text' },
  { id: 'stockPc', header: '在庫(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'stockKg', header: '在庫(kg)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'unitWeightG', header: '單重(g)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'expectedStockPc', header: '預期(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'stockPcDiff', header: '差異(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'stockPcDiffPct', header: '差異(%)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'quantityAnomaly', header: '數量異常', filterType: 'boolean', align: 'center' },
  { id: 'sourceWorkOrderNo', header: '來源工令', filterType: 'text', mono: true },
  { id: 'sourceWorkOrderType', header: '來源工令類型', filterType: 'text' },
];

export const SOURCE_WORK_ORDER_MATERIAL_MOVEMENTS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'workOrderNo', header: '工令單號', filterType: 'text', mono: true },
  { id: 'bomItemKey', header: 'BOM關聯鍵', filterType: 'text', mono: true },
  { id: 'inventoryLotNo', header: '庫存批號', filterType: 'text', mono: true },
  { id: 'componentNo', header: '組件料號', filterType: 'text', mono: true },
  { id: 'movementDate', header: '異動日', filterType: 'date' },
  { id: 'basisType', header: '基礎類型', filterType: 'text' },
  { id: 'movementType', header: '異動類型', filterType: 'text' },
  { id: 'inputUnit', header: '輸入單位', filterType: 'text' },
  { id: 'inputQtyPc', header: '輸入(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'inputQtyKg', header: '輸入(kg)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'movementQtyPc', header: '異動(pc)', filterType: 'numeric', align: 'right', mono: true },
  { id: 'movementQtyKg', header: '異動(kg)', filterType: 'numeric', align: 'right', mono: true },
];

export const SOURCE_PRODUCTION_PLANS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'partVersion', header: '客料版本', filterType: 'text', mono: true },
  { id: 'erpPartNo', header: 'ERP料號', filterType: 'text', mono: true },
  { id: 'planQty', header: '計畫量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'completionDate', header: '完成日', filterType: 'date' },
  { id: 'reportedQty', header: '報工量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'closedQty', header: '結案量', filterType: 'numeric', align: 'right', mono: true },
];

export const SOURCE_PURCHASE_ORDERS_COLUMNS: MrpColumnDef[] = [
  { id: 'ragicRecordId', header: 'Ragic ID', filterType: 'text', mono: true },
  { id: 'productNo', header: '商品編號', filterType: 'text', mono: true },
  { id: 'deliveryDate', header: '交貨日', filterType: 'date' },
  { id: 'unreceivedQty', header: '未進貨量', filterType: 'numeric', align: 'right', mono: true },
  { id: 'category', header: '大類別', filterType: 'text' },
  { id: 'status', header: '狀態', filterType: 'text' },
];

// Map of tab key -> column definitions and table ID
export const SOURCE_DATA_TABLE_CONFIG: Record<string, { columns: MrpColumnDef[]; tableId: string }> = {
  part_versions: { columns: SOURCE_PART_VERSIONS_COLUMNS, tableId: 'source_part_versions' },
  inventory: { columns: SOURCE_INVENTORY_COLUMNS, tableId: 'source_inventory' },
  orders: { columns: SOURCE_ORDERS_COLUMNS, tableId: 'source_orders' },
  forecasts: { columns: SOURCE_FORECASTS_COLUMNS, tableId: 'source_forecasts' },
  work_orders: { columns: SOURCE_WORK_ORDERS_COLUMNS, tableId: 'source_work_orders' },
  work_order_bom: { columns: SOURCE_WORK_ORDER_BOM_COLUMNS, tableId: 'source_work_order_bom' },
  inventory_lots: { columns: SOURCE_INVENTORY_LOTS_COLUMNS, tableId: 'source_inventory_lots' },
  work_order_material_movements: {
    columns: SOURCE_WORK_ORDER_MATERIAL_MOVEMENTS_COLUMNS,
    tableId: 'source_work_order_material_movements',
  },
  production_plans: { columns: SOURCE_PRODUCTION_PLANS_COLUMNS, tableId: 'source_production_plans' },
  purchase_orders: { columns: SOURCE_PURCHASE_ORDERS_COLUMNS, tableId: 'source_purchase_orders' },
};
