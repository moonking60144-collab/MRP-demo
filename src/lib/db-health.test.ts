import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EXPECTED_TABLES,
  EXPECTED_FOREIGN_KEYS,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  findMissingDatabaseObjects,
  type DbColumnRow,
  type DbForeignKeyRow,
  type DbIndexRow,
  type DbTableRow,
} from './db-health';

function completeSchema(): {
  tables: DbTableRow[];
  columns: DbColumnRow[];
  indexes: DbIndexRow[];
  foreignKeys: DbForeignKeyRow[];
} {
  const tables = Object.entries(EXPECTED_TABLES).flatMap(([table_schema, names]) =>
    names.map((table_name) => ({ table_schema, table_name })),
  );
  const columns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) => {
    const [table_schema, table_name] = table.split('.');
    return names.map((column_name) => ({
      table_schema,
      table_name,
      column_name,
      is_nullable: 'YES',
    }));
  });
  const indexes = Object.entries(REQUIRED_INDEXES).flatMap(([table, names]) => {
    const [table_schema, table_name] = table.split('.');
    return names.map((index_name) => ({ table_schema, table_name, index_name }));
  });
  return {
    tables,
    columns,
    indexes,
    foreignKeys: EXPECTED_FOREIGN_KEYS.map((foreignKey) => ({ ...foreignKey })),
  };
}

test('DB health 同時驗證必要資料表與目前資料流會用到的 migration 欄位', () => {
  const schema = completeSchema();
  assert.deepEqual(findMissingDatabaseObjects(
    schema.tables,
    schema.columns,
    schema.indexes,
    schema.foreignKeys,
  ), {
    missingTables: [],
    missingColumns: [],
    missingIndexes: [],
    invalidColumnNullability: [],
    missingForeignKeys: [],
    missing: [],
  });

  const columns = schema.columns.filter((row) => row.column_name !== 'order_no');
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      columns,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.orders.order_no'],
  );

  const withoutWorkOrderStatus = schema.columns.filter(
    (row) => row.column_name !== 'work_order_status',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutWorkOrderStatus,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['mrp_out.production_plan_transfers.work_order_status'],
  );

  const withoutInStock = schema.columns.filter((row) => row.column_name !== 'in_stock_pc');
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutInStock,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.inventory.in_stock_pc'],
  );

  const withoutItemStatus = schema.columns.filter((row) => row.column_name !== 'item_status');
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutItemStatus,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.inventory.item_status'],
  );

  const withoutPurchaseDecision = schema.columns.filter(
    (row) => row.column_name !== 'purchase_action',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutPurchaseDecision,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['mrp_out.component_weekly.purchase_action'],
  );

  const withoutSourceWorkOrder = schema.columns.filter(
    (row) => row.column_name !== 'source_work_order_no',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutSourceWorkOrder,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.inventory_lots.source_work_order_no'],
  );

  const withoutNetIssued = schema.columns.filter(
    (row) => row.column_name !== 'net_issued_qty',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutNetIssued,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.work_order_bom.net_issued_qty'],
  );

  const withoutConsumed = schema.columns.filter(
    (row) => row.column_name !== 'consumed_qty',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutConsumed,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.work_order_bom.consumed_qty'],
  );

  const withoutMovementType = schema.columns.filter(
    (row) => row.column_name !== 'movement_type',
  );
  assert.deepEqual(
    findMissingDatabaseObjects(
      schema.tables,
      withoutMovementType,
      schema.indexes,
      schema.foreignKeys,
    ).missingColumns,
    ['staging.work_order_material_movements.movement_type'],
  );
});

