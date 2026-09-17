/**
 * Ragic Field EID → Postgres Column Mappings
 * ALL field maps verified from live Ragic API response 2026-02-18
 * using GET ?api&v=3&naming=EID&limit=1
 */

// Ragic API config
export const RAGIC_STAGING_PATHS = {
  part_versions:   '/default/d4/23',
  inventory:       '/default/d4/24',
  orders:          '/default/d4/25',
  forecasts:       '/default/d4/26',
  work_orders:     '/default/d4/27',
  work_order_bom:  '/default/d4/28',
  production_plans:'/default/d4/29',
  purchase_orders: '/default/d4/30',
} as const;

// Direct ERP source paths (future: bypass Ragic staging)
export const RAGIC_ERP_PATHS = {
  part_versions:   '/default/e6mrp/1',
  inventory:       '/default/g6mrp/1',
  inventory_lots:  '/default/forms4/16',
  orders:          '/default/e6mrp/2',
  forecasts:       '/default/e6mrp/3',
  work_orders:     '/default/d11mrp/3',
  work_order_bom:  '/default/d11mrp/4',
  production_plans:'/default/d11mrp/1',
  purchase_orders: '/default/p6mrp/1',
} as const;

export const RAGIC_WORK_ORDER_MOVEMENT_PATH = '/default/forms4/20';

export const RAGIC_SYNC_PAGE_SIZE = 2000;

// ============================================================
// Form [23] → staging.part_versions
// Sample: 1035932:"SY", 1035933:"SY-11206-RB1-0000", 1035935:"11206-RB1-0000-V01-05PA"
// ============================================================
export const FIELD_MAP_PART_VERSIONS: Record<string, string> = {
  '1035932': 'customer_code',        // "SY"
  '1035933': 'part_version',         // "SY-11206-RB1-0000"
  '1035934': 'customer_part_no',     // "11206-RB1-0000"
  '1035935': 'erp_part_no',          // "11206-RB1-0000-V01-05PA"
  '1035936': 'target_stock_periods', // "8"
  '1035937': 'product_status',       // "使用中"
  '1035938': 'forging_parent',       // "11206-RB1-0000"
  '1035939': 'first_process',        // "HF"
  '1035940': 'forging_machine',      // "H1"
  '1035941': 'process_bom_version',  // "[V01-01HF][V01-02LM]..."
  '1035942': 'surface_treatment',    // "11206-RB1-0000; #04製程：EP表面處理..."
  '1035943': 'version_status',       // "使用中"
  '1036114': 'sort_group',           // "1"
  '1036133': 'unit_weight_g',        // "47"
  '1036139': 'main_material_kg',     // "0.057"
  '1038549': 'skip_fg_inventory',    // ""
};

// ============================================================
// Form [24] → staging.inventory
// Sample: 1035944:"04223032-V01-08EP", 1035945:"5597", 1035963:"PROD-WIP"
// ============================================================
export const FIELD_MAP_INVENTORY: Record<string, string> = {
  '1035944': 'erp_part_no',         // "04223032-V01-08EP"
  '1035945': 'good_stock_pc',       // "5597"
  '1035946': 'good_stock_kg',       // "48.91778"
  '1037108': 'bad_stock_pc',        // "0"
  '1037109': 'bad_stock_kg',        // "0"
  '1035963': 'subtype_code',        // "PROD-WIP" (大類別+子類型代碼)
  '1037339': 'purchase_lead_weeks', // "15" (MRP[採購]前置期週數)
};

// ============================================================
// Form [25] → staging.orders
// Sample: 1035970:"", 1035972:"1", 1035973:"2025/08/04", 1035981:"0"
// ============================================================
export const FIELD_MAP_ORDERS: Record<string, string> = {
  '1035970': 'part_version',        // customer part version link (may be empty)
  '1035972': 'order_qty',           // "1"
  // 1035973 = 營業指定出貨日（NOT 客戶訂單需求日）。注意 SOURCE_FIELD_MAP_ORDERS
  // 的 delivery_date 是另一個欄位（1006628 需求日）— 兩者語意不同，勿混用。
  '1035973': 'designated_ship_date', // "2025/08/04"
  '1035978': 'shipment_status',     // "自動結案"
  '1035979': 'sales_status',        // "未結案"
  '1035981': 'unshipped_qty',       // "0"
};

