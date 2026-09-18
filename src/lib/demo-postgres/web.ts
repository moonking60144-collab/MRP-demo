import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { hydrateRows } from '../demo/calculator';
import { dataset, type DemoDataset, type DemoRow } from '../demo/data';
import { assertDemoPostgresWebTarget, PURPOSE_KEY, TEST_USER, WEB_DATABASE, WEB_PURPOSE } from './target';

export const sourceModels = {
  part_versions: 'StagingPartVersion', inventory: 'StagingInventory', orders: 'StagingOrder', forecasts: 'StagingForecast',
  work_orders: 'StagingWorkOrder', work_order_bom: 'StagingWorkOrderBom', production_plans: 'StagingProductionPlan',
  purchase_orders: 'StagingPurchaseOrder', inventory_lots: 'StagingInventoryLot', work_order_material_movements: 'StagingWorkOrderMaterialMovement',
};
const outputModels = { fgMonthly: 'FgMonthly', fgMonthlyPeriod: 'FgMonthlyPeriod', componentWeekly: 'ComponentWeekly', componentWeeklyPeriod: 'ComponentWeeklyPeriod', salesMeeting: 'SalesMeeting', salesMeetingPeriod: 'SalesMeetingPeriod' };
type Delegate = { createMany: (arg: { data: DemoRow[] }) => Promise<unknown>; findMany: (arg: { where: { mrpRunId: number }; orderBy: { id: 'asc' } }) => Promise<DemoRow[]> };
const root = globalThis as typeof globalThis & { demoPostgres?: { url: string; client: PrismaClient; ready: Promise<unknown> } };

export function postgresDemoEnabled(): boolean { return !!process.env.MRP_DEMO_POSTGRES_URL; }

export async function assertPostgresWebIdentity(client: PrismaClient) {
  const [identity] = await client.$queryRaw<{ database: string; user: string; owner: string; version: string }[]>`
    SELECT current_database() AS database, current_user AS "user", pg_get_userbyid(datdba) AS owner, version() AS version
    FROM pg_database WHERE datname = current_database()`;
  assert.equal(identity.database, WEB_DATABASE); assert.equal(identity.user, TEST_USER); assert.equal(identity.owner, TEST_USER);
  assert.equal((await client.appSetting.findUnique({ where: { key: PURPOSE_KEY } }))?.value, WEB_PURPOSE, 'POSTGRES_WEB_PURPOSE_REQUIRED');
  return identity;
}

export async function postgresWebClient(): Promise<PrismaClient> {
  const url = assertDemoPostgresWebTarget(process.env.MRP_DEMO_POSTGRES_URL).toString();
  if (root.demoPostgres && root.demoPostgres.url !== url) throw new Error('PostgreSQL 展示連線固定於啟動時；請停止後重新啟動。');
  if (!root.demoPostgres) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    root.demoPostgres = { url, client, ready: assertPostgresWebIdentity(client) };
  }
  const current = root.demoPostgres;
  try { await current.ready; return current.client; }
  catch (error) { if (root.demoPostgres === current) delete root.demoPostgres; await current.client.$disconnect(); throw error; }
}

export async function closePostgresWebClient(): Promise<void> {
  const current = root.demoPostgres;
  delete root.demoPostgres;
  await current?.client.$disconnect();
}

function delegate(client: Prisma.TransactionClient, model: string): Delegate {
  return (client as unknown as Record<string, Delegate>)[model[0].toLowerCase() + model.slice(1)];
}
function rowsForDatabase(model: string, rows: DemoRow[]) {
  const fields = Prisma.dmmf.datamodel.models.find(item => item.name === model)!.fields.filter(field => field.kind !== 'object' && field.name !== 'id');
  return hydrateRows(model, rows).map(row => Object.fromEntries(fields.map(field => [field.name,
    field.type === 'Json' && row[field.name] === null ? Prisma.DbNull : row[field.name],
  ])));
}