test('init.sql 的新建與既有資料庫路徑都包含 inventory item_status', () => {
  const initSql = readFileSync(new URL('../../prisma/init.sql', import.meta.url), 'utf8');

  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS staging\.inventory \([\s\S]*?\bitem_status\s+TEXT[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /ALTER TABLE staging\.inventory ADD COLUMN IF NOT EXISTS item_status TEXT;/,
  );
});

test('init.sql 的新建與既有資料庫路徑都包含版本化訂單需求欄位', () => {
  const initSql = readFileSync(new URL('../../prisma/init.sql', import.meta.url), 'utf8');

  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS mrp_run \([\s\S]*?\border_demand_contract_version\s+TEXT NOT NULL DEFAULT 'order-demand-v1'[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS staging\.orders \([\s\S]*?\bprepared_qty\s+NUMERIC[\s\S]*?\bshipped_qty\s+NUMERIC[\s\S]*?\bsold_qty\s+NUMERIC[\s\S]*?\border_type\s+TEXT[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /ALTER TABLE mrp_run[\s\S]*?ADD COLUMN IF NOT EXISTS order_demand_contract_version TEXT NOT NULL DEFAULT 'order-demand-v1';/,
  );
  assert.match(initSql, /ALTER TABLE staging\.orders ADD COLUMN IF NOT EXISTS shipped_qty NUMERIC;/);
});

test('Prisma 對 unbounded NUMERIC 保留原生型別，不要求無關欄位轉成 Decimal(65,30)', () => {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

  for (const field of [
    'preparedQty',
    'shippedQty',
    'soldQty',
    'consumedQty',
    'reservedQty',
    'shortageQty',
    'overduePurchaseQty',
    'futurePurchaseQty',
  ]) {
    assert.match(schema, new RegExp(`\\b${field}\\s+Decimal\\??[^\\n]*@db\\.Decimal`));
  }
});

test('MRP start 與 resume 都在 Run lifecycle、資料模型與 Ragic preflight 前檢查 schema', () => {
  for (const relativePath of [
    '../app/api/runs/route.ts',
    '../app/api/runs/[id]/resume/route.ts',
  ]) {
    const route = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    const post = route.slice(route.indexOf('export async function POST'));
    const databasePreflight = post.indexOf('await requireDatabasePreflight();');
    const lifecycle = post.indexOf('await ensureRunLifecycle();');
    const ragicPreflight = post.indexOf('await requireRagicPreflight();');

    assert.ok(databasePreflight >= 0, `${relativePath} 缺少 database preflight`);
    assert.ok(lifecycle > databasePreflight, `${relativePath} 在 schema gate 前啟動 Run lifecycle`);
    assert.ok(ragicPreflight > databasePreflight, `${relativePath} 在 schema gate 前呼叫 Ragic`);
    assert.match(post, /code:\s*'DATABASE_SCHEMA_INCOMPLETE'/);
  }
});

test('init.sql 的新建與既有資料庫路徑都包含元件採購判斷欄位', () => {
  const initSql = readFileSync(new URL('../../prisma/init.sql', import.meta.url), 'utf8');

  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS staging\.inventory \([\s\S]*?\bpurchase_lead_weeks_configured\s+BOOLEAN[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS mrp_out\.component_weekly \([\s\S]*?\bpurchase_action\s+TEXT[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /ALTER TABLE staging\.inventory ADD COLUMN IF NOT EXISTS purchase_lead_weeks_configured BOOLEAN;/,
  );
  assert.match(
    initSql,
    /ALTER TABLE mrp_out\.component_weekly ADD COLUMN IF NOT EXISTS purchase_action TEXT;/,
  );
});

test('轉單稽核 FK 使用 SET NULL，清除來源 Run 時保留轉單紀錄', () => {
  const prismaSchema = readFileSync(
    new URL('../../prisma/schema.prisma', import.meta.url),
    'utf8',
  );
  const initSql = readFileSync(new URL('../../prisma/init.sql', import.meta.url), 'utf8');

  assert.match(
    prismaSchema,
    /model ProductionPlanTransfer \{[\s\S]*?\bmrpRunId\s+Int\?[\s\S]*?@relation\([\s\S]*?onDelete:\s*SetNull[\s\S]*?\)/,
  );
  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS mrp_out\.production_plan_transfers \([\s\S]*?\bmrp_run_id\s+INT REFERENCES public\.mrp_run\(id\) ON DELETE SET NULL[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /ALTER TABLE mrp_out\.production_plan_transfers[\s\S]*?ALTER COLUMN mrp_run_id DROP NOT NULL;[\s\S]*?UPDATE mrp_out\.production_plan_transfers AS transfer_row[\s\S]*?SET mrp_run_id = NULL[\s\S]*?WHERE transfer_row\.mrp_run_id IS NOT NULL[\s\S]*?NOT EXISTS \([\s\S]*?FROM public\.mrp_run AS run_row[\s\S]*?WHERE run_row\.id = transfer_row\.mrp_run_id[\s\S]*?\);[\s\S]*?FOREIGN KEY \(mrp_run_id\) REFERENCES public\.mrp_run\(id\) ON DELETE SET NULL/,
  );
});

test('DB health 會拒絕 production_plan_transfers 的 cascade FK', () => {
  const schema = completeSchema();
  const cascadeForeignKeys = schema.foreignKeys.map((foreignKey) => ({
    ...foreignKey,
    delete_rule: 'CASCADE',
  }));

  const result = findMissingDatabaseObjects(
    schema.tables,
    schema.columns,
    schema.indexes,
    cascadeForeignKeys,
  );

  assert.deepEqual(result.missingForeignKeys, [
    'mrp_out.production_plan_transfers.mrp_run_id -> public.mrp_run.id ON DELETE SET NULL',
  ]);
  assert.ok(result.missing.includes(result.missingForeignKeys[0]));
});

test('DB health 會拒絕同欄位同時存在 SET NULL 與 cascade FK', () => {
  const schema = completeSchema();
  const mixedForeignKeys = [
    ...schema.foreignKeys,
    {
      ...schema.foreignKeys[0],
      delete_rule: 'CASCADE',
    },
  ];

  const result = findMissingDatabaseObjects(
    schema.tables,
    schema.columns,
    schema.indexes,
    mixedForeignKeys,
  );

  assert.deepEqual(result.missingForeignKeys, [
    'mrp_out.production_plan_transfers.mrp_run_id -> public.mrp_run.id ON DELETE SET NULL',
  ]);
  assert.ok(result.missing.includes(result.missingForeignKeys[0]));
});

test('DB health 會拒絕 SET NULL FK 對應到 NOT NULL mrp_run_id', () => {
  const schema = completeSchema();
  const columns = schema.columns.map((column) => (
    column.table_schema === 'mrp_out'
      && column.table_name === 'production_plan_transfers'
      && column.column_name === 'mrp_run_id'
      ? { ...column, is_nullable: 'NO' }
      : column
  ));

  const result = findMissingDatabaseObjects(
    schema.tables,
    columns,
    schema.indexes,
    schema.foreignKeys,
  );

  assert.deepEqual(result.invalidColumnNullability, [
    'mrp_out.production_plan_transfers.mrp_run_id must be nullable',
  ]);
  assert.ok(result.missing.includes(result.invalidColumnNullability[0]));
});

test('DB health 會拒絕工令實際耗用量被建成 NOT NULL', () => {
  const schema = completeSchema();
  const columns = schema.columns.map((column) => (
    column.table_schema === 'staging'
      && column.table_name === 'work_order_bom'
      && column.column_name === 'consumed_qty'
      ? { ...column, is_nullable: 'NO' }
      : column
  ));

  const result = findMissingDatabaseObjects(
    schema.tables,
    columns,
    schema.indexes,
    schema.foreignKeys,
  );

  assert.deepEqual(result.invalidColumnNullability, [
    'staging.work_order_bom.consumed_qty must be nullable',
  ]);
});

test('init.sql 的新建與既有資料庫路徑都包含工令耗用與保留欄位', () => {
  const initSql = readFileSync(new URL('../../prisma/init.sql', import.meta.url), 'utf8');

  assert.match(
    initSql,
    /CREATE TABLE IF NOT EXISTS staging\.work_order_bom \([\s\S]*?\bconsumed_qty\s+NUMERIC[\s\S]*?\breserved_qty\s+NUMERIC[\s\S]*?\);/,
  );
  assert.match(
    initSql,
    /ALTER TABLE staging\.work_order_bom ADD COLUMN IF NOT EXISTS consumed_qty NUMERIC;/,
  );
  assert.match(
    initSql,
    /ALTER TABLE staging\.work_order_bom ADD COLUMN IF NOT EXISTS reserved_qty NUMERIC;/,
  );
});

test('DB health 會回報 Prisma 部署缺少的 staging Run 查詢索引', () => {
  const schema = completeSchema();
  const indexes = schema.indexes.filter((row) => row.index_name !== 'idx_staging_inv');

  const result = findMissingDatabaseObjects(
    schema.tables,
    schema.columns,
    indexes,
    schema.foreignKeys,
  );
  assert.deepEqual(result.missingIndexes, ['staging.inventory.idx_staging_inv']);
  assert.ok(result.missing.includes('staging.inventory.idx_staging_inv'));
});

test('資料表不存在時只回報缺表，不重複列出該表所有缺欄位', () => {
  const schema = completeSchema();
  const tables = schema.tables.filter(
    (row) => !(row.table_schema === 'staging' && row.table_name === 'orders'),
  );

  const result = findMissingDatabaseObjects(
    tables,
    schema.columns,
    schema.indexes,
    schema.foreignKeys,
  );
  assert.deepEqual(result.missingTables, ['staging.orders']);
  assert.deepEqual(result.missingColumns, []);
  assert.ok(!result.missingIndexes.some((name) => name.startsWith('staging.orders.')));
});
