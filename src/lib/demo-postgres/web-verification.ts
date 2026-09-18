import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { GET as fg } from '../../app/api/fg-monthly/route';
import { GET as cw } from '../../app/api/component-weekly/route';
import { GET as sales } from '../../app/api/sales-meeting/route';
import { GET as source } from '../../app/api/source-data/route';
import { GET as settings } from '../../app/api/settings/route';
import { dataset } from '../demo/data';
import { prepareDemo, startRun } from '../demo/run-control';
import { state } from '../demo/store';
import { preparePostgresWebDatabase } from './prepare-web';
import { closePostgresWebClient, materializePostgresSnapshot, postgresWebClient, readPostgresDataset } from './web';
import { PURPOSE_KEY, WEB_PURPOSE } from './target';

async function query(handler: typeof fg, params: Record<string, string> = {}) {
  const response = await handler(new NextRequest(`http://127.0.0.1:3142/api/report?${new URLSearchParams({ runId: '3', ...params })}`));
  return { response, body: await response.json() };
}
async function main() {
  const checks: string[] = [];
  try {
    await preparePostgresWebDatabase(process.env.MRP_DEMO_POSTGRES_URL);
    await prepareDemo();
    const [first, concurrent] = await Promise.all([readPostgresDataset(3), readPostgresDataset(3)]);
    assert.equal(first.fg.length, 72); assert.equal(concurrent.fg.length, 72);
    const other = await readPostgresDataset(1);
    assert.ok(other.fg.every(row => row.mrpRunId === 1), 'POSTGRES_WEB_RUN_SCOPE');
    assert.ok((await readPostgresDataset(3)).fg.every(row => row.mrpRunId === 3), 'POSTGRES_WEB_RUN_SCOPE');
    const client = await postgresWebClient();
    assert.equal(await client.fgMonthly.count({ where: { mrpRunId: 3 } }), 72);
    checks.push('concurrent-first-materialization-is-atomic-and-two-Runs-do-not-mix');

    for (const [handler, params, count] of [[fg, {}, 48], [cw, { mrpType: 'B' }, 12], [sales, {}, 48], [source, { table: 'part_versions' }, 48]] as const) {
      const result = await query(handler, params);
      assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('X-MRP-Storage'), 'postgresql');
      assert.equal(result.body.total, count); assert.ok(result.body.items.every((row: { mrpRunId: number }) => row.mrpRunId === 3));
    }
    const partVersion = String(dataset(3).fg.find(row => !row.isAggregated)!.partVersion);
    const memory = Number(dataset(3).fg.find(row => row.partVersion === partVersion && !row.isAggregated)!.currentStockPc);
    await client.fgMonthly.updateMany({ where: { mrpRunId: 3, partVersion, isAggregated: false }, data: { currentStockPc: 777777 } });
    const actual = await query(fg, { partVersionsIn: partVersion });
    assert.equal(actual.body.items[0].currentStockPc, 777777, 'POSTGRES_WEB_SQL_READ_ORACLE');
    assert.equal(Number(dataset(3).fg.find(row => row.partVersion === partVersion && !row.isAggregated)!.currentStockPc), memory);
    await client.fgMonthly.updateMany({ where: { mrpRunId: 3, partVersion, isAggregated: false }, data: { currentStockPc: memory } });
    assert.equal((await query(settings)).body.storage, 'postgresql');
    checks.push('real-API-entrypoints-read-SQL-canary-not-memory-with-source-provenance');

    const changed = structuredClone(dataset(3)); changed.fg[0].currentStockPc = 111;
    await assert.rejects(materializePostgresSnapshot(client, changed), /POSTGRES_WEB_SNAPSHOT_CONFLICT/);
    assert.equal(await client.fgMonthly.count({ where: { mrpRunId: 3 } }), 72);
    const invalid = structuredClone(dataset(3)); invalid.run.id = 99; invalid.run.versionCode = 'DEMO-ROLLBACK-WEB';
    for (const rows of [invalid.fg, invalid.cw, invalid.sales, ...Object.values(invalid.fgPeriods), ...Object.values(invalid.cwPeriods), ...Object.values(invalid.salesPeriods), ...Object.values(invalid.source)]) for (const row of rows) row.mrpRunId = 99;
    invalid.fg.push(structuredClone(invalid.fg[0]));
    await assert.rejects(materializePostgresSnapshot(client, invalid), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    assert.equal(await client.mrpRun.count({ where: { id: 99 } }), 0, 'POSTGRES_WEB_ATOMIC_IMPORT');
    assert.equal(await client.stagingPartVersion.count({ where: { mrpRunId: 99 } }), 0, 'POSTGRES_WEB_ATOMIC_IMPORT');
    checks.push('snapshot-conflict-refuses-overwrite-and-partial-import-rolls-back');

    const next = startRun();
    const deadline = Date.now() + 10000;
    while (state().runs.find(run => run.id === next.id)?.status === 'calculating' && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 50));
    assert.equal(state().runs.find(run => run.id === next.id)?.status, 'completed');
    const nextReport = await query(fg, { runId: String(next.id) });
    assert.equal(nextReport.response.status, 200); assert.equal(nextReport.response.headers.get('X-MRP-Storage'), 'postgresql');
    assert.ok(nextReport.body.items.every((row: { mrpRunId: number }) => row.mrpRunId === next.id), 'POSTGRES_WEB_RUN_SCOPE');
    checks.push('original-local-MRP-lifecycle-publishes-next-completed-Run-to-SQL-reports');

    await client.appSetting.update({ where: { key: PURPOSE_KEY }, data: { value: 'wrong-purpose' } });
    try {
      await assert.rejects(preparePostgresWebDatabase(process.env.MRP_DEMO_POSTGRES_URL), /POSTGRES_WEB_PURPOSE_REQUIRED/);
      const rejected = await query(fg); assert.notEqual(rejected.response.status, 200);
      assert.match(rejected.body.error, /POSTGRES_WEB_PURPOSE_REQUIRED/);
    } finally { await client.appSetting.update({ where: { key: PURPOSE_KEY }, data: { value: WEB_PURPOSE } }); }
    checks.push('startup-and-report-path-both-refuse-wrong-purpose-existing-database');

    const saved = process.env.MRP_DEMO_POSTGRES_URL;
    await closePostgresWebClient();
    try {
      const broken = new URL(saved!); broken.port = '1'; process.env.MRP_DEMO_POSTGRES_URL = broken.toString();
      const failed = await query(fg); assert.notEqual(failed.response.status, 200, 'POSTGRES_WEB_NO_MEMORY_FALLBACK');
      assert.equal(failed.body.items, undefined);
    } finally { await closePostgresWebClient(); process.env.MRP_DEMO_POSTGRES_URL = saved; }
    assert.equal((await query(fg)).response.status, 200);
    checks.push('unavailable-database-never-falls-back-to-memory-and-new-client-recovers');
    const result = { status: 'passed', synthetic: true, node: process.version, platform: process.platform, checks };
    mkdirSync(join(process.cwd(), 'release'), { recursive: true }); writeFileSync(join(process.cwd(), 'release/postgres-web.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally { await closePostgresWebClient(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '[synthetic demo target]') : 'PostgreSQL web verification failed'); process.exitCode = 1; });
