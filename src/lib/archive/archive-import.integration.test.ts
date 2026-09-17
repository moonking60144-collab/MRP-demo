import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PrismaClient as LivePrismaClient } from '@prisma/client';
import { Prisma, PrismaClient } from '.prisma/archive-client';
import { openArchiveReader } from '../archive-db';
import { ARCHIVE_RUN_TABLES } from './coverage';
import { importArchiveRun } from './import-run';
import { restoreArchiveSeed } from './restore-seed';
import { columnsFor, quotedTable, RESTORE_LOCK, type SourceColumn } from './snapshot-data';
import { listArchiveRuns, readArchiveRun, readArchiveRows, readArchiveFgReport, readArchiveWeeklyReport } from './browser-query';
import { backupAndVerifyArchive, captureArchiveFingerprint } from './backup';
import { rotateArchiveBackups } from './backup-rotation';
import { withArchiveWorkspace } from './workspace';
import { runAndPersistArchiveAutomation, runArchiveAutomation, type ArchiveAutomationConfig } from './automation';
import {
  archiveRetentionGate,
  archiveRetentionPreflight,
} from './archive-retention-gate';
import { deleteCompletedRunForRetention } from '../mrp/run-retention';
import { runSnapshotLockIdentity } from '../mrp/run-snapshot-lock';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
const quantity = '9007199254740993.123456789012345678901234567890';

function fixtureValue(column: SourceColumn) {
  if (column.name === 'id') return 'n';
  if (column.name === 'mrp_run_id') return 'r';
  if (column.name === 'is_aggregated') return '(n % 2 = 1)';
  if (column.name === 'period_index') return '((n - (r * 1000 + 1)) / 2)';
  if (column.name === 'week_index') return '(n - (r * 1000 + 1))';
  if (column.name === 'mrp_type') return "'W'";
  if (column.name === 'status') return "'completed'";
  if (column.name === 'order_demand_contract_version') return "'order-demand-v1'";
  const value = column.type === 'integer' ? '1' : column.type === 'text' ? "'fixture'" :
    column.type === 'date' ? "DATE '2026-07-28'" : column.type === 'boolean' ? 'true' :
    column.type === 'timestamp with time zone' ? "TIMESTAMPTZ '2026-07-28 01:02:03.123456+08'" :
    column.type === 'jsonb' ? "'{\"large\":9007199254740993,\"nested\":[null,\"測試\"]}'::jsonb" :
    column.type === 'text[]' ? "ARRAY['A', 'B', NULL]::text[]" :
    column.type.startsWith('numeric') ? `${quantity}::numeric` : null;
  assert.ok(value, `Unsupported fixture type: ${column.type}`);
  return column.notNull ? value : `CASE WHEN n % 2 = 0 THEN NULL ELSE ${value} END`;
}