function reportRows(model: string, rows: DemoRow[]) {
  const decimals = Prisma.dmmf.datamodel.models.find(item => item.name === model)!.fields.filter(field => field.type === 'Decimal');
  return rows.map(row => ({ ...row, ...Object.fromEntries(decimals.map(field => [field.name, row[field.name] == null ? null : Number(row[field.name])])) }));
}

export async function materializePostgresSnapshot(client: PrismaClient, data: DemoDataset) {
  if (data.run.status !== 'completed') throw new Error('PostgreSQL 報表只接受已完成的合成快照。');
  const runId = data.run.id;
  const versionCode = `DEMO-WEB:${data.run.versionCode}`;
  const key = `demo-postgres-snapshot:${runId}`;
  const hash = createHash('sha256').update(JSON.stringify({ source: data.source, fg: data.fg, cw: data.cw, sales: data.sales, fgPeriods: data.fgPeriods, cwPeriods: data.cwPeriods, salesPeriods: data.salesPeriods })).digest('hex');
  await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(87263850, ${runId}::int)::text`;
    const existing = await tx.mrpRun.findUnique({ where: { id: runId } });
    if (existing) {
      assert.equal(existing.versionCode, versionCode, 'POSTGRES_WEB_RUN_IDENTITY');
      assert.equal((await tx.appSetting.findUnique({ where: { key } }))?.value, hash, 'POSTGRES_WEB_SNAPSHOT_CONFLICT');
      return;
    }
    await tx.mrpRun.create({ data: { id: runId, versionCode, runDate: new Date(data.run.runDate), status: 'completed', createdBy: 'Demo', isLatest: false } });
    for (const [table, model] of Object.entries(sourceModels)) await delegate(tx, model).createMany({ data: rowsForDatabase(model, data.source[table]) });
    const reports = { fgMonthly: data.fg, fgMonthlyPeriod: Object.values(data.fgPeriods).flat(), componentWeekly: data.cw, componentWeeklyPeriod: Object.values(data.cwPeriods).flat(), salesMeeting: data.sales, salesMeetingPeriod: Object.values(data.salesPeriods).flat() };
    for (const [table, model] of Object.entries(outputModels)) await delegate(tx, model).createMany({ data: rowsForDatabase(model, reports[table as keyof typeof reports]) });
    await tx.appSetting.create({ data: { key, value: hash } });
  }, { timeout: 60000 });
}

export async function readPostgresDataset(runId: number): Promise<DemoDataset> {
  const snapshot = dataset(runId);
  const client = await postgresWebClient();
  await assertPostgresWebIdentity(client);
  await materializePostgresSnapshot(client, snapshot);
  const source = Object.fromEntries(await Promise.all(Object.entries(sourceModels).map(async ([table, model]) => [table, reportRows(model, await delegate(client, model).findMany({ where: { mrpRunId: runId }, orderBy: { id: 'asc' } }))])));
  const reports = Object.fromEntries(await Promise.all(Object.entries(outputModels).map(async ([table, model]) => [table, reportRows(model, await delegate(client, model).findMany({ where: { mrpRunId: runId }, orderBy: { id: 'asc' } }))])));
  const by = (rows: DemoRow[], field: string, aggregated = false) => {
    const periods: Record<string, DemoRow[]> = {};
    for (const row of rows) (periods[String(row[field]) + (aggregated && row.isAggregated ? ':aggregate' : '')] ??= []).push(row);
    return periods;
  };
  return JSON.parse(JSON.stringify({ run: snapshot.run, source, fg: reports.fgMonthly, cw: reports.componentWeekly, sales: reports.salesMeeting,
    fgPeriods: by(reports.fgMonthlyPeriod, 'partVersion', true), cwPeriods: by(reports.componentWeeklyPeriod, 'materialPartNo'), salesPeriods: by(reports.salesMeetingPeriod, 'partVersion'),
  }));
}