// ============================================================
// Form [26] → staging.forecasts
// Sample: 1035993:"VS-1A021303", 1035996:"0", 1035987:"2026/02/01"
// ============================================================
export const FIELD_MAP_FORECASTS: Record<string, string> = {
  '1035993': 'part_version',        // "VS-1A021303" (客戶料號版本)
  '1035996': 'forecast_qty',        // "0" (需求數量)
  '1035987': 'forecast_start',      // "2026/02/01" (需求月起始日期)
};

// ============================================================
// Form [27] → staging.work_orders
// Sample: 1035999:"WO-24110010", 1036006:"6502-OT008-00-V01-03EP", 1036008:"260000"
// ============================================================
export const FIELD_MAP_WORK_ORDERS: Record<string, string> = {
  '1036017': 'part_version',        // "[目標]客戶料號版本" — joins to Form[23] part_version
  '1036006': 'erp_part_no',         // "6502-OT008-00-V01-03EP" (完工ERP料號)
  // Match Ragic d4/21 workflow: filter by 子製程類別代碼 == "HF01" and split by 工作排序碼.
  '1036002': 'sub_process_code',    // "HF01"/"EP20" (子製程類別代碼)
  '1036019': 'job_order_code',      // "99" (工作排序碼)
  '1036008': 'wo_qty',              // "260000" (預定生產數量pc)
  '1036010': 'start_date',          // "2024/12/02" (指定開始日期)
  '1036011': 'end_date',            // "2024/12/02" (指定結束日期)
  '1036014': 'status',              // "未結案" (工令狀態)
};

// ============================================================
// Form [28] → staging.work_order_bom
// Sample: 1036031:"6502-OT008-00-V01-02HT", 1036034:"260000", 1036035:"pc"
// Field ids match Ragic d4_21 FIELD_ID_BOM (lines 913-923 of the workflow):
//   SOURCE_TYPE = 1036032 ([領用]預設來源類型). An earlier mapping read 1036030
//   (a different field) into source_type, which silently emptied the column for
//   nearly every BOM row and caused the B/D component-weekly engines to drop
//   ~98% of their input. ALREADY_PICKED uses 1037337 in Ragic, not 1036033.
// ============================================================
export const FIELD_MAP_WORK_ORDER_BOM: Record<string, string> = {
  '1036031': 'component_no',        // [領用]組件料號
  '1036032': 'source_type',         // [領用]預設來源類型 — "採購"/"外購"/"內製"/"委外"
  '1036028': 'process_code',        // 製程簡稱 — "組合"/"表面處理"/"加工"
  '1036035': 'unit',                // 計數單位 — "pc"/"kg"
  '1036034': 'min_usage',           // 預估最少用量
  '1037337': 'already_picked',      // [工令單]領過料? — "Yes"/"No"
  '1036045': 'start_date',          // 指定開始日期
};

// ============================================================
// Form [29] → staging.production_plans
// Sample: 1036054:"PP202411-0223", 1036056:"VN-93903-34120-XLN-V01-03PA", 1036057:"500000"
// ============================================================
export const FIELD_MAP_PRODUCTION_PLANS: Record<string, string> = {
  '1036054': 'plan_no',             // 生產計畫編號
  '1036055': 'part_version',        // "目標客戶料號版本" — joins to Form[23] part_version
  '1036056': 'erp_part_no',         // "VN-93903-34120-XLN-V01-03PA" (目標ERP成品料號)
  '1036057': 'plan_qty',            // "500000" ([最新]預計完工數量)
  '1036058': 'completion_date',     // "2024/11/30" ([最新]目標完成日期)
  '1036111': 'closed_qty',          // "0" (鍛造工令單結案入庫量pc)
  '1036112': 'reported_qty',        // "0" (鍛造工令單報工量pc)
};

