import { spawn } from 'node:child_process';
import { Prisma, PrismaClient } from '.prisma/archive-client';
import { archiveConnectionUrl } from './connection';
import { ARCHIVE_RUN_TABLES } from './coverage';
import { registerArchiveSeed } from './register-seed';
import { verifyArchiveSeed, type ArchiveSchemaGeneration } from './seed-manifest';
import { assertSourceSchema, columnsFor, RESTORE_LOCK, streamSnapshot, type RunFingerprints } from './snapshot-data';
import { assertLockedWorkspace, type LockedArchiveWorkspace } from './workspace';

export interface RestoreReceipt {
  sourceSha256: string;
  sourceInstance: string;
  schemaGeneration: ArchiveSchemaGeneration;
  status: string;
  schemaDigest: string | null;
  fingerprints: RunFingerprints | null;
}

export function restoreConnectionUrl() {
  const url = new URL(archiveConnectionUrl('restore'));
  // Session advisory locks must stay on one physical connection.
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('max_idle_connection_lifetime', '0');
  url.searchParams.set('max_connection_lifetime', '0');
  return url.toString();
}

export async function assertRestoreIdentity(client: Pick<PrismaClient, '$queryRaw'>, workspace?: LockedArchiveWorkspace) {
  if (workspace) {
    if (workspace.kind !== 'automatic-staging' || client !== workspace.client) throw new Error('Automatic restore requires its locked workspace');
    await assertLockedWorkspace(workspace);
    return;
  }
  const [identity] = await client.$queryRaw<Array<{ database: string; role: string }>>`
    SELECT current_database() AS database, current_user AS role
  `;
  if (identity?.database !== 'funda_mrp_restore_tmp' || identity.role !== 'archive_loader') {
    throw new Error('Archive restore requires archive_loader on funda_mrp_restore_tmp');
  }
}

export async function loadRestoreReceipt(client: Pick<PrismaClient, '$queryRaw'>) {
  const [receipt] = await client.$queryRaw<RestoreReceipt[]>`
    SELECT source_sha256 AS "sourceSha256", source_instance AS "sourceInstance",
      schema_generation AS "schemaGeneration", status, schema_digest AS "schemaDigest", fingerprints
    FROM archive_restore.receipt WHERE id = 1
  `;
  return receipt;
}

