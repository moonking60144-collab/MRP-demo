import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '.prisma/archive-client';
import { openArchiveReader } from '../archive-db';
import { registerArchiveSeed } from './register-seed';
import { verifyArchiveSeed } from './seed-manifest';

test('隔離 PostgreSQL 驗證 seed registration、provenance FK、CHECK 與 reader 拒寫', {
  skip: !process.env.ARCHIVE_TEST_ADMIN_URL,
}, async () => {
  const url = new URL(process.env.ARCHIVE_TEST_ADMIN_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'archive_test_admin');
  assert.equal(url.pathname, '/funda_mrp_archive');
  assert.ok(url.port && url.port !== '5432', 'Only an explicitly isolated test cluster is allowed');
  const admin = new PrismaClient({ datasourceUrl: url.toString() });
  const suffix = randomUUID().replaceAll('-', '');
  const sourceDb = `archive_fixture_${suffix}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-db-test-'));
  const previous = { reader: process.env.ARCHIVE_DATABASE_URL, loader: process.env.ARCHIVE_LOADER_DATABASE_URL };
  let source: PrismaClient | undefined;
  let reader: PrismaClient | undefined;
  try {
    const loaderUrl = new URL(url);
    loaderUrl.username = 'archive_loader';
    process.env.ARCHIVE_LOADER_DATABASE_URL = loaderUrl.toString();
    const readerUrl = new URL(url);
    readerUrl.username = 'archive_reader';
    readerUrl.searchParams.set('connection_limit', '1');
    process.env.ARCHIVE_DATABASE_URL = readerUrl.toString();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${sourceDb}"`);
    const sourceUrl = new URL(url);
    sourceUrl.pathname = `/${sourceDb}`;
    source = new PrismaClient({ datasourceUrl: sourceUrl.toString() });
    await source.$executeRawUnsafe('CREATE TABLE public.mrp_run (id integer PRIMARY KEY, version_code text NOT NULL)');
    await source.$executeRawUnsafe("INSERT INTO public.mrp_run VALUES (18, 'old-run'), (220, 'new-run')");
    const registered = [];
    for (const generation of ['G1', 'G4'] as const) {
      if (generation === 'G4') {
        await source.$executeRawUnsafe("ALTER TABLE public.mrp_run ADD COLUMN order_demand_contract_version text DEFAULT 'order-demand-v1'");
      }
      const dumpPath = path.join(directory, `${generation}.dump`);
      execFileSync('pg_dump', ['--format=custom', '--file', dumpPath, '--dbname', sourceUrl.toString()]);
      const manifest = {
        manifestVersion: 1, kind: 'funda-mrp-archive-seed', seedFileName: `${generation}.dump`,
        sourceFileName: 'source.dump', schemaGeneration: generation,
        sizeBytes: (await stat(dumpPath)).size,
        sha256: createHash('sha256').update(await readFile(dumpPath)).digest('hex'),
        createdAt: new Date().toISOString(),
        runCoverage: { count: 2, minRunId: 18, maxRunId: 220, runIds: [18, 220] },
      };
      const manifestPath = path.join(directory, `${generation}.archive.json`);
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(path.join(directory, `${generation}.sha256`), `${manifest.sha256}  ${generation}.dump\n`);
      const instance = `${suffix}-${generation}`;
      const cwd = fileURLToPath(new URL('../../..', import.meta.url));
      const checked = JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', 'scripts/archive-seed-check.ts', '--dump', dumpPath,
      ], { cwd, encoding: 'utf8' }));
      assert.equal(checked.archiveVerified, false);
      const result = JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', 'scripts/archive-register-seed.ts', '--execute', '--dump', dumpPath,
        '--source-instance', instance,
      ], { cwd, encoding: 'utf8', env: process.env }));
      assert.equal(result.outcome, 'registered');
      assert.equal((await registerArchiveSeed(dumpPath, instance)).outcome, 'already-registered');
      await assert.rejects(registerArchiveSeed(dumpPath, `${instance}-wrong`), /provenance conflicts/);
      assert.equal(await admin.archiveSourceRun.count({ where: { sourceSha256: manifest.sha256 } }), 2);
      assert.equal(await admin.archiveRunCoverage.count({ where: { sourceSha256: manifest.sha256 } }), 0);
      assert.equal(await admin.archiveImportAttempt.count({ where: { sourceSha256: manifest.sha256 } }), 0);
      await writeFile(manifestPath, JSON.stringify({ ...manifest,
        runCoverage: { count: 2, minRunId: 18, maxRunId: 999, runIds: [18, 999] },
      }));
      await assert.rejects(verifyArchiveSeed(dumpPath), /actual dump Run inventory/);
      registered.push({ sha256: manifest.sha256, instance });
    }
    const [g1, g4] = registered;
    const attempt1 = await admin.archiveImportAttempt.create({ data: { sourceSha256: g1.sha256, sourceRunId: 18, importerVersion: 'test' } });
    const attempt4 = await admin.archiveImportAttempt.create({ data: { sourceSha256: g4.sha256, sourceRunId: 18, importerVersion: 'test' } });
    const coverage = {
      sourceInstance: g1.instance, sourceRunId: 18, sourceSha256: g1.sha256,
      attemptId: attempt1.id, versionCode: 'old-run', runDate: new Date('2026-07-28'),
      sourceStatus: 'completed', sourceRun: { id: 18 }, status: 'importing',
    };
    await assert.rejects(admin.archiveRunCoverage.create({ data: { ...coverage, sourceInstance: 'wrong-instance' } }), /constraint/i);
    await assert.rejects(admin.archiveRunCoverage.create({ data: { ...coverage, attemptId: attempt4.id } }), /constraint/i);
    const run = await admin.archiveRunCoverage.create({ data: coverage });
    await assert.rejects(admin.archiveRunCoverage.create({ data: coverage }), /constraint/i);
    await assert.rejects(admin.archiveTableVerification.create({ data: {
      archiveRunId: run.id, tableName: 'staging.work_order_material_movements', status: 'not-in-source',
      sourcePresent: false, sourceColumns: [], missingColumns: [], sourceRows: null, archiveRows: null,
      verifiedAt: new Date(),
    } }), /constraint/i);
    await assert.rejects(admin.archiveTableVerification.create({ data: {
      archiveRunId: run.id, tableName: 'public.mrp_run', status: 'verified', sourcePresent: true,
      sourceColumns: ['id'], missingColumns: [], sourceRows: BigInt(1), archiveRows: BigInt(1),
      sourceDigest: 'a'.repeat(64), archiveDigest: 'b'.repeat(64), verifiedAt: new Date(),
    } }), /constraint/i);
    reader = await openArchiveReader();
    assert.ok(await reader.archiveSource.findUnique({ where: { sha256: g1.sha256 } }));
    await assert.rejects(reader.$executeRawUnsafe('DELETE FROM archive_meta.archive_sources WHERE false'), /read-only/i);
    await reader.$executeRawUnsafe('SET default_transaction_read_only = off');
    const [setting] = await reader.$queryRawUnsafe<Array<{ value: string }>>("SELECT current_setting('default_transaction_read_only') AS value");
    assert.equal(setting.value, 'off');
    for (const sql of [
      'DELETE FROM archive_meta.archive_sources WHERE false',
      'UPDATE archive_meta.archive_sources SET size_bytes = 1 WHERE false',
      'CREATE TABLE archive_meta.reader_probe (id integer)',
      'SET ROLE archive_loader',
    ]) await assert.rejects(reader.$executeRawUnsafe(sql), /permission denied/i, 'ARCHIVE_READER_CANNOT_WRITE');
  } finally {
    await reader?.$disconnect();
    await source?.$disconnect();
    await admin.$disconnect();
    if (previous.reader === undefined) delete process.env.ARCHIVE_DATABASE_URL;
    else process.env.ARCHIVE_DATABASE_URL = previous.reader;
    if (previous.loader === undefined) delete process.env.ARCHIVE_LOADER_DATABASE_URL;
    else process.env.ARCHIVE_LOADER_DATABASE_URL = previous.loader;
    await rm(directory, { recursive: true, force: true });
  }
});