// ============================================================
// Form [30] → staging.purchase_orders
// Sample: 1037022:"TESTPART-D123-X03-01BU", 1037025:"25", 1037027:"2024/10/30"
// ============================================================
export const FIELD_MAP_PURCHASE_ORDERS: Record<string, string> = {
  '1037022': 'product_no',          // "TESTPART-D123-X03-01BU" (商品編號/ERP料號)
  '1037027': 'delivery_date',       // "2024/10/30" (預定交貨日)
  '1037024': 'unreceived_qty',      // "[採購]尚未進貨數量" (來源:1005804)
  '1037033': 'category',            // "PROD" (料品大類別)
  '1037031': 'status',              // "未結案" (採購單結案狀態)
};

// ============================================================
// Form [22] plan fields (for transfer to Form [10])
// ============================================================
export const PLAN_FIELDS = {
  1: {
    startPeriod:  '1037122',
    fulfillPeriod:'1036126',
    quantity:     '1036118',
    completionDate:'1036119',
    materialKg:   '1036140',
    bufferPct:    '1036131',
    isTransferred:'1036124',
    isEntered:    '1036122',
    useManualQty: '1038342',
  },
  2: {
    startPeriod:  '1037123',
    fulfillPeriod:'1036127',
    quantity:     '1036120',
    completionDate:'1036121',
    materialKg:   '1036141',
    bufferPct:    '1036132',
    isTransferred:'1036125',
    isEntered:    '1036123',
    useManualQty: '1038343',
  },
  3: {
    startPeriod:  '1037126',
    fulfillPeriod:'1037127',
    quantity:     '1037128',
    completionDate:'1037129',
    materialKg:   '1037133',
    bufferPct:    '1037132',
    isTransferred:'1037131',
    isEntered:    '1037130',
    useManualQty: '1038344',
  },
} as const;

// ============================================================
// EID lists per sync step — used for Ragic `select` parameter
// Only fetches the fields we actually need → smaller payloads
// ============================================================
export const FIELD_EIDS: Record<string, string[]> = {
  part_versions:    Object.keys(FIELD_MAP_PART_VERSIONS),
  inventory:        Object.keys(FIELD_MAP_INVENTORY),
  orders:           Object.keys(FIELD_MAP_ORDERS),
  forecasts:        Object.keys(FIELD_MAP_FORECASTS),
  work_orders:      Object.keys(FIELD_MAP_WORK_ORDERS),
  work_order_bom:   Object.keys(FIELD_MAP_WORK_ORDER_BOM),
  production_plans: Object.keys(FIELD_MAP_PRODUCTION_PLANS),
  purchase_orders:  Object.keys(FIELD_MAP_PURCHASE_ORDERS),
};

// ============================================================
// SOURCE (ERP) field maps — read directly from ERP forms
// These map source ERP form EIDs → our Postgres column names
// Derived from the Ragic JS staging→source positional mapping
// ============================================================

/** [23] /e6mrp/1 → staging.part_versions */
export const SOURCE_FIELD_MAP_PART_VERSIONS: Record<string, string> = {
  '1005357': 'customer_code',
  '1005216': 'part_version',
  '1005213': 'customer_part_no',
  '1005211': 'erp_part_no',
  '1012103': 'target_stock_periods',
  '1012104': 'product_status',
  '1012112': 'forging_parent',
  '1032914': 'first_process',
  '1032909': 'forging_machine',
  '1035011': 'process_bom_version',
  '1035013': 'surface_treatment',
  '1006554': 'version_status',
  '1034894': 'sort_group',
  '1007106': 'unit_weight_g',
  '1036138': 'main_material_kg',
  '1038548': 'skip_fg_inventory',
};

export const INVENTORY_SOURCE_FIELD_IDS = {
  erpPartNo: '1005345',
  purchaseLeadWeeks: '1037338',
} as const;

