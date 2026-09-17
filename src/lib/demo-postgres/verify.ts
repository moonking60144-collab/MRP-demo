import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { calculateSyntheticRun, hydrateRows } from '../demo/calculator';
import { calculationContext } from '../demo/calculation-context';
import { generateDataset, type DemoDataset, type DemoRow, type DemoRun } from '../demo/data';
import { seedRuns } from '../demo/store';
import { calculateFgMonthly, calculateFgMonthlyAggregated } from '../mrp/fg-monthly-engine';
import { calculateComponentWeekly } from '../mrp/component-weekly-engine';
import { calculateSalesMeeting } from '../mrp/sales-meeting-engine';
import { loadRunCalculationInputs } from '../mrp/run-calculation-inputs';
import { ORDER_DEMAND_CONTRACT_V2 } from '../mrp/order-demand-contract';
import { assertDemoPostgresTarget, PURPOSE, PURPOSE_KEY, TEST_DATABASE, TEST_USER } from './target';

const sourceModels = {
  part_versions: 'StagingPartVersion', inventory: 'StagingInventory', orders: 'StagingOrder', forecasts: 'StagingForecast',
  work_orders: 'StagingWorkOrder', work_order_bom: 'StagingWorkOrderBom', production_plans: 'StagingProductionPlan',
  purchase_orders: 'StagingPurchaseOrder', inventory_lots: 'StagingInventoryLot', work_order_material_movements: 'StagingWorkOrderMaterialMovement',
};
const outputModels = { fgMonthly: 'FgMonthly', fgMonthlyPeriod: 'FgMonthlyPeriod', fgPlanSuggestion: 'FgPlanSuggestion', componentWeekly: 'ComponentWeekly', componentWeeklyPeriod: 'ComponentWeeklyPeriod', salesMeeting: 'SalesMeeting', salesMeetingPeriod: 'SalesMeetingPeriod' };

async function assertPurpose(client: Pick<Prisma.TransactionClient, 'appSetting'>) {
  assert.equal((await client.appSetting.findUnique({ where: { key: PURPOSE_KEY } }))?.value, PURPOSE, '拒絕用途標記不符的既有資料庫。');
}

