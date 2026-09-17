export const EXPECTED_TABLES: Record<string, string[]> = {
  public: ['mrp_run', 'table_presets', 'app_settings', 'outsource_price_change_snapshot'],
  staging: [
    'part_versions',
    'inventory',
    'inventory_lots',
    'orders',
    'forecasts',
    'work_orders',
    'work_order_bom',
    'work_order_material_movements',
    'production_plans',
    'purchase_orders',
  ],
  mrp_out: [
    'fg_monthly',
    'fg_monthly_periods',
    'fg_plan_suggestions',
    'production_plan_transfers',
    'component_weekly',
    'component_weekly_periods',
    'sales_meeting',
    'sales_meeting_periods',
  ],
};

export const REQUIRED_COLUMNS: Record<string, string[]> = {
  'public.mrp_run': ['logs', 'order_demand_contract_version'],
  'staging.orders': [
    'order_no',
    'customer_part_no',
    'prepared_qty',
    'unprep_qty',
    'shipped_qty',
    'unsold_qty',
    'sold_qty',
    'order_type',
    'designated_ship_date',
    'prep_status',
  ],
  'staging.inventory': [
    'item_status',
    'in_stock_pc',
    'in_stock_kg',
    'wfg_stock_pc',
    'wfg_stock_kg',
    'ye1_stock_pc',
    'ye1_stock_kg',
    'purchase_lead_weeks_configured',
  ],
  'staging.inventory_lots': [
    'source_work_order_no',
    'source_work_order_type',
    'unit_weight_g',
    'expected_stock_pc',
    'stock_pc_diff',
    'stock_pc_diff_pct',
    'quantity_anomaly',
  ],
  'staging.work_orders': ['wo_number', 'already_picked'],
  'staging.work_order_bom': [
    'wo_number',
    'issued_qty',
    'gross_issued_qty',
    'consumed_qty',
    'returned_qty',
    'net_issued_qty',
    'reserved_qty',
    'remaining_usage',
    'over_issued_qty',
    'issued_qty_state',
    'issued_detail_count',
    'issued_qty_error',
    'movement_state',
    'movement_detail_count',
    'movement_error',
  ],
  'staging.work_order_material_movements': [
    'ragic_record_id',
    'work_order_no',
    'component_no',
    'basis_type',
    'movement_type',
    'movement_qty_pc',
    'movement_qty_kg',
  ],
  'staging.production_plans': ['plan_no'],
  'mrp_out.fg_monthly': [
    'process_bom_version',
    'is_aggregated',
    'aggregated_members',
    'shortage_start_period_no_plan',
    'wfg_stock_pc',
    'ye1_stock_pc',
  ],
  'mrp_out.fg_monthly_periods': ['is_aggregated'],
  'mrp_out.component_weekly': [
    'purchase_lead_weeks_configured',
    'shortage_start_date',
    'shortage_qty',
    'order_by_date',
    'purchase_action',
    'overdue_purchase_qty',
    'overdue_purchase_count',
    'future_purchase_qty',
    'future_purchase_count',
    'next_purchase_receipt_date',
  ],
  'mrp_out.sales_meeting': [
    'customer_code',
    'wfg_stock_pc',
    'ye1_stock_pc',
  ],
  'mrp_out.fg_plan_suggestions': [
    'transfer_status',
    'transfer_error',
    'transfer_started_at',
  ],
  'mrp_out.production_plan_transfers': [
    'mrp_run_id',
    'work_order_status',
    'work_order_error',
    'work_order_started_at',
    'work_order_completed_at',
    'work_order_response',
    'inventory_warning',
  ],
};

export const REQUIRED_INDEXES: Record<string, string[]> = {
  'staging.part_versions': ['idx_staging_parts'],
  'staging.inventory': ['idx_staging_inv'],
  'staging.orders': ['idx_staging_orders'],
  'staging.forecasts': ['idx_staging_forecasts'],
  'staging.work_order_material_movements': [
    'idx_staging_wo_movements_lookup',
    'idx_staging_wo_movements_lot',
  ],
  'staging.production_plans': ['idx_staging_plans'],
  'staging.purchase_orders': ['idx_staging_po'],
  'mrp_out.sales_meeting': ['idx_sales_meeting_run_customer'],
};

export interface DbForeignKeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
}