/** [24] /g6mrp/1 → staging.inventory */
export const SOURCE_FIELD_MAP_INVENTORY: Record<string, string> = {
  [INVENTORY_SOURCE_FIELD_IDS.erpPartNo]: 'erp_part_no',
  '1028374': 'good_stock_pc',
  '1026877': 'bad_stock_pc',
  '1026878': 'bad_stock_kg',
  '1028375': 'good_stock_kg',
  '1005645': 'subtype_code',
  [INVENTORY_SOURCE_FIELD_IDS.purchaseLeadWeeks]: 'purchase_lead_weeks',
  // Extra fields not in our DB but needed for querying:
  '1006404': '_source_type',       // 來源方式 (for filter: "採購")
  '1019191': 'item_status',        // 使用狀態；保留供 W 線材辨識作廢但仍被工令引用的料號
  '1037523': '_is_component',      // 內製組件 (for filter: "Yes")
};

/** /forms4/16 → staging.inventory_lots */
export const INVENTORY_LOT_FIELD_IDS = {
  lotNo: '1005414',
  erpPartNo: '1005417',
  warehouseCode: '1005479',
  qualityStatus: '1005482',
  stockStatus: '1005500',
  stockPc: '1005510',
  stockKg: '1005511',
  unitWeightG: '1005465',
  sourceWorkOrderNo: '1006064',
  sourceWorkOrderType: '1006466',
} as const;

export const SOURCE_FIELD_MAP_INVENTORY_LOTS: Record<string, string> = {
  [INVENTORY_LOT_FIELD_IDS.lotNo]: 'lot_no',
  [INVENTORY_LOT_FIELD_IDS.erpPartNo]: 'erp_part_no',
  [INVENTORY_LOT_FIELD_IDS.warehouseCode]: 'warehouse_code',
  [INVENTORY_LOT_FIELD_IDS.qualityStatus]: 'quality_status',
  [INVENTORY_LOT_FIELD_IDS.stockStatus]: 'stock_status',
  [INVENTORY_LOT_FIELD_IDS.stockPc]: 'stock_pc',
  [INVENTORY_LOT_FIELD_IDS.stockKg]: 'stock_kg',
  [INVENTORY_LOT_FIELD_IDS.unitWeightG]: 'unit_weight_g',
  [INVENTORY_LOT_FIELD_IDS.sourceWorkOrderNo]: 'source_work_order_no',
  [INVENTORY_LOT_FIELD_IDS.sourceWorkOrderType]: 'source_work_order_type',
};

/** [25] /e6mrp/2 → staging.orders */
export const SOURCE_FIELD_MAP_ORDERS: Record<string, string> = {
  '1006630': 'part_version',
  '1006635': 'order_qty',
  '1006752': 'prepared_qty',       // 已備貨數量pc（直接實績）
  '1006628': 'delivery_date',      // 客戶訂單需求日 — used for date filter only
  // 營業指定出貨日 — Ragic d4/21 buckets 訂單總量 by THIS date, not delivery_date.
  // The two can fall in different months (e.g. 需求日 7/01 vs 出貨日 6/29).
  '1007116': 'designated_ship_date',
  '1006750': 'shipment_status',
  '1006636': 'shipped_qty',        // 已出庫數量pc（直接實績）
  '1006784': 'sales_status',       // 訂單明細項次銷貨狀態
  '1006751': 'unshipped_qty',
  // 訂單明細項次備貨狀態 — 值「人工結案」= 營業手動結案（取消）。
  // 歷史 v1 整筆排除；v2 改由 direct shipped_qty 認列實際履行量。
  '1006753': 'prep_status',
  '1006782': 'sold_qty',           // 已銷貨數量pc（直接實績）
  '1031827': 'order_type',         // A銷貨/B補貨/C退貨/D樣品/E試作/F開發/G模具
  // 訂單識別與原始剩餘量供來源追溯；MRP 核心認列以 direct 實績欄位為準。
  '1006620': 'order_no',           // 訂單編號 e.g. PO-20260206-006
  '1006641': 'customer_part_no',   // 客戶料號（如 212035，不含 customer prefix）
  '1006755': 'unprep_qty',         // 未備貨數量pc
  '1006783': 'unsold_qty',         // 未銷貨數量pc
};

