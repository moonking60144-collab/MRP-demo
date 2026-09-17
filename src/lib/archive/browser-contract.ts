export const ARCHIVE_VIEWS = {
  'fg-monthly': { label: '成品月推', table: 'demo.FgMonthly', search: ['part_version', 'customer_part_no', 'erp_part_no'], columns: 'part_version:客料版本,customer_code:客戶代碼,customer_part_no:客戶料號,erp_part_no:ERP料號,current_stock_pc:良品庫存pc,bad_stock_pc:不良品pc,main_stock_pc:廠內MAIN庫存,aux_stock_pc:AUX庫存pc,wo_total:工單總量,total_unshipped_qty:未出貨總量,total_plan_supply:計畫供給,shortage_start_period:開始缺料期,shortage_start_period_no_plan:無計畫缺料期,forging_machine:機台,first_process:首製程' },
  'fg-periods': { label: '成品月推・各月明細', table: 'demo.FgMonthlyPeriod', search: ['part_version'], columns: 'part_version:客料版本,period_label:月份,period_start:起日,period_end:迄日,remaining_stock:期末剩餘,remaining_no_plan:無計畫剩餘,demand_integrated:整合需求,orders_unshipped:未出貨訂單,orders_total:訂單總量,forecast_qty:預示量,planned_output:計畫產出' },
  'component-weekly': { label: '元件週推', table: 'demo.ComponentWeekly', search: ['material_part_no'], columns: 'material_part_no:料號,mrp_type:類型,unit:單位,good_stock_pc:良品pc,good_stock_kg:良品kg,bad_stock_pc:不良品pc,bad_stock_kg:不良品kg,avg_weekly_usage:平均週用量,stock_weeks:庫存週數,purchase_lead_weeks:採購前置週數,shortage_start_week:開始缺料週,weeks_until_order:距下單週數,shortage_qty:缺料量,shortage_start_date:開始缺料日期,order_by_date:最晚下單日,purchase_action:採購處置,overdue_purchase_qty:逾期採購量,future_purchase_qty:未來採購量' },
  'component-periods': { label: '元件週推・各週明細', table: 'demo.ComponentWeeklyPeriod', search: ['material_part_no'], columns: 'material_part_no:料號,mrp_type:類型,week_label:週別,week_start:週起日,remaining_stock:期末剩餘,usage:需求用量,receipts:預計入庫' },
  'sales-meeting': { label: '產銷會議', table: 'demo.SalesMeeting', search: ['part_version', 'erp_part_no'], columns: 'part_version:客料版本,erp_part_no:ERP料號,customer_code:客戶代碼,unit:單位,good_stock_pc:良品pc,good_stock_kg:良品kg,bad_stock_pc:不良品pc,main_stock_pc:廠內MAIN庫存,aux_stock_pc:AUX庫存pc,avg_demand_per_week:平均週需求,stock_weeks:庫存週數,shortage_start_week:開始缺料週,outstanding_0_4:前四週未交,fg_diff_0_4:前四週供需差,fg_status_0_4:前四週狀態,total_order_demand:總訂單需求,total_fg_diff:總供需差' },
  'sales-periods': { label: '產銷會議・各週明細', table: 'demo.SalesMeetingPeriod', search: ['part_version'], columns: 'part_version:客料版本,week_label:週別,week_start:週起日,remaining_stock:期末剩餘,demand:需求,supply:供給' },
  inventory: { label: '來源・庫存', table: 'demo.StagingInventory', search: ['erp_part_no'], columns: 'erp_part_no:ERP料號,subtype_code:分類,unit:單位,good_stock_pc:良品pc,good_stock_kg:良品kg,bad_stock_pc:不良品pc,bad_stock_kg:不良品kg,main_stock_pc:廠內MAIN庫存,aux_stock_pc:AUX庫存pc,in_stock_pc:在庫pc,purchase_lead_weeks:採購前置週數,item_status:料件狀態' },
  orders: { label: '來源・訂單', table: 'demo.StagingOrder', search: ['part_version', 'customer_part_no', 'order_no'], columns: 'part_version:客料版本,customer_part_no:客戶料號,order_no:訂單號,delivery_date:交期,order_qty:訂單量,unshipped_qty:未出貨量,unprep_qty:未備貨量,unsold_qty:未銷量,shipment_status:出貨狀態,sales_status:銷貨狀態,order_type:訂單類型,prepared_qty:已備量,shipped_qty:已出量,sold_qty:已銷量' },
  forecasts: { label: '來源・預示', table: 'demo.StagingForecast', search: ['part_version'], columns: 'part_version:客料版本,forecast_start:預示起日,forecast_qty:預示量' },
  'production-plans': { label: '來源・生產計畫', table: 'demo.StagingProductionPlan', search: ['part_version', 'erp_part_no', 'plan_no'], columns: 'part_version:客料版本,erp_part_no:ERP料號,plan_no:計畫單號,completion_date:預計完成日,plan_qty:計畫量,reported_qty:已報量,closed_qty:結案量,status:狀態' },
  'work-orders': { label: '來源・工單', table: 'demo.StagingWorkOrder', search: ['part_version', 'erp_part_no', 'wo_number'], columns: 'part_version:客料版本,erp_part_no:ERP料號,wo_number:工單號,sub_process_code:製程,job_order_code:工單類型,wo_qty:工單量,start_date:開始日,end_date:結束日,status:狀態,already_picked:已領料' },
  bom: { label: '來源・工單BOM', table: 'demo.StagingWorkOrderBom', search: ['component_no', 'wo_number'], columns: 'component_no:元件料號,wo_number:工單號,process_code:製程,unit:單位,min_usage:最小用量,issued_qty:已領量,remaining_usage:剩餘用量,issued_qty_state:領料狀態,movement_state:領退料狀態,net_issued_qty:淨領料量,consumed_qty:耗用量,reserved_qty:保留量' },
  purchases: { label: '來源・採購單', table: 'demo.StagingPurchaseOrder', search: ['product_no'], columns: 'product_no:料號,delivery_date:交期,unreceived_qty:未交量,category:分類,status:狀態' },
  movements: { label: '來源・領退料明細', table: 'demo.StagingWorkOrderMaterialMovement', search: ['component_no', 'work_order_no'], columns: 'component_no:元件料號,work_order_no:工單號,inventory_lot_no:庫存批號,movement_date:異動日,movement_type:異動類型,movement_qty_pc:異動量pc,movement_qty_kg:異動量kg' },
} as const;