test('isolated PostgreSQL: real G1/G4 restore, import, precision, rollback and reentry', {
  skip: !process.env.ARCHIVE_IMPORT_TEST_PORT_BASE,
}, async t => {
  const portBase = Number(process.env.ARCHIVE_IMPORT_TEST_PORT_BASE);
  assert.ok(Number.isInteger(portBase) && portBase >= 10000 && portBase < 65534);
  for (const [index, generation] of (['G1', 'G4'] as const).entries()) await t.test(generation, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-import-test-'));
    const data = path.join(directory, 'data');
    const port = portBase + index;
    const adminUrl = `postgresql://archive_test_admin@127.0.0.1:${port}/funda_mrp_archive`;
    const restoreAdminUrl = adminUrl.replace('/funda_mrp_archive', '/funda_mrp_restore_tmp');
    const envKeys = ['ARCHIVE_DATABASE_URL', 'ARCHIVE_LOADER_DATABASE_URL', 'ARCHIVE_RESTORE_DATABASE_URL', 'ARCHIVE_AUTO_RESTORE_DATABASE_URL', 'ARCHIVE_VERIFY_DATABASE_URL',
      'MRP_RUN_ARCHIVE_GATE_ENABLED', 'MRP_RUN_ARCHIVE_SOURCE_INSTANCE',
      'MRP_RUN_ARCHIVE_SOURCE_DB_MODE'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const clients: PrismaClient[] = [];
    let started = false;
    const db = (url: string) => { const client = new PrismaClient({ datasourceUrl: url }); clients.push(client); return client; };
    const psql = (url: string, args: string[]) => execFileSync('psql', ['-X', '--set=ON_ERROR_STOP=1', '--dbname', url, ...args], { encoding: 'utf8' });
    const cli = (script: string, args: string[]) => JSON.parse(execFileSync(process.execPath,
      ['--import', 'tsx', `scripts/${script}.ts`, ...args], { cwd, encoding: 'utf8', env: process.env }));
    try {
      execFileSync('initdb', ['-D', data, '-U', 'archive_test_admin', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      execFileSync('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
      started = true;
      for (const name of ['funda_mrp_archive', 'funda_mrp_restore_tmp', 'archive_fixture']) {
        psql(adminUrl.replace('/funda_mrp_archive', '/postgres'), ['-c', `CREATE DATABASE ${name}`]);
      }
      psql(adminUrl, ['-f', path.join(cwd, 'prisma/archive-init.sql')]);
      psql(adminUrl, ['-f', path.join(cwd, 'prisma/archive-roles.sql')]);
      psql(restoreAdminUrl, ['-f', path.join(cwd, 'prisma/archive-restore-init.sql')]);
      process.env.ARCHIVE_LOADER_DATABASE_URL = adminUrl.replace('archive_test_admin', 'archive_loader');
      process.env.ARCHIVE_DATABASE_URL = adminUrl.replace('archive_test_admin', 'archive_reader');
      process.env.ARCHIVE_RESTORE_DATABASE_URL = restoreAdminUrl.replace('archive_test_admin', 'archive_loader');
      const admin = db(adminUrl);
      const restored = db(restoreAdminUrl);
      const loader = db(process.env.ARCHIVE_LOADER_DATABASE_URL);
      const sourceUrl = adminUrl.replace('/funda_mrp_archive', '/archive_fixture');
      const source = db(sourceUrl);
      await source.$executeRawUnsafe('CREATE SCHEMA staging');
      await source.$executeRawUnsafe('CREATE SCHEMA mrp_out');
      for (const table of ARCHIVE_RUN_TABLES) {
        const columns = columnsFor(generation, table);
        if (!columns) continue;
        await source.$executeRawUnsafe(`CREATE TABLE ${quotedTable(table)} (${columns.map(column =>
          `"${column.name}" ${column.type}${column.notNull ? ' NOT NULL' : ''}`).join(', ')}, PRIMARY KEY (id))`);
        await source.$executeRawUnsafe(`INSERT INTO ${quotedTable(table)} SELECT ${columns.map(fixtureValue).join(', ')}
          FROM unnest(ARRAY[18,220,221,222]) r CROSS JOIN LATERAL
          generate_series(${table === 'public.mrp_run' ? 'r, r' : table === 'staging.inventory' ? 'r * 1000 + 1, r * 1000 + 501' : table === 'mrp_out.fg_monthly_periods' ? 'r * 1000 + 1, r * 1000 + 120' : ['mrp_out.component_weekly_periods', 'mrp_out.sales_meeting_periods'].includes(table) ? 'r * 1000 + 1, r * 1000 + 60' : 'r * 1000 + 1, r * 1000 + 2'}) n
          ${table === 'staging.forecasts' ? 'WHERE r <> 222' : ''}`);
      }
      const dumpPath = path.join(directory, `${generation}.dump`);
      execFileSync('pg_dump', ['--format=custom', '--file', dumpPath, '--dbname', sourceUrl]);
      const sha256 = createHash('sha256').update(await readFile(dumpPath)).digest('hex');
      await writeFile(path.join(directory, `${generation}.sha256`), `${sha256}  ${generation}.dump\n`);
      await writeFile(path.join(directory, `${generation}.archive.json`), JSON.stringify({
        manifestVersion: 1, kind: 'funda-mrp-archive-seed', seedFileName: `${generation}.dump`, sourceFileName: 'fixture.dump',
        schemaGeneration: generation, sha256, sizeBytes: (await stat(dumpPath)).size, createdAt: new Date().toISOString(),
        runCoverage: { count: 4, minRunId: 18, maxRunId: 222, runIds: [18, 220, 221, 222] },
      }));
      assert.equal(cli('archive-restore', ['--execute', '--dump', dumpPath, '--source-instance', 'fixture-server']).outcome, 'restored');
      assert.equal((await restoreArchiveSeed(dumpPath, 'fixture-server')).outcome, 'already-restored');
      const imported = cli('archive-import', ['--execute', '--run-id', '18']);
      assert.equal(imported.outcome, 'imported');
      assert.equal(imported.tablesVerified, 18);
      assert.equal((await importArchiveRun(18)).outcome, 'already-imported');
      const coverage = await admin.archiveRunCoverage.findUniqueOrThrow({ where: { id: imported.archiveRunId }, include: { tables: true } });
      assert.equal(coverage.status, 'verified');
      assert.equal(coverage.orderDemandContractVersion, 'order-demand-v1');
      assert.equal(coverage.tables.length, 18);
      process.env.MRP_RUN_ARCHIVE_GATE_ENABLED = 'true';
      process.env.MRP_RUN_ARCHIVE_SOURCE_INSTANCE = 'fixture-server';
      process.env.MRP_RUN_ARCHIVE_SOURCE_DB_MODE = 'local';
      assert.deepEqual(await source.$transaction(
        tx => archiveRetentionGate(18, tx),
        { timeout: 120_000 },
      ), {
        allowed: true, runId: 18, verifiedAt: coverage.verifiedAt!.toISOString(),
      }, 'REAL_READER_AND_LIVE_DIGEST_ALLOW_EXACT_RUN');
      await source.$transaction(async tx => {
        await tx.$executeRawUnsafe('SAVEPOINT archive_gate_drift');
        await tx.$executeRawUnsafe('DELETE FROM staging.inventory WHERE mrp_run_id = $1 AND id = $2', 18, 18001);
        assert.deepEqual(await archiveRetentionGate(18, tx), {
          allowed: false, runId: 18, reason: 'live-snapshot-mismatch',
        }, 'LIVE_DRIFT_DENIES_EXACT_RUN');
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT archive_gate_drift');
      }, { timeout: 120_000 });
      if (generation === 'G1') {
        await source.$transaction(async tx => {
          await tx.$executeRawUnsafe('SAVEPOINT archive_gate_added_column');
          await tx.$executeRawUnsafe('ALTER TABLE staging.inventory ADD COLUMN item_status text');
          await tx.$executeRawUnsafe(
            'UPDATE staging.inventory SET item_status = $1 WHERE mrp_run_id = $2 AND id = $3',
            'unarchived-live-value', 18, 18001,
          );
          assert.deepEqual(await archiveRetentionGate(18, tx), {
            allowed: false, runId: 18, reason: 'live-snapshot-mismatch',
          }, 'G1_ARCHIVE_MUST_NOT_HIDE_LIVE_G4_COLUMN_VALUE');
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT archive_gate_added_column');
        }, { timeout: 120_000 });
        await source.$transaction(async tx => {
          await tx.$executeRawUnsafe('SAVEPOINT archive_gate_migration_defaults');
          await tx.$executeRawUnsafe(`
            ALTER TABLE staging.work_order_bom
              ADD COLUMN movement_detail_count integer NOT NULL DEFAULT 0,
              ADD COLUMN movement_state text NOT NULL DEFAULT 'fallback'
          `);
          assert.deepEqual(await archiveRetentionGate(18, tx), {
            allowed: true, runId: 18, verifiedAt: coverage.verifiedAt!.toISOString(),
          }, 'G1_SAFE_SCHEMA_MIGRATION_DEFAULTS_REMAIN_DELETABLE');
          await tx.$executeRawUnsafe(`
            UPDATE staging.work_order_bom
            SET movement_state = 'recalculated'
            WHERE mrp_run_id = $1 AND id = $2
          `, 18, 18001);
          assert.deepEqual(await archiveRetentionGate(18, tx), {
            allowed: false, runId: 18, reason: 'live-snapshot-mismatch',
          }, 'G1_NON_DEFAULT_MIGRATED_VALUE_MUST_BE_REJECTED');
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT archive_gate_migration_defaults');
        }, { timeout: 120_000 });
      }
      assert.deepEqual(await archiveRetentionPreflight(220), {
        allowed: false, runId: 220, reason: 'coverage-missing',
      }, 'REAL_READER_MISSING_COVERAGE_DENIES_RUN');
      const validReaderUrl = process.env.ARCHIVE_DATABASE_URL;
      process.env.ARCHIVE_DATABASE_URL = adminUrl.replace('archive_test_admin', 'archive_reader')
        .replace(`:${port}/`, `:${port + 10}/`) + '?connect_timeout=1';
      assert.deepEqual(await archiveRetentionPreflight(18), {
        allowed: false, runId: 18, reason: 'archive-unreachable',
      }, 'REAL_READER_OUTAGE_DENIES_RUN');
      process.env.ARCHIVE_DATABASE_URL = validReaderUrl;
      const browserRuns = await listArchiveRuns(new URLSearchParams());
      assert.equal(browserRuns.total, 1);
      assert.equal(browserRuns.runs[0].id, imported.archiveRunId);
      assert.ok(!('sourceRun' in browserRuns.runs[0]));
      assert.deepEqual(await readArchiveRun(imported.archiveRunId), browserRuns.runs[0]);
      for (const aggregated of ['false', 'true']) {
        const report = await readArchiveFgReport(imported.archiveRunId, new URLSearchParams({ aggregated }));
        assert.equal(report.rows.length, 1);
        assert.equal(report.periods.length, 60, 'FG_PERIODS_MUST_NOT_USE_GENERIC_50_ROW_PAGE');
        assert.equal(report.rows[0].is_aggregated, aggregated);
        assert.ok(report.periods.every(row => row.is_aggregated === aggregated && row.mrp_run_id === '18' && row.part_version === report.rows[0].part_version));
        assert.deepEqual(report.periods.map(row => Number(row.period_index)), Array.from({ length: 60 }, (_, i) => i));
        assert.equal(report.rows[0].current_stock_pc, quantity);
        assert.ok(!('editing_by' in report.rows[0]));
        assert.equal(report.warehouseAvailable, false);
      }
      assert.equal((await readArchiveFgReport(imported.archiveRunId, new URLSearchParams({ page: '2' }))).periods.length, 0);
      assert.equal((await readArchiveFgReport(imported.archiveRunId, new URLSearchParams({ q: "' OR true --" }))).total, 0);
      assert.equal((await readArchiveFgReport(imported.archiveRunId, new URLSearchParams({ shortage: 'true' }))).total, 1);
      await assert.rejects(readArchiveFgReport(imported.archiveRunId, new URLSearchParams({ sort: 'constructor' })), /無效/);
      for (const kind of ['component', 'sales']) {
        const report = await readArchiveWeeklyReport(imported.archiveRunId, new URLSearchParams({ kind, mrpType: 'W' }));
        assert.equal(report.rows.length, 2);
        assert.equal(report.periods.length, 60, 'WEEKLY_PERIODS_NOT_TRUNCATED_TO_50');
        assert.deepEqual(report.periods.map(row => Number(row.week_index)), Array.from({ length: 60 }, (_, i) => i));
        assert.ok(report.periods.every(row => row.mrp_run_id === '18'));
        assert.equal(report.rows[0].good_stock_pc, quantity);
        if (kind === 'component') {
          assert.ok(report.periods.every(row => row.mrp_type === 'W'));
          assert.equal(report.missingFields.includes('purchaseAction'), generation === 'G1');
          if (generation === 'G1') assert.ok(report.rows.every(row => row.purchase_action === null));
        }
        assert.equal((await readArchiveWeeklyReport(imported.archiveRunId, new URLSearchParams({ kind, q: "' OR true --" }))).total, 0);
      }
      assert.equal((await readArchiveWeeklyReport(imported.archiveRunId, new URLSearchParams({ mrpType: 'D' }))).total, 0);
      await assert.rejects(readArchiveWeeklyReport(imported.archiveRunId, new URLSearchParams({ sort: 'constructor' })), /無效/);
      const inventoryPage = await readArchiveRows(imported.archiveRunId, 'inventory', new URLSearchParams({ page: '2' }));
      assert.equal(inventoryPage.total, 501);
      assert.equal(inventoryPage.rows.length, 50);
      assert.equal(inventoryPage.rows[0].id, '18051');
      assert.equal(inventoryPage.rows[0].good_stock_pc, quantity);
      for (const view of ['fg-monthly', 'fg-periods']) {
        const fg = await readArchiveRows(imported.archiveRunId, view, new URLSearchParams());
        assert.equal(fg.columns.find(column => column.key === 'is_aggregated')?.type, 'boolean');
        assert.deepEqual(new Set(fg.rows.map(row => row.is_aggregated)), new Set(['true', 'false']));
      }
      const missingPage = await readArchiveRows(imported.archiveRunId, 'movements', new URLSearchParams());
      assert.equal(missingPage.sourcePresent, generation !== 'G1');
      const weeklyPage = await readArchiveRows(imported.archiveRunId, 'component-weekly', new URLSearchParams());
      assert.equal(weeklyPage.columns.find(column => column.key === 'shortage_qty')!.missing, generation === 'G1');
      if (generation === 'G1') assert.ok(weeklyPage.rows.every(row => row.shortage_qty === null));
      for (const q of ["' OR true --", '%', '_', '\\']) {
        assert.equal((await readArchiveRows(imported.archiveRunId, 'inventory', new URLSearchParams({ q }))).total, 0);
      }
      await assert.rejects(readArchiveRows('00000000-0000-0000-0000-000000000000', 'inventory', new URLSearchParams()), /找不到/);
      const [precision] = await admin.$queryRawUnsafe<Array<{ qty: string; timestamp: string }>>(
        `SELECT good_stock_pc::text AS qty, (SELECT created_at::text FROM archive_data.public_mrp_run WHERE archive_run_id = $1::uuid) AS timestamp
         FROM archive_data.staging_inventory WHERE archive_run_id = $1::uuid ORDER BY id LIMIT 1`, imported.archiveRunId);
      assert.equal(precision.qty, quantity);
      assert.match(precision.timestamp, /123456/);
      assert.equal(coverage.tables.find(row => row.tableName === 'staging.inventory')!.archiveRows, BigInt(501));
      assert.equal(coverage.tables.find(row => row.tableName === 'staging.work_order_material_movements')!.status,
        generation === 'G1' ? 'not-in-source' : 'verified');
      if (generation === 'G1') {
        const [row] = await admin.$queryRawUnsafe<Array<{ value: unknown }>>(
          'SELECT purchase_lead_weeks_configured AS value FROM archive_data.staging_inventory WHERE archive_run_id = $1::uuid LIMIT 1', imported.archiveRunId);
        assert.equal(row.value, null);
      }

      // A failure in the final table happens after earlier snapshots and evidence were inserted.
      await restored.$executeRawUnsafe("UPDATE mrp_out.sales_meeting_periods SET part_version = 'tampered' WHERE mrp_run_id = 220");
      await assert.rejects(importArchiveRun(220), /Restored snapshot changed: mrp_out.sales_meeting_periods/, 'RESTORE_RECEIPT_MUST_MATCH');
      assert.equal(await admin.archiveRunCoverage.count({ where: { sourceRunId: 220 } }), 0);
      for (const table of ARCHIVE_RUN_TABLES) {
        const [count] = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM ${quotedTable(table, true)} WHERE ${table === 'public.mrp_run' ? 'id' : 'mrp_run_id'} = 220`);
        assert.equal(count.count, BigInt(0), `No partial snapshot in ${table}`);
      }
      assert.equal(await admin.archiveImportAttempt.count({ where: { sourceRunId: 220, status: 'failed' } }), 1);
      await restored.$executeRawUnsafe("UPDATE mrp_out.sales_meeting_periods SET part_version = 'fixture' WHERE mrp_run_id = 220");
      await admin.archiveImportAttempt.create({ data: { sourceSha256: sha256, sourceRunId: 220, status: 'importing', importerVersion: 'interrupted-test' } });
      assert.equal((await importArchiveRun(220)).outcome, 'imported');
      assert.equal(await admin.archiveImportAttempt.count({ where: { sourceRunId: 220, status: 'interrupted' } }), 1);

      await restored.$executeRawUnsafe('UPDATE staging.inventory SET good_stock_pc = good_stock_pc + 1 WHERE mrp_run_id = 18');
      await assert.rejects(importArchiveRun(18), /Restored snapshot changed/);
      await assert.rejects(restoreArchiveSeed(dumpPath, 'fixture-server'), /Staging no longer matches/);
      assert.deepEqual(await admin.archiveRunCoverage.findUniqueOrThrow({ where: { id: coverage.id }, include: { tables: true } }), coverage);
      await restored.$executeRawUnsafe('UPDATE staging.inventory SET good_stock_pc = good_stock_pc - 1 WHERE mrp_run_id = 18');
      assert.equal((await importArchiveRun(18)).outcome, 'already-imported');

      await admin.$executeRawUnsafe('UPDATE archive_data.staging_inventory SET good_stock_pc = good_stock_pc + 1 WHERE mrp_run_id = 18');
      await assert.rejects(importArchiveRun(18), /Archive snapshot verification failed/);
      await admin.$executeRawUnsafe('UPDATE archive_data.staging_inventory SET good_stock_pc = good_stock_pc - 1 WHERE mrp_run_id = 18');
      const originalSource = await admin.archiveSource.findUniqueOrThrow({ where: { sha256 } });
      const otherSha = 'b'.repeat(64);
      await admin.archiveSource.create({ data: { ...originalSource, sha256: otherSha, manifest: originalSource.manifest as Prisma.InputJsonValue } });
      await admin.archiveSourceRun.create({ data: { sourceSha256: otherSha, sourceInstance: 'fixture-server', sourceRunId: 18 } });
      await restored.$executeRawUnsafe('UPDATE archive_restore.receipt SET source_sha256 = $1', otherSha);
      await assert.rejects(importArchiveRun(18), /already pinned/);
      await restored.$executeRawUnsafe('UPDATE archive_restore.receipt SET source_sha256 = $1', sha256);
      await restored.$transaction(async tx => {
        const [lock] = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>('SELECT pg_try_advisory_xact_lock($1) AS acquired', RESTORE_LOCK);
        assert.equal(lock.acquired, true);
        await assert.rejects(importArchiveRun(221), /staging is busy/);
      });

      // Throw after the actual Archive COMMIT, before its caller receives the result.
      const originalTransaction = PrismaClient.prototype.$transaction;
      let lostCommitResponse = false;
      const transactionMock = t.mock.method(PrismaClient.prototype, '$transaction', async function (
        this: PrismaClient, ...args: Parameters<typeof originalTransaction>
      ) {
        const result = await originalTransaction.apply(this, args);
        if (!lostCommitResponse && result && typeof result === 'object' &&
            'outcome' in result && result.outcome === 'imported' && 'sourceRunId' in result && result.sourceRunId === 221) {
          lostCommitResponse = true;
          throw new Error('injected lost COMMIT response');
        }
        return result;
      });
      try {
        await assert.rejects(importArchiveRun(221), /injected lost COMMIT response/);
      } finally {
        transactionMock.mock.restore();
      }
      assert.equal(lostCommitResponse, true);
      assert.equal(await admin.archiveImportAttempt.count({ where: { sourceRunId: 221, status: 'verified' } }), 1, 'COMMIT_SUCCESS_CANNOT_DOWNGRADE');
      assert.equal(await admin.archiveImportAttempt.count({ where: { sourceRunId: 221, status: 'failed' } }), 0);
      assert.equal((await importArchiveRun(221)).outcome, 'already-imported');
      const empty = await importArchiveRun(222);
      const emptyEvidence = await admin.archiveTableVerification.findFirstOrThrow({ where: { archiveRunId: empty.archiveRunId, tableName: 'staging.forecasts' } });
      assert.equal(emptyEvidence.status, 'verified');
      assert.equal(emptyEvidence.sourcePresent, true);
      assert.equal(emptyEvidence.sourceRows, BigInt(0));
      await assert.rejects(importArchiveRun(999), /No verified restore receipt/);
      await restored.$executeRawUnsafe('ALTER TABLE staging.inventory ADD COLUMN unknown_column text');
      await assert.rejects(importArchiveRun(222), /schema/i);

      for (const sql of [
        'UPDATE archive_data.staging_inventory SET good_stock_pc = 0 WHERE false',
        'DELETE FROM archive_data.staging_inventory WHERE false',
        'UPDATE archive_meta.archive_table_verification SET source_rows = 0 WHERE false',
        `UPDATE archive_meta.archive_run_coverage SET status = 'failed' WHERE id = '${coverage.id}'`,
        `INSERT INTO archive_data.staging_inventory (archive_run_id, id, mrp_run_id) VALUES ('${coverage.id}', -1, 18)`,
      ]) await assert.rejects(loader.$executeRawUnsafe(sql), /permission denied|immutable|open import/i);
      const reader = await openArchiveReader();
      clients.push(reader);
      assert.ok((await reader.$queryRawUnsafe<unknown[]>('SELECT * FROM archive_data.staging_inventory LIMIT 1')).length);
      await reader.$executeRawUnsafe('SET default_transaction_read_only = off');
      await assert.rejects(reader.$executeRawUnsafe('UPDATE archive_data.staging_inventory SET good_stock_pc = 0 WHERE false'), /permission denied/i);
      if (generation === 'G4') {
        const metadataEnv: NodeJS.ProcessEnv = { ...process.env, ARCHIVE_TEST_ADMIN_URL: adminUrl };
        delete metadataEnv.NODE_TEST_CONTEXT;
        const metadata = execFileSync(process.execPath, ['--import', 'tsx', '--test', 'src/lib/archive/archive-metadata.integration.test.ts'], {
          cwd, encoding: 'utf8', env: metadataEnv,
        });
        assert.match(metadata, /(?:pass 1|# pass 1)/);
      }
      psql(adminUrl.replace('/funda_mrp_archive', '/postgres'), ['-c', 'CREATE DATABASE funda_mrp_archive_auto_tmp']);
      const autoUrl = adminUrl.replace('/funda_mrp_archive', '/funda_mrp_archive_auto_tmp');
      psql(autoUrl, ['-f', path.join(cwd, 'prisma/archive-workspace-init.sql')]);
      process.env.ARCHIVE_AUTO_RESTORE_DATABASE_URL = autoUrl.replace('archive_test_admin', 'archive_loader');
      await source.$executeRawUnsafe(`INSERT INTO public.mrp_run
        SELECT (jsonb_populate_record(NULL::public.mrp_run, to_jsonb(t) || '{"id":223}'::jsonb)).*
        FROM public.mrp_run t WHERE id = 222`);
      const batchDump = path.join(directory, `${generation}-batch.dump`);
      execFileSync('pg_dump', ['--format=custom', '--file', batchDump, '--dbname', sourceUrl]);
      const batchSha = createHash('sha256').update(await readFile(batchDump)).digest('hex');
      await writeFile(batchDump.replace('.dump', '.sha256'), `${batchSha}  ${generation}-batch.dump\n`);
      await writeFile(batchDump.replace('.dump', '.archive.json'), JSON.stringify({
        manifestVersion: 1, kind: 'funda-mrp-archive-seed', seedFileName: `${generation}-batch.dump`, sourceFileName: 'fixture.dump',
        schemaGeneration: generation, sha256: batchSha, sizeBytes: (await stat(batchDump)).size, createdAt: new Date().toISOString(),
        runCoverage: { count: 5, minRunId: 18, maxRunId: 223, runIds: [18, 220, 221, 222, 223] },
      }));
      const batchArgs = ['--execute', '--dump', batchDump, '--sha256', batchSha, '--source-instance', 'fixture-server', '--min-run-id', '223'];
      assert.deepEqual(cli('archive-import-batch', batchArgs).imported, [223], 'ONLY_UNCOVERED_SELECTED_RUN_IMPORTED');
      assert.equal(cli('archive-import-batch', batchArgs).outcome, 'nothing-to-import');
      assert.equal((await admin.archiveRunCoverage.findUniqueOrThrow({ where: { id: coverage.id } })).sourceSha256, sha256, 'OLD_SEED_NOT_REPLACED');
      assert.equal((await restored.$queryRawUnsafe<Array<{ count: string }>>(`SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='staging' AND table_name='inventory' AND column_name='unknown_column'`))[0].count, '1', 'G1_STAGING_UNTOUCHED');
      await admin.archiveSourceRun.create({ data: { sourceSha256: sha256, sourceRunId: 999, sourceInstance: 'fixture-server' } });
      const pendingAttempt = await admin.archiveImportAttempt.create({ data: { sourceSha256: sha256, sourceRunId: 999, importerVersion: 'query-fixture' } });
      psql(adminUrl.replace('/funda_mrp_archive', '/postgres'), ['-c', 'CREATE DATABASE funda_mrp_archive_verify_tmp']);
      const verifyUrl = adminUrl.replace('/funda_mrp_archive', '/funda_mrp_archive_verify_tmp');
      psql(verifyUrl, ['-f', path.join(cwd, 'prisma/archive-workspace-init.sql')]);
      process.env.ARCHIVE_VERIFY_DATABASE_URL = verifyUrl.replace('archive_test_admin', 'archive_loader');
      await source.$executeRawUnsafe(`INSERT INTO public.mrp_run
        SELECT (jsonb_populate_record(NULL::public.mrp_run, to_jsonb(t) || '{"id":224}'::jsonb)).*
        FROM public.mrp_run t WHERE id = 223`);
      await source.$executeRawUnsafe(`INSERT INTO public.mrp_run
        SELECT (jsonb_populate_record(NULL::public.mrp_run, to_jsonb(t) || '{"id":225,"status":"stopped"}'::jsonb)).*
        FROM public.mrp_run t WHERE id = 224`);
      const productionDirectory = path.join(directory, 'production-backups');
      const seedDirectory = path.join(directory, 'permanent-seeds');
      const scheduledBackupDirectory = path.join(await realpath(directory), 'scheduled-archive-backups');
      const stateDirectory = path.join(directory, 'automation-state');
      await mkdir(productionDirectory);
      const productionName = 'funda_mrp_auto_20260908_050000_000.dump';
      const productionDump = path.join(productionDirectory, productionName);
      execFileSync('pg_dump', ['--format=custom', '--file', productionDump, '--dbname', sourceUrl]);
      const productionSha = createHash('sha256').update(await readFile(productionDump)).digest('hex').toUpperCase();
      const productionStat = await stat(productionDump);
      await writeFile(`${productionDump}.sha256`, `${productionSha}  ${productionName}\n`);
      const productionCompletedAt = new Date();
      await writeFile(`${productionDump}.json`, JSON.stringify({ fileName: productionName, sizeBytes: productionStat.size,
        sha256: productionSha, startedAt: new Date(productionCompletedAt.getTime() - 60_000).toISOString(),
        completedAt: productionCompletedAt.toISOString(), durationMs: 60000 }));
      const automationConfig: ArchiveAutomationConfig = { enabled: true, sourceInstance: 'fixture-server', minimumRunId: 224,
        productionBackupDirectory: productionDirectory, seedDirectory, archiveBackupDirectory: scheduledBackupDirectory,
        stateDirectory, databaseDataDirectory: data, maximumSourceAgeHours: 30, backupIntervalHours: 24, minimumFreeBytes: BigInt(1),
        backupRotationEnabled: true };
      const baselineBackup = await backupAndVerifyArchive(scheduledBackupDirectory);
      for (let index = 0; index < 3; index++) {
        const target = path.join(scheduledBackupDirectory, `archive-aged0${index}`);
        await cp(baselineBackup.jobDirectory, target, { recursive: true });
        for (const file of ['manifest.json', 'verified.json']) {
          const value = JSON.parse(await readFile(path.join(target, file), 'utf8'));
          const timestamp = new Date(Date.now() - (40 - index) * 86_400_000).toISOString();
          if (file === 'manifest.json') value.createdAt = timestamp; else value.verifiedAt = timestamp;
          await writeFile(path.join(target, file), JSON.stringify(value));
        }
      }
      const baselineReceiptPath = path.join(baselineBackup.jobDirectory, 'verified.json');
      const baselineReceipt = await readFile(baselineReceiptPath, 'utf8');
      await writeFile(baselineReceiptPath, JSON.stringify({ ...JSON.parse(baselineReceipt),
        verifiedAt: new Date(Date.now() + 86_400_000).toISOString() }));
      await assert.rejects(rotateArchiveBackups(scheduledBackupDirectory), /timestamp is in the future/,
        'GENUINE_FUTURE_BACKUP_MUST_STILL_BE_REJECTED');
      await writeFile(baselineReceiptPath, baselineReceipt);
      const automated = await runAndPersistArchiveAutomation(automationConfig);
      assert.equal(automated.rotation?.outcome, 'rotated', 'NEW_BACKUP_AND_ROTATION_MUST_COMPLETE_IN_ONE_CYCLE');
      assert.equal(existsSync(path.join(scheduledBackupDirectory, 'archive-aged00', 'archive.dump')), false);
      assert.deepEqual(automated.candidates, [224]);
      assert.deepEqual(automated.imported, [224], 'AUTOMATION_IMPORTS_ONLY_NEW_BOUNDARY');
      assert.equal(await admin.archiveRunCoverage.count({ where: { sourceInstance: 'fixture-server', sourceRunId: 225 } }), 0,
        'AUTOMATION_EXCLUDES_NON_COMPLETED_RUNS');
      assert.equal(automated.archiveBackup?.outcome, 'verified');
      assert.equal(JSON.parse(await readFile(path.join(stateDirectory, 'last-result.json'), 'utf8')).status, 'completed');
      await unlink(path.join(automated.archiveBackup!.jobDirectory, 'verified.json'));
      const retryAfterLostBackup = await runAndPersistArchiveAutomation(automationConfig);
      assert.deepEqual(retryAfterLostBackup.candidates, []);
      assert.equal(retryAfterLostBackup.archiveBackup?.outcome, 'verified', 'UNBACKED_COVERAGE_FORCES_RETRY');
      assert.notEqual(retryAfterLostBackup.archiveBackup?.jobDirectory, baselineBackup.jobDirectory);
      const noChange = await runAndPersistArchiveAutomation(automationConfig);
      assert.equal(noChange.archiveBackup, null, 'RECENT_MATCHING_COVERAGE_IS_NOT_DUPLICATED');
      const verifiedBackupsBeforeStaleSource = (await readdir(scheduledBackupDirectory, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && existsSync(path.join(scheduledBackupDirectory, entry.name, 'verified.json'))).length;
      await assert.rejects(
        runArchiveAutomation(automationConfig, new Date(productionCompletedAt.getTime() + 31 * 60 * 60 * 1000)),
        /Latest production backup is stale/,
      );
      const verifiedBackupsAfterStaleSource = (await readdir(scheduledBackupDirectory, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && existsSync(path.join(scheduledBackupDirectory, entry.name, 'verified.json'))).length;
      assert.equal(verifiedBackupsAfterStaleSource, verifiedBackupsBeforeStaleSource + 1,
        'STALE_SOURCE_DOES_NOT_BLOCK_DUE_ARCHIVE_BACKUP');
      const pendingRun = await admin.archiveRunCoverage.create({ data: {
        sourceInstance: 'fixture-server', sourceRunId: 999, sourceSha256: sha256, attemptId: pendingAttempt.id,
        versionCode: 'PENDING-ONLY', runDate: coverage.runDate, sourceStatus: 'completed', sourceRun: {},
      } });
      assert.equal((await listArchiveRuns(new URLSearchParams({ q: 'PENDING-ONLY' }))).total, 0);
      assert.ok((await listArchiveRuns(new URLSearchParams())).runs.every(run => run.id !== pendingRun.id));
      await assert.rejects(readArchiveRun(pendingRun.id), /找不到/);
      await assert.rejects(readArchiveFgReport(pendingRun.id, new URLSearchParams()), /找不到/);
      await assert.rejects(readArchiveWeeklyReport(pendingRun.id, new URLSearchParams()), /找不到/);
      await assert.rejects(readArchiveRows(pendingRun.id, 'inventory', new URLSearchParams()), /找不到/);
      const originalQuery = PrismaClient.prototype.$queryRaw;
      const attemptsBeforeSnapshot = await admin.archiveImportAttempt.count();
      let concurrentInsert = false;
      const snapshotMock = t.mock.method(PrismaClient.prototype, '$queryRaw', async function (
        this: PrismaClient, ...args: Parameters<typeof originalQuery>
      ) {
        const result = await originalQuery.apply(this, args);
        if (!concurrentInsert && Array.isArray(args[0]) && args[0].join('').includes('pg_export_snapshot')) {
          concurrentInsert = true;
          await admin.archiveImportAttempt.create({ data: { sourceSha256: sha256, sourceRunId: 999, importerVersion: 'concurrent-backup-test' } });
        }
        return result;
      });
      let backup;
      try { backup = await backupAndVerifyArchive(path.join(directory, 'backups')); }
      finally { snapshotMock.mock.restore(); }
      assert.equal(concurrentInsert, true, 'BACKUP_CONCURRENT_WRITE_REACHED');
      assert.equal(backup.outcome, 'verified');
      assert.equal(backup.tablesVerified, 23);
      // Simulate lost verification publication while retaining the immutable dump and expected snapshot.
      await unlink(path.join(backup.jobDirectory, 'verified.json'));
      assert.equal(cli('archive-backup', ['--execute', '--verify-existing', backup.jobDirectory]).outcome, 'verified', 'SAVED_BACKUP_RESUMES_WITHOUT_NEW_SOURCE_SNAPSHOT');
      const backupManifest = JSON.parse(await readFile(path.join(backup.jobDirectory, 'manifest.json'), 'utf8'));
      assert.equal(backupManifest.expected.tables['archive_meta.archive_import_attempts'].count,
        String(attemptsBeforeSnapshot), 'BACKUP_USES_ONE_EXPORTED_SNAPSHOT');
      const verification = db(verifyUrl);
      await verification.$executeRawUnsafe('ALTER TABLE archive_data.staging_inventory DISABLE TRIGGER USER');
      const alteredSchema = await verification.$transaction(captureArchiveFingerprint);
      assert.notEqual(alteredSchema.schemaSha256, backupManifest.expected.schemaSha256, 'BACKUP_TRIGGER_CHANGE_DETECTED');
      await verification.$executeRawUnsafe('UPDATE archive_data.staging_inventory SET good_stock_pc=0');
      const alteredData = await verification.$transaction(captureArchiveFingerprint);
      assert.notEqual(alteredData.tables['archive_data.staging_inventory'].sha256,
        backupManifest.expected.tables['archive_data.staging_inventory'].sha256, 'BACKUP_VALUE_CHANGE_DETECTED');
      assert.equal(cli('archive-backup', ['--execute', '--directory', path.join(directory, 'backups')]).outcome, 'verified', 'BACKUP_WORKSPACE_REUSE');
      const rotationDirectory = path.join(await realpath(directory), 'rotation-backups');
      await mkdir(rotationDirectory);
      const oldAttempt = await admin.archiveImportAttempt.findUniqueOrThrow({ where: { id: pendingAttempt.id } });
      await admin.archiveImportAttempt.update({ where: { id: oldAttempt.id }, data: { importerVersion: 'rotation-different' } });
      const differentBackup = await backupAndVerifyArchive(path.join(directory, 'different-backup'));
      await admin.archiveImportAttempt.update({ where: { id: oldAttempt.id }, data: { importerVersion: oldAttempt.importerVersion } });
      for (let index = 0; index < 5; index++) {
        const target = path.join(rotationDirectory, `archive-00000${index}`);
        await cp(index === 0 ? differentBackup.jobDirectory : index === 1 ? baselineBackup.jobDirectory : backup.jobDirectory, target, { recursive: true });
        for (const file of ['manifest.json', 'verified.json']) {
          const value = JSON.parse(await readFile(path.join(target, file), 'utf8'));
          const timestamp = new Date(Date.now() - (40 - index) * 86_400_000).toISOString();
          if (file === 'manifest.json') value.createdAt = timestamp; else value.verifiedAt = timestamp;
          await writeFile(path.join(target, file), JSON.stringify(value));
        }
      }
      await withArchiveWorkspace('backup-verification', async () => {
        await assert.rejects(rotateArchiveBackups(rotationDirectory), /locked|active|busy/i, 'ROTATION_SHARES_BACKUP_LOCK');
      });
      const keptDump = path.join(rotationDirectory, 'archive-000004', 'archive.dump');
      await symlink(rotationDirectory, path.join(directory, 'linked-rotation'));
      await assert.rejects(rotateArchiveBackups(path.join(directory, 'linked-rotation')), /linked/);
      await cp(backup.jobDirectory, path.join(rotationDirectory, 'archive-000005'), { recursive: true });
      await writeFile(path.join(rotationDirectory, 'archive-000005', 'unexpected.txt'), 'must stay');
      const keptBytes = await readFile(keptDump);
      await writeFile(keptDump, Buffer.alloc(keptBytes.length));
      await assert.rejects(rotateArchiveBackups(rotationDirectory), /hash/, 'CORRUPT_KEEPER_MUST_BLOCK_DELETION');
      assert.equal(existsSync(path.join(rotationDirectory, 'archive-000000', 'archive.dump')), true);
      await writeFile(keptDump, keptBytes);
      const rotation = await rotateArchiveBackups(rotationDirectory);
      assert.equal(rotation.outcome, 'rotated', 'RESTORED_SUPERSET_ALLOWS_ONLY_OLD_COPY');
      assert.deepEqual(rotation.protectedJobs, ['archive-000000'], 'DIFFERENT_OLDEST_MUST_NOT_STARVE_LATER_CANDIDATE');
      assert.equal(existsSync(path.join(rotationDirectory, 'archive-000000', 'archive.dump')), true);
      assert.equal(existsSync(path.join(rotationDirectory, 'archive-000001', 'archive.dump')), false);
      assert.equal(existsSync(path.join(rotationDirectory, 'archive-000001', 'manifest.json')), true);
      assert.equal(existsSync(keptDump), true);
      assert.equal(existsSync(path.join(rotationDirectory, 'archive-000005', 'archive.dump')), true, 'UNKNOWN_JOB_MUST_STAY');
      assert.equal((await rotateArchiveBackups(rotationDirectory)).outcome, 'protected-different-content');
      if (generation === 'G4') {
        await source.$executeRawUnsafe(`
          CREATE TABLE mrp_out.production_plan_transfers (
            id serial PRIMARY KEY,
            mrp_run_id integer REFERENCES public.mrp_run(id),
            work_order_status text NOT NULL
          )
        `);
        await source.$executeRawUnsafe(`
          ALTER TABLE staging.inventory
          ADD CONSTRAINT retention_lock_test_run_fk
          FOREIGN KEY (mrp_run_id) REFERENCES public.mrp_run(id)
        `);
        await source.$executeRawUnsafe(
          `UPDATE public.mrp_run SET is_latest = false,
             completed_at = TIMESTAMPTZ '2026-07-28 01:02:03.123456+08'
           WHERE id = 18`,
        );
        const liveRetention = new LivePrismaClient({
          datasourceUrl: `${sourceUrl}?statement_timeout=2000`,
        });
        const liveAggregation = new LivePrismaClient({
          datasourceUrl: `${sourceUrl}?statement_timeout=2000`,
        });
        try {
          let aggregationLocked!: () => void;
          let releaseAggregation!: () => void;
          const lockAcquired = new Promise<void>((resolve) => { aggregationLocked = resolve; });
          const mayWrite = new Promise<void>((resolve) => { releaseAggregation = resolve; });
          const aggregation = liveAggregation.$transaction(async tx => {
            await tx.$executeRawUnsafe(
              'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
              runSnapshotLockIdentity(18),
            );
            aggregationLocked();
            await mayWrite;
            await tx.$executeRawUnsafe(`
              INSERT INTO staging.inventory
              SELECT (jsonb_populate_record(
                NULL::staging.inventory,
                to_jsonb(t) || '{"id":18999}'::jsonb
              )).*
              FROM staging.inventory t
              WHERE id = 18001
            `);
          }, { timeout: 10_000 });
          await lockAcquired;
          let gateReached = false;
          const retention = deleteCompletedRunForRetention(
            18,
            {
              now: new Date('2026-09-08T00:00:00Z'),
              config: {
                enabled: true,
                retentionDays: 30,
                minimumCompletedRuns: 1,
                batchSize: 1,
              },
            },
            liveRetention,
            async runId => {
              gateReached = true;
              return { allowed: false, runId, reason: 'coverage-missing' };
            },
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          releaseAggregation();
          await aggregation;
          assert.deepEqual(await retention, {
            outcome: 'archive-blocked',
            block: { allowed: false, runId: 18, reason: 'coverage-missing' },
          });
          assert.equal(gateReached, true, 'RETENTION_ADVISORY_LOCK_PRECEDES_PARENT_ROW_LOCK');
        } finally {
          await Promise.all([
            liveRetention.$disconnect(),
            liveAggregation.$disconnect(),
          ]);
        }
      }
      t.diagnostic(`${generation}: real restore/import CLI, 18-table digest, 501-row batch, precision, rollback, retry, lost COMMIT, source pinning, lock, immutable publication and reader ACL passed`);
    } finally {
      await Promise.all(clients.map(client => client.$disconnect()));
      envKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
      if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    }
  });
});