/** [26] /e6mrp/3 → staging.forecasts */
export const SOURCE_FIELD_MAP_FORECASTS: Record<string, string> = {
  '1006973': 'part_version',
  '1006970': 'forecast_qty',
  '1006969': 'forecast_start',     // 需求月起始日期 — field 1006983 exists but is NOT returned in listing=true mode; 1006969 has the same value and IS returned
};

/** [27] /d11mrp/3 → staging.work_orders
 * Field IDs verified against actual /d4/27 API response.
 * Ragic d4/21 workflow uses sub_process_code === "HF01" + job_order_code === "99"/""
 * for the WO scheduled/unscheduled split, so we must map to the matching fields:
 *   1005990 = 子製程類別代碼 (e.g. "HF01", "EP20")
 *   1012079 = 工作排序碼 (e.g. "99" for unscheduled)
 */
export const SOURCE_FIELD_MAP_WORK_ORDERS: Record<string, string> = {
  '1005984': 'wo_number',         // 工令單號 — joined from BOM.wo_number
  '1010306': 'part_version',
  '1005988': 'erp_part_no',
  '1005990': 'sub_process_code',
  '1012079': 'job_order_code',
  '1005991': 'wo_qty',
  '1006860': 'start_date',
  '1007354': 'end_date',
  '1006393': 'status',
  '1034110': 'already_picked',    // [工令單]領過料? — drives the BOM filter via join
};

/** [28] /d11mrp/4 → staging.work_order_bom
 *
 * Field IDs verified against Ragic d4_21 line 3155 (the internal workflow
 * call that mirrors /d11mrp/4 → /d4/28) AND against the live /d11mrp/4
 * listing API response.
 *
 *   1031625 = SOURCE_TYPE ([領用]預設來源類型) — confirmed by API ("內製"/"委外"/"採購")
 *   1005987 = WO_NUMBER  (工令單單號) — used to join to /d11mrp/3 for already_picked
 *
 * Field 1037336 is only a parent-level summary and can disagree with executed
 * rows in `_subtable_1006278`. Every open BOM therefore uses the full response;
 * remaining-use calculation treats each child row's 1006339 as authoritative.
 * Do not project this request with fetchDomainIds: Ragic then omits the native
 * subtable. The generated Form 75 also retains historical issue rows that are
 * no longer present in the current open Form 28 parent snapshot.
 */
export const SOURCE_FIELD_MAP_WORK_ORDER_BOM: Record<string, string> = {
  '1006000': 'component_no',
  '1005987': 'wo_number',
  '1031625': 'source_type',
  '1006853': 'process_code',
  '1006002': 'unit',
  '1006019': 'min_usage',
  '1018404': 'start_date',
  '1031626': '_wo_status',         // 工令狀態 (for filter: "未結案")
  '1037336': 'already_picked',     // [工令單]領過料? — diagnostic parent summary only
};

export const WORK_ORDER_MOVEMENT_FIELD_IDS = {
  inventoryLotNo: '1005418',
  componentNo: '1005557',
  movementDate: '1005561',
  basisType: '1005562',
  inputUnit: '1005563',
  inputQtyPc: '1005566',
  inputQtyKg: '1005567',
  movementQtyPc: '1005568',
  movementQtyKg: '1005569',
  movementType: '1005579',
  workOrderNo: '1006329',
  bomItemKey: '1006330',
} as const;