export const EXPECTED_FOREIGN_KEYS: DbForeignKeyRow[] = [
  {
    table_schema: 'mrp_out',
    table_name: 'production_plan_transfers',
    column_name: 'mrp_run_id',
    foreign_table_schema: 'public',
    foreign_table_name: 'mrp_run',
    foreign_column_name: 'id',
    delete_rule: 'SET NULL',
  },
];

export interface DbTableRow {
  table_schema: string;
  table_name: string;
}

export interface DbColumnRow extends DbTableRow {
  column_name: string;
  is_nullable: string;
}

export interface DbIndexRow extends DbTableRow {
  index_name: string;
}

export const REQUIRED_NULLABLE_COLUMNS = [
  'staging.orders.prepared_qty',
  'staging.orders.shipped_qty',
  'staging.orders.sold_qty',
  'staging.orders.order_type',
  'staging.inventory.purchase_lead_weeks_configured',
  'staging.work_order_bom.consumed_qty',
  'staging.work_order_bom.reserved_qty',
  'mrp_out.component_weekly.purchase_lead_weeks_configured',
  'mrp_out.component_weekly.shortage_start_date',
  'mrp_out.component_weekly.order_by_date',
  'mrp_out.component_weekly.purchase_action',
  'mrp_out.component_weekly.next_purchase_receipt_date',
  'mrp_out.production_plan_transfers.mrp_run_id',
] as const;

export function findMissingDatabaseObjects(
  tableRows: DbTableRow[],
  columnRows: DbColumnRow[],
  indexRows: DbIndexRow[],
  foreignKeyRows: DbForeignKeyRow[],
): {
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  invalidColumnNullability: string[];
  missingForeignKeys: string[];
  missing: string[];
} {
  const existingTables = new Set(tableRows.map((row) => `${row.table_schema}.${row.table_name}`));
  const existingColumns = new Set(
    columnRows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`),
  );
  const existingIndexes = new Set(
    indexRows.map((row) => `${row.table_schema}.${row.table_name}.${row.index_name}`),
  );
  const columnByName = new Map(
    columnRows.map((row) => [
      `${row.table_schema}.${row.table_name}.${row.column_name}`,
      row,
    ]),
  );
  const foreignKeyName = (row: DbForeignKeyRow) =>
    `${row.table_schema}.${row.table_name}.${row.column_name}`
    + ` -> ${row.foreign_table_schema}.${row.foreign_table_name}.${row.foreign_column_name}`
    + ` ON DELETE ${row.delete_rule}`;

  const missingTables: string[] = [];
  for (const [schema, tables] of Object.entries(EXPECTED_TABLES)) {
    for (const table of tables) {
      const name = `${schema}.${table}`;
      if (!existingTables.has(name)) missingTables.push(name);
    }
  }

  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!existingTables.has(table)) continue;
    for (const column of columns) {
      const name = `${table}.${column}`;
      if (!existingColumns.has(name)) missingColumns.push(name);
    }
  }

  const missingIndexes: string[] = [];
  for (const [table, indexes] of Object.entries(REQUIRED_INDEXES)) {
    if (!existingTables.has(table)) continue;
    for (const index of indexes) {
      const name = `${table}.${index}`;
      if (!existingIndexes.has(name)) missingIndexes.push(name);
    }
  }

  const invalidColumnNullability = REQUIRED_NULLABLE_COLUMNS
    .filter((name) => {
      const column = columnByName.get(name);
      return column !== undefined && column.is_nullable !== 'YES';
    })
    .map((name) => `${name} must be nullable`);

  const missingForeignKeys = EXPECTED_FOREIGN_KEYS
    .filter((foreignKey) => {
      if (
        !existingTables.has(`${foreignKey.table_schema}.${foreignKey.table_name}`)
        || !existingTables.has(
          `${foreignKey.foreign_table_schema}.${foreignKey.foreign_table_name}`,
        )
      ) {
        return false;
      }
      const columnForeignKeys = foreignKeyRows.filter((row) => (
        row.table_schema === foreignKey.table_schema
        && row.table_name === foreignKey.table_name
        && row.column_name === foreignKey.column_name
      ));
      return columnForeignKeys.length !== 1
        || foreignKeyName(columnForeignKeys[0]) !== foreignKeyName(foreignKey);
    })
    .map(foreignKeyName);

  return {
    missingTables,
    missingColumns,
    missingIndexes,
    invalidColumnNullability,
    missingForeignKeys,
    missing: [
      ...missingTables,
      ...missingColumns,
      ...missingIndexes,
      ...invalidColumnNullability,
      ...missingForeignKeys,
    ],
  };
}