export type ArchiveView = keyof typeof ARCHIVE_VIEWS;
export interface ArchiveRunItem {
  id: string;
  sourceRunId: number;
  versionCode: string;
  runDate: string;
  sourceStatus: string;
  verifiedAt: string;
  generation: string;
  seedFileName: string;
}
export interface ArchiveRunPage { runs: ArchiveRunItem[]; total: number; page: number; pageSize: number }
export interface ArchiveRowsPage {
  run: ArchiveRunItem;
  view: ArchiveView;
  columns: Array<{ key: string; label: string; missing: boolean; type: string }>;
  rows: Array<Record<string, string | null>>;
  sourcePresent: boolean;
  total: number;
  page: number;
  pageSize: number;
}

export function archiveColumns(view: ArchiveView) {
  const columns = ARCHIVE_VIEWS[view].columns.split(',').map(pair => {
    const [key, label] = pair.split(':');
    return { key, label };
  });
  if (view === 'fg-monthly' || view === 'fg-periods') columns.splice(1, 0, { key: 'is_aggregated', label: '檢視層級' });
  return columns;
}

export function archiveCell(value: string | null, type = 'text', key = '') {
  if (value === null) return '—';
  if (type === 'boolean') {
    if (key === 'is_aggregated') return value === 'true' ? '同 ERP 整合' : '按版本';
    if (value === 'true') return '是';
    if (value === 'false') return '否';
  }
  return type.startsWith('numeric') && /^-?\d+\.\d+$/.test(value) ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : value;
}