export const SOURCE_FIELD_MAP_WORK_ORDER_MOVEMENTS: Record<string, string> = {
  [WORK_ORDER_MOVEMENT_FIELD_IDS.inventoryLotNo]: 'inventory_lot_no',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.componentNo]: 'component_no',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.movementDate]: 'movement_date',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.basisType]: 'basis_type',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.inputUnit]: 'input_unit',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.inputQtyPc]: 'input_qty_pc',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.inputQtyKg]: 'input_qty_kg',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.movementQtyPc]: 'movement_qty_pc',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.movementQtyKg]: 'movement_qty_kg',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.movementType]: 'movement_type',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.workOrderNo]: 'work_order_no',
  [WORK_ORDER_MOVEMENT_FIELD_IDS.bomItemKey]: 'bom_item_key',
};

/** [29] /d11mrp/1 → staging.production_plans */
export const SOURCE_FIELD_MAP_PRODUCTION_PLANS: Record<string, string> = {
  '1006542': 'plan_no',            // 生產計畫編號
  '1006549': 'part_version',
  '1006546': 'erp_part_no',
  '1027890': 'plan_qty',
  '1006564': 'completion_date',
  '1032910': 'closed_qty',
  '1034067': 'reported_qty',
  '1015482': '_plan_status',       // 生產計畫狀態 (for filter: "未結案")
};

/** [30] /p6mrp/1 → staging.purchase_orders */
export const SOURCE_FIELD_MAP_PURCHASE_ORDERS: Record<string, string> = {
  '1005722': 'product_no',
  '1005769': 'delivery_date',
  '1005804': 'unreceived_qty',
  '3004236': 'category',
  '1005865': 'status',
};

export const RAGIC_SYNC_PROJECTED_FIELDS: Partial<Record<keyof typeof RAGIC_ERP_PATHS, readonly string[]>> = {
  part_versions: Object.keys(SOURCE_FIELD_MAP_PART_VERSIONS),
  inventory: Object.keys(SOURCE_FIELD_MAP_INVENTORY).filter(
    (fieldId) => !SOURCE_FIELD_MAP_INVENTORY[fieldId].startsWith('_'),
  ),
  inventory_lots: Object.keys(SOURCE_FIELD_MAP_INVENTORY_LOTS),
  orders: Object.keys(SOURCE_FIELD_MAP_ORDERS),
  forecasts: Object.keys(SOURCE_FIELD_MAP_FORECASTS),
  work_orders: Object.keys(SOURCE_FIELD_MAP_WORK_ORDERS),
  work_order_bom: Object.keys(SOURCE_FIELD_MAP_WORK_ORDER_BOM),
  production_plans: Object.keys(SOURCE_FIELD_MAP_PRODUCTION_PLANS),
  purchase_orders: Object.keys(SOURCE_FIELD_MAP_PURCHASE_ORDERS),
};

export function getSyncProjectedFields(
  step: keyof typeof RAGIC_ERP_PATHS,
  useListing: boolean,
): readonly string[] | undefined {
  if (!useListing && step !== 'part_versions' && step !== 'inventory') {
    return undefined;
  }
  return RAGIC_SYNC_PROJECTED_FIELDS[step];
}

// ============================================================
// WHERE filter configs per sync step
// Matches the original Ragic JS: globalLoadAndFillTargetTableWithOperandFilter
// Each step has one or more "filter sets". Multiple sets = multiple API calls, combined.
// Within a set: same-field clauses are OR'd, different-field clauses are AND'd (Ragic behavior)
// ============================================================
export interface WhereClause {
  fieldId: string;
  operator: 'eq' | 'gte' | 'lt' | 'like' | 'regex';
  value: string;
}

export interface FilterSet {
  where: WhereClause[];
  /** Override Ragic listing mode for this filter set. */
  listing?: boolean;
}

export const OPEN_PRODUCTION_PLAN_WHERE: WhereClause[] = [
  { fieldId: '1015482', operator: 'eq', value: '未結案' },
];

/**
 * Get WHERE filters for each sync step.
 * @param monthStart - First day of the MRP run month (YYYY/MM/DD format for Ragic)
 */