export async function runRestoreCommand(url: URL, dumpPath: string, workspace?: LockedArchiveWorkspace) {
  if (workspace) {
    await assertLockedWorkspace(workspace);
    if (url.toString() !== workspace.url) throw new Error('Restore URL differs from locked workspace');
  } else if (url.pathname !== '/funda_mrp_restore_tmp') throw new Error('Legacy restore target is not allowed');
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGCONNECT_TIMEOUT = '10';
  env.PGAPPNAME = 'funda-mrp-archive-restore';
  if (url.searchParams.has('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode')!;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ARCHIVE_PG_RESTORE_PATH || 'pg_restore', [
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--no-password',
      `--host=${url.hostname}`, `--port=${url.port || '5432'}`, `--username=${decodeURIComponent(url.username)}`,
      `--dbname=${workspace ? url.pathname.slice(1) : 'funda_mrp_restore_tmp'}`, dumpPath,
    ], { env, shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 1_800_000 });
    child.stderr.resume();
    child.once('error', () => reject(new Error('Unable to start Archive pg_restore')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Archive pg_restore failed (${code})`)));
  });
}

async function captureRestoredData(client: Prisma.TransactionClient, generation: ArchiveSchemaGeneration, runIds: number[]) {
  await client.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  const schemaDigest = await assertSourceSchema(client, generation);
  const ids = await client.$queryRaw<Array<{ id: number }>>`SELECT id FROM public.mrp_run ORDER BY id`;
  if (JSON.stringify(ids.map(row => row.id)) !== JSON.stringify(runIds)) throw new Error('Restored Run membership differs from seed');
  const fingerprints: RunFingerprints = {};
  for (const { id } of ids) {
    const run = {} as RunFingerprints[string];
    for (const table of ARCHIVE_RUN_TABLES) {
      run[table] = columnsFor(generation, table) === null ? null :
        await streamSnapshot(client, table, generation, { sourceRunId: id });
    }
    fingerprints[id] = run;
  }
  return { schemaDigest, fingerprints };
}

export async function restoreArchiveSeed(dumpPath: string, sourceInstance: string, workspace?: LockedArchiveWorkspace) {
  const url = workspace?.url ?? restoreConnectionUrl();
  const { manifest } = await verifyArchiveSeed(dumpPath);
  const client = workspace?.client ?? new PrismaClient({ datasourceUrl: url });
  let locked = false;
  let started = false;
  try {
    await assertRestoreIdentity(client, workspace);
    const [lock] = await client.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(${RESTORE_LOCK}) AS acquired`;
    if (!lock.acquired) throw new Error('Archive staging is busy');
    locked = true;
    const existing = await loadRestoreReceipt(client);
    if (existing) {
      if (existing.status !== 'ready' || existing.sourceSha256 !== manifest.sha256 || existing.sourceInstance !== sourceInstance) {
        throw new Error('Archive staging is not empty; prepare a new disposable database explicitly');
      }
      await registerArchiveSeed(dumpPath, sourceInstance);
      const observed = await client.$transaction(tx => captureRestoredData(tx, manifest.schemaGeneration, manifest.runCoverage.runIds),
        { isolationLevel: 'RepeatableRead', timeout: 1_800_000 });
      if (observed.schemaDigest !== existing.schemaDigest || manifest.runCoverage.runIds.some(id =>
        ARCHIVE_RUN_TABLES.some(table => {
          const expected = existing.fingerprints?.[id]?.[table];
          const actual = observed.fingerprints[id][table];
          return actual === null ? expected !== null : !expected || actual.rows !== expected.rows || actual.digest !== expected.digest;
        }))) throw new Error('Staging no longer matches the restore receipt');
      return { outcome: 'already-restored' as const, sha256: manifest.sha256 };
    }
    const [objects] = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema', 'archive_restore')
        AND (${Boolean(workspace)} = false OR n.nspname <> 'archive_workspace')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    `;
    if (objects.count !== BigInt(0)) throw new Error('Archive staging must be empty before restore');
    await registerArchiveSeed(dumpPath, sourceInstance);
    await client.$executeRaw`
      INSERT INTO archive_restore.receipt (id, source_sha256, source_instance, schema_generation, status)
      VALUES (1, ${manifest.sha256}, ${sourceInstance}, ${manifest.schemaGeneration}, 'restoring')
    `;
    started = true;
    await runRestoreCommand(new URL(url), dumpPath, workspace);
    if (workspace) await assertLockedWorkspace(workspace);
    const verifiedAgain = await verifyArchiveSeed(dumpPath);
    if (verifiedAgain.manifest.sha256 !== manifest.sha256) throw new Error('Seed changed during restore');
    const { schemaDigest, fingerprints } = await client.$transaction(
      tx => captureRestoredData(tx, manifest.schemaGeneration, manifest.runCoverage.runIds),
      { isolationLevel: 'RepeatableRead', timeout: 1_800_000 });
    await client.$executeRaw`
      UPDATE archive_restore.receipt SET status = 'ready', schema_digest = ${schemaDigest},
        fingerprints = ${JSON.stringify(fingerprints)}::jsonb, completed_at = now()
      WHERE id = 1 AND source_sha256 = ${manifest.sha256} AND status = 'restoring'
    `;
    return { outcome: 'restored' as const, sha256: manifest.sha256, runCount: manifest.runCoverage.count };
  } catch (error) {
    if (started) {
      await client.$executeRaw`UPDATE archive_restore.receipt SET status = 'failed'
        WHERE id = 1 AND source_sha256 = ${manifest.sha256} AND status = 'restoring'`.catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) await client.$queryRaw`SELECT pg_advisory_unlock(${RESTORE_LOCK})`.catch(() => undefined);
    if (!workspace) await client.$disconnect();
  }
}