async function initialize(client: PrismaClient, url: URL) {
  const [identity] = await client.$queryRaw<{ database: string; user: string; owner: string; version: string }[]>`
    SELECT current_database() AS database, current_user AS "user", pg_get_userbyid(datdba) AS owner, version() AS version
    FROM pg_database WHERE datname = current_database()`;
  assert.equal(identity.database, TEST_DATABASE); assert.equal(identity.user, TEST_USER); assert.equal(identity.owner, TEST_USER);
  const tables = await client.$queryRaw<{ schemaname: string; tablename: string }[]>`SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`;
  if (tables.length) {
    assert.ok(tables.some(row => row.schemaname === 'public' && row.tablename === 'app_settings'), '拒絕未標記的既有資料庫。');
    await assertPurpose(client);
    return identity;
  }
  const cli = join(process.cwd(), 'node_modules/prisma/build/index.js');
  const sql = execFileSync(process.execPath, [cli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const directory = mkdtempSync(join(tmpdir(), 'mrp-prisma-ddl-'));
  try {
    const file = join(directory, 'initialize.sql');
    writeFileSync(file, `BEGIN;
SELECT pg_advisory_xact_lock(87263849);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) THEN RAISE EXCEPTION 'Database is no longer empty'; END IF; END $$;
${sql}
INSERT INTO public.app_settings (key, value, updated_at) VALUES ('${PURPOSE_KEY}', '"${PURPOSE}"'::jsonb, CURRENT_TIMESTAMP);
COMMIT;`);
    execFileSync(process.execPath, [cli, 'db', 'execute', '--url', url.toString(), '--file', file], { encoding: 'utf8', stdio: 'pipe' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  await assertPurpose(client);
  return identity;
}

function sourceRows(modelName: string, rows: DemoRow[]) {
  const fields = Prisma.dmmf.datamodel.models.find(model => model.name === modelName)!.fields.filter(field => field.kind !== 'object' && field.name !== 'id');
  return hydrateRows(modelName, rows).map(row => Object.fromEntries(fields.map(field => [field.name,
    field.type === 'Json' && row[field.name] === null ? Prisma.DbNull : row[field.name],
  ])));
}

function canonical(modelName: string, rows: DemoRow[], dateFields: Set<string>) {
  const fields = Prisma.dmmf.datamodel.models.find(model => model.name === modelName)!.fields.filter(field => field.kind !== 'object' && field.name !== 'id');
  return rows.map(row => Object.fromEntries(fields.map(field => {
    let value = row[field.name];
    if (value != null && ['Decimal', 'Float'].includes(field.type)) value = Number(Number(value).toPrecision(12));
    if (value != null && field.type === 'DateTime') {
      value = new Date(String(value)).toISOString();
      if (dateFields.has(`${modelName}.${field.name}`)) value = String(value).slice(0, 10);
    }
    return [field.name, value];
  }))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function readReports(client: PrismaClient, runId: number) {
  const [fgMonthly, fgMonthlyPeriod, fgPlanSuggestion, componentWeekly, componentWeeklyPeriod, salesMeeting, salesMeetingPeriod] = await Promise.all([
    client.fgMonthly.findMany({ where: { mrpRunId: runId } }), client.fgMonthlyPeriod.findMany({ where: { mrpRunId: runId } }),
    client.fgPlanSuggestion.findMany({ where: { mrpRunId: runId } }), client.componentWeekly.findMany({ where: { mrpRunId: runId } }),
    client.componentWeeklyPeriod.findMany({ where: { mrpRunId: runId } }), client.salesMeeting.findMany({ where: { mrpRunId: runId } }),
    client.salesMeetingPeriod.findMany({ where: { mrpRunId: runId } }),
  ]);
  return { fgMonthly, fgMonthlyPeriod, fgPlanSuggestion, componentWeekly, componentWeeklyPeriod, salesMeeting, salesMeetingPeriod };
}

function reportSnapshot(reports: Awaited<ReturnType<typeof readReports>>) {
  // 比對持久化欄位與 ID，而不是 Prisma Decimal 實例的建構函式／內部物件。
  return Object.fromEntries(Object.entries(reports).map(([key, rows]) => [key, JSON.parse(JSON.stringify(rows.sort((a, b) => a.id - b.id)))]));
}

async function seed(client: PrismaClient, run: DemoRun) {
  const data = generateDataset(run);
  await client.$transaction(async tx => {
    for (const [table, model] of Object.entries(sourceModels)) {
      const delegate = `${model[0].toLowerCase()}${model.slice(1)}`;
      const target = (tx as unknown as Record<string, { createMany: (arg: { data: DemoRow[] }) => Promise<unknown> }>)[delegate];
      await target.createMany({ data: sourceRows(model, data.source[table]) });
    }
  }, { timeout: 60000 });
  return data;
}

async function calculate(client: PrismaClient, runId: number) {
  await calculationContext.run(client, async () => {
    const inputs = await loadRunCalculationInputs(runId);
    assert.equal(inputs.partVersionRows.length, 48);
    await calculateFgMonthly(runId, inputs);
    // 聚合刻意走 DB 讀取，驗證剛寫入的逐版本結果可以被原引擎查回。
    await calculateFgMonthlyAggregated(runId);
    for (const type of ['W', 'B', 'D'] as const) await calculateComponentWeekly(runId, type, inputs);
    await calculateSalesMeeting(runId, inputs);
  });
}

function assertReportParity(actual: Awaited<ReturnType<typeof readReports>>, expected: { data: DemoDataset; suggestions: DemoRow[] }, dateFields: Set<string>) {
  const rows = { fgMonthly: expected.data.fg, fgMonthlyPeriod: Object.values(expected.data.fgPeriods).flat(), fgPlanSuggestion: expected.suggestions, componentWeekly: expected.data.cw, componentWeeklyPeriod: Object.values(expected.data.cwPeriods).flat(), salesMeeting: expected.data.sales, salesMeetingPeriod: Object.values(expected.data.salesPeriods).flat() };
  for (const [key, model] of Object.entries(outputModels)) assert.deepEqual(canonical(model, actual[key as keyof typeof actual], dateFields), canonical(model, rows[key as keyof typeof rows], dateFields), `POSTGRES_REPORT_PARITY:${key}`);
}

async function verify(client: PrismaClient, identity: Awaited<ReturnType<typeof initialize>>) {
  const checks: string[] = [];
  const rollbackPurpose = new Error('PURPOSE_PROBE_ROLLBACK');
  await assert.rejects(client.$transaction(async tx => {
    await tx.appSetting.update({ where: { key: PURPOSE_KEY }, data: { value: 'not-a-demo-test-database' } });
    await assert.rejects(assertPurpose(tx), /拒絕用途標記不符/);
    throw rollbackPurpose;
  }), error => error === rollbackPurpose);
  await assertPurpose(client);
  checks.push('existing-database-purpose-fail-closed-and-marker-preserved');
  const dateColumns = await client.$queryRaw<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'mrp_out' AND data_type = 'date'`;
  const dateFields = new Set(Prisma.dmmf.datamodel.models.filter(model => Object.values(outputModels).includes(model.name)).flatMap(model => model.fields.filter(field => dateColumns.some(column => column.table_name === model.dbName && column.column_name === (field.dbName ?? field.name))).map(field => `${model.name}.${field.name}`)));
  const runs: DemoRun[] = [];
  for (let index = 0; index < 2; index++) {
    const row = await client.mrpRun.create({ data: { versionCode: `DEMO-PG-${randomUUID()}`, runDate: new Date('2026-09-03T00:00:00.000Z'), status: 'completed', createdBy: 'Demo', orderDemandContractVersion: ORDER_DEMAND_CONTRACT_V2 } });
    runs.push({ ...seedRuns()[0], id: row.id, versionCode: row.versionCode, runDate: row.runDate.toISOString() });
  }
  const first = runs[0], second = runs[1];
  console.log('PostgreSQL verification: seed-first-run');
  const data = await seed(client, first);
  const expected = await calculateSyntheticRun(first);
  await calculate(client, first.id);
  console.log('PostgreSQL verification: compare-first-run');
  const before = await readReports(client, first.id);
  const firstSnapshot = reportSnapshot(before);
  assertReportParity(before, expected, dateFields);
  checks.push('real-Prisma-source-read-batch-write-and-all-seven-output-models-parity');

  const aggregate = before.fgMonthly.find(row => row.isAggregated && row.erpPartNo === 'DEMO-FG-001-V01')!;
  assert.ok(aggregate); assert.equal(Number(aggregate.currentStockPc), 2090, 'SHARED_STOCK_NOT_DOUBLED');
  for (const component of before.componentWeekly) {
    const sourceUsage = data.source.work_order_bom.filter(row => row.componentNo === component.materialPartNo).reduce((sum, row) => sum + Number(row.remainingUsage), 0);
    const persistedUsage = before.componentWeeklyPeriod.filter(row => row.materialPartNo === component.materialPartNo && row.mrpType === component.mrpType).reduce((sum, row) => sum + Number(row.usage), 0);
    assert.ok(Math.abs(sourceUsage - persistedUsage) < 1e-8, `MATERIAL_USAGE_CONSERVED:${component.materialPartNo}`);
  }
  assert.equal(Number((await client.stagingWorkOrderBom.findFirst({ where: { mrpRunId: first.id, componentNo: 'DEMO-B-005', returnedQty: 300 } }))?.returnedQty), 300);
  const progress = (await client.mrpRun.findUniqueOrThrow({ where: { id: first.id } })).stepStatus as Record<string, unknown>;
  for (const key of ['_calcProgress', '_componentProgress_W', '_componentProgress_B', '_componentProgress_D', '_salesMeetingProgress']) assert.ok(progress[key]);
  checks.push('independent-shared-stock-material-usage-return-quantity-and-real-JSONB-progress-SQL');

  console.log('PostgreSQL verification: second-run-isolation');
  await seed(client, second);
  await calculate(client, second.id);
  assert.deepEqual(reportSnapshot(await readReports(client, first.id)), firstSnapshot, 'POSTGRES_RUN_ISOLATION');
  const secondExpected = await calculateSyntheticRun(second);
  assertReportParity(await readReports(client, second.id), secondExpected, dateFields);
  await calculate(client, second.id);
  assertReportParity(await readReports(client, second.id), secondExpected, dateFields);
  console.log('PostgreSQL verification: rerun-isolation');
  assert.deepEqual(reportSnapshot(await readReports(client, first.id)), firstSnapshot, 'POSTGRES_RUN_ISOLATION_AFTER_RERUN');
  checks.push('second-Run-isolation-and-same-Run-rerun-without-duplicate-output');

  await assert.rejects(client.mrpRun.create({ data: { versionCode: first.versionCode, runDate: new Date(first.runDate) } }), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
  const rollbackCode = `DEMO-ROLLBACK-${randomUUID()}`;
  console.log('PostgreSQL verification: transaction-rollback');
  await assert.rejects(client.$transaction(async tx => {
    const run = await tx.mrpRun.create({ data: { versionCode: rollbackCode, runDate: new Date(first.runDate) } });
    await tx.stagingInventory.create({ data: { mrpRunId: run.id, ragicRecordId: rollbackCode, erpPartNo: rollbackCode, goodStockPc: 123 } });
    await tx.mrpRun.create({ data: { versionCode: first.versionCode, runDate: new Date(first.runDate) } });
  }), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
  assert.equal(await client.mrpRun.count({ where: { versionCode: rollbackCode } }), 0);
  assert.equal(await client.stagingInventory.count({ where: { ragicRecordId: rollbackCode } }), 0, 'POSTGRES_TRANSACTION_ROLLBACK');
  checks.push('database-unique-constraint-and-cross-table-transaction-rollback');
  return { status: 'passed', synthetic: true, database: identity.database, user: identity.user, postgres: identity.version, prisma: Prisma.prismaVersion.client, node: process.version, platform: process.platform, checks, runs: runs.map(run => ({ id: run.id, versionCode: run.versionCode })), counts: Object.fromEntries(Object.entries(before).map(([key, rows]) => [key, rows.length])), comparison: 'All persisted output fields except surrogate IDs; PG DATE columns compared as dates using actual column metadata; Decimal/Float normalized to12 significant digits; independent material sums tolerance1e-8.' };
}

async function main() {
  const output = join(process.cwd(), 'release/prisma-postgres.json');
  mkdirSync(join(process.cwd(), 'release'), { recursive: true });
  let client: PrismaClient | undefined;
  try {
    const url = assertDemoPostgresTarget(process.env.MRP_DEMO_TEST_DATABASE_URL);
    client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const result = await verify(client, await initialize(client, url));
    writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '[synthetic test target]');
    writeFileSync(output, JSON.stringify({ status: 'failed', synthetic: true, error: message }, null, 2));
    console.error(message.slice(0, 5000));
    process.exitCode = 1;
  } finally { await client?.$disconnect(); }
}
void main();