export function getSyncFilters(monthStart: string): Record<string, FilterSet[]> {
  return {
    // [23] Part Versions: version_status = "使用中"
    part_versions: [
      { where: [{ fieldId: '1006554', operator: 'eq', value: '使用中' }] },
    ],

    // [24] Inventory: 4 separate calls combined
    // Call 1: PROD-FG AND 使用中
    // Call 2: PROD-WIP AND 採購 AND 使用中
    // Call 3: 內製組件=Yes AND 使用中
    // Call 4: all MTRL-WR / MTRL-WD statuses, including active rows. Engine only
    //         keeps inactive rows when the current Run BOM still references them.
    inventory: [
      {
        where: [
          { fieldId: '1005645', operator: 'eq', value: 'PROD-FG' },
          { fieldId: '1019191', operator: 'eq', value: '使用中' },
        ],
      },
      {
        where: [
          { fieldId: '1005645', operator: 'eq', value: 'PROD-WIP' },
          { fieldId: '1006404', operator: 'eq', value: '採購' },
          { fieldId: '1019191', operator: 'eq', value: '使用中' },
        ],
      },
      {
        where: [
          { fieldId: '1037523', operator: 'eq', value: 'Yes' },
          { fieldId: '1019191', operator: 'eq', value: '使用中' },
        ],
      },
      {
        where: [
          { fieldId: '1005645', operator: 'eq', value: 'MTRL-WR' },
          { fieldId: '1005645', operator: 'eq', value: 'MTRL-WD' },
        ],
      },
    ],

    inventory_lots: [{
      where: [
        { fieldId: '1005500', operator: 'eq' as const, value: '在庫' },
      ],
      listing: true,
    }],

    // [25] Orders: 2 calls。用「營業指定出貨日」(1007116) 篩 —— 與引擎分月/分週
    // 的分桶日一致（見 fg-monthly-engine）。不可用客戶訂單需求日(1006628)，
    // 否則需求日與出貨日跨月的訂單會被漏撈。
    // Call 1: designated_ship_date >= month start
    // Call 2: designated_ship_date < month start AND sales_status = 未結案
    orders: [
      {
        where: [{ fieldId: '1007116', operator: 'gte', value: monthStart }],
      },
      {
        where: [
          { fieldId: '1007116', operator: 'lt', value: monthStart },
          { fieldId: '1006784', operator: 'eq', value: '未結案' },
        ],
      },
    ],

    // [26] Forecasts: forecast_start >= month start
    forecasts: [
      {
        where: [{ fieldId: '1006983', operator: 'gte', value: monthStart }],
      },
    ],

    // [27] Work Orders: status = 未結案
    work_orders: [
      {
        where: [{ fieldId: '1006393', operator: 'eq', value: '未結案' }],
      },
    ],

    // [28] Work Order BOM: all open rows with native issue-detail subtables.
    // The parent 1037336 flag is not authoritative and cannot safely decide
    // which rows may use lightweight listing mode.
    work_order_bom: [
      {
        where: [{ fieldId: '1031626', operator: 'eq', value: '未結案' }],
        listing: false,
      },
    ],

    // [29] Production Plans: plan_status = 未結案
    production_plans: [
      {
        where: [...OPEN_PRODUCTION_PLAN_WHERE],
      },
    ],

    // [30] Purchase Orders: status = 未結案 AND (category = PROD OR MTRL)
    purchase_orders: [
      {
        where: [
          { fieldId: '1005865', operator: 'eq', value: '未結案' },
          { fieldId: '3004236', operator: 'eq', value: 'PROD' },
          { fieldId: '3004236', operator: 'eq', value: 'MTRL' },
        ],
      },
    ],
  };
}

// Form [10] fields (production plan — transfer destination)
export const FORM10_FIELDS = {
  planNo:              '1006542',
  createdAt:           '1006544',
  customerCode:        '1006548',
  partVersion:         '1006549',
  targetQty:           '1014062',
  targetDate:          '1013376',
  mrpSourceCode:       '1036128',
  autoCreateWorkOrder: '1039437',
  hasWorkOrderNo:      '1031639',
  processSubtable:     '1005987',
  workOrderNo:         '1005984',
} as const;
