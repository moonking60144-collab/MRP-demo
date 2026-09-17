import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '.prisma/archive-client';
import { openArchiveReader } from '../archive-db';
import { archiveConnectionUrl } from './connection';
import { ARCHIVE_RUN_TABLES } from './coverage';
import { runRestoreCommand } from './restore-seed';
import { assertLockedWorkspace, assertWorkspaceTransaction, resetArchiveWorkspace, withArchiveWorkspace, type LockedArchiveWorkspace } from './workspace';

const tables = [
  ...ARCHIVE_RUN_TABLES.map(table => `archive_data.${table.replace('.', '_')}`),
  ...['archive_sources', 'archive_source_runs', 'archive_import_attempts', 'archive_run_coverage', 'archive_table_verification'].map(table => `archive_meta.${table}`),
].sort();
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function captureArchiveFingerprint(tx: Prisma.TransactionClient, recoveryGroups = false) {
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog');
  const [unsupported] = await tx.$queryRaw<Array<{ found: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN
        ('information_schema','public','archive_meta','archive_data','archive_workspace'))
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
      OR EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
      OR EXISTS (SELECT 1 FROM pg_largeobject_metadata)
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('archive_meta','archive_data') AND (c.relrowsecurity OR c.relforcerowsecurity))
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname IN ('archive_meta','archive_data') AND (t.typtype NOT IN ('c','b') OR (t.typtype='b' AND t.typelem=0)))
    ) AS found
  `;
  if (unsupported.found) throw new Error('Archive backup contains unsupported database objects');
  const inventory = await tx.$queryRaw<Array<{ name: string; kind: string }>>`
    SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('archive_meta', 'archive_data') AND c.relkind NOT IN ('i', 'I') ORDER BY name
  `;
  if (JSON.stringify(inventory.map(row => row.name)) !== JSON.stringify(tables) || inventory.some(row => row.kind !== 'r')) {
    throw new Error('Archive backup table inventory is unsupported');
  }
  const schema = await tx.$queryRaw<Array<{ kind: string; name: string; definition: string }>>`
    SELECT 'column' AS kind, n.nspname || '.' || c.relname || '.' || a.attname AS name,
      jsonb_build_array(a.attnum, format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated)::text AS definition
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname IN ('archive_meta','archive_data') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint', n.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('archive_meta','archive_data')
    UNION ALL SELECT 'index', n.nspname || '.' || c.relname, pg_get_indexdef(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('archive_meta','archive_data') AND c.relkind='i'
    UNION ALL SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
      jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('archive_meta','archive_data') AND NOT t.tgisinternal
    UNION ALL SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('archive_meta','archive_data')
    ORDER BY kind, name
  `;
  const rows: Record<string, { count: string; sha256: string }> = {};
  const groups: Record<string, string> = {};
  for (const table of tables) {
    const primary = await tx.$queryRaw<Array<{ name: string }>>`
      SELECT a.attname AS name FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE i.indrelid=${table}::regclass AND i.indisprimary ORDER BY k.ord
    `;
    if (!primary.length) throw new Error('Archive backup requires primary keys');
    const relation = table.split('.').map(quoted).join('.');
    await tx.$executeRawUnsafe(`DECLARE archive_backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS payload
      FROM ${relation} t ORDER BY ${primary.map(row => quoted(row.name)).join(',')}`);
    const hash = createHash('sha256');
    const groupHashes = new Map<string, ReturnType<typeof createHash>>();
    let count = BigInt(0);
    while (true) {
      const batch = await tx.$queryRawUnsafe<Array<{ payload: string }>>('FETCH FORWARD 500 FROM archive_backup_rows');
      if (!batch.length) break;
      for (const row of batch) {
        hash.update(row.payload).update('\n'); count++;
        if (recoveryGroups) {
          const value = JSON.parse(row.payload);
          const key = table.startsWith('archive_data.') ? value.archive_run_id :
            JSON.stringify(primary.map(column => value[column.name]));
          if (typeof key !== 'string') throw new Error('Archive recovery group identity missing');
          if (!groupHashes.has(key)) groupHashes.set(key, createHash('sha256'));
          groupHashes.get(key)!.update(row.payload).update('\n');
        }
      }
    }
    await tx.$executeRawUnsafe('CLOSE archive_backup_rows');
    rows[table] = { count: count.toString(), sha256: hash.digest('hex') };
    for (const [key, group] of groupHashes) groups[`${table}/${key}`] = group.digest('hex');
  }
  return { schemaSha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), tables: rows,
    ...(recoveryGroups ? { groups } : {}) };
}

async function dumpSnapshot(url: URL, snapshot: string, dump: string) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGCONNECT_TIMEOUT = '10';
  if (url.searchParams.has('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode')!;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ARCHIVE_PG_DUMP_PATH || 'pg_dump', [
      '--format=custom', '--no-password', '--schema=archive_meta', '--schema=archive_data',
      `--snapshot=${snapshot}`, `--file=${dump}`, `--host=${url.hostname}`, `--port=${url.port || '5432'}`,
      '--username=archive_reader', '--dbname=funda_mrp_archive',
    ], { env, shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 1_800_000 });
    child.stderr.resume();
    child.once('error', () => reject(new Error('Unable to start Archive pg_dump')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Archive pg_dump failed (${code})`)));
  });
}

async function fileHash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifySavedBackup(job: string, workspace: LockedArchiveWorkspace, inspectOnly = false) {
  const manifest = JSON.parse(await readFile(path.join(job, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.database !== 'funda_mrp_archive' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.expected?.schemaSha256) ||
      JSON.stringify(Object.keys(manifest.expected?.tables ?? {}).sort()) !== JSON.stringify(tables) ||
      Object.values(manifest.expected.tables).some(value => {
        const row = value as { count?: string; sha256?: string };
        return !row || !/^\d+$/.test(row.count ?? '') || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '');
      })) throw new Error('Archive backup manifest is invalid');
  const dump = path.join(job, 'archive.dump');
  if ((await stat(dump)).size !== manifest.sizeBytes || await fileHash(dump) !== manifest.sha256) {
    throw new Error('Archive backup file differs from manifest');
  }
  await resetArchiveWorkspace(workspace);
  await runRestoreCommand(new URL(workspace.url), dump, workspace);
  await assertLockedWorkspace(workspace);
  const actual = await workspace.client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await assertWorkspaceTransaction(workspace, tx);
    return captureArchiveFingerprint(tx, inspectOnly);
  }, { isolationLevel: 'RepeatableRead', timeout: 3_600_000 });
  const snapshot = { schemaSha256: actual.schemaSha256, tables: actual.tables };
  if (JSON.stringify(snapshot) !== JSON.stringify(manifest.expected) || await fileHash(dump) !== manifest.sha256) {
    throw new Error('Archive restored schema or data does not match backup snapshot');
  }
  if (!inspectOnly) await writeFile(path.join(job, 'verified.json'), JSON.stringify({ version: 1, sha256: manifest.sha256,
    verifiedAt: new Date().toISOString(), tablesVerified: tables.length, restoreVerified: true }), { flag: 'wx' });
  return { outcome: 'verified' as const, jobDirectory: job, sha256: manifest.sha256 as string,
    sizeBytes: manifest.sizeBytes as number, tablesVerified: tables.length,
    ...(inspectOnly ? { recovery: actual } : {}) };
}

export async function inspectBackupRecovery(job: string, workspace: LockedArchiveWorkspace) {
  await assertLockedWorkspace(workspace);
  if (workspace.kind !== 'backup-verification') throw new Error('Backup recovery requires verification workspace');
  return verifySavedBackup(job, workspace, true);
}

export async function verifyExistingArchiveBackup(job: string) {
  if (!path.isAbsolute(job)) throw new Error('Archive backup job directory must be absolute');
  return withArchiveWorkspace('backup-verification', workspace => verifySavedBackup(job, workspace));
}

export async function backupAndVerifyArchive(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error('Archive backup directory must be absolute');
  return withArchiveWorkspace('backup-verification', async workspace => {
    const reader = await openArchiveReader();
    let job: string | undefined;
    try {
      await mkdir(directory, { recursive: true });
      job = await mkdtemp(path.join(directory, 'archive-'));
      const partial = path.join(job, 'archive.partial');
      const dump = path.join(job, 'archive.dump');
      const expected = await reader.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const [snapshot] = await tx.$queryRaw<Array<{ id: string }>>`SELECT pg_export_snapshot() AS id`;
        await dumpSnapshot(new URL(archiveConnectionUrl('reader')), snapshot.id, partial);
        return captureArchiveFingerprint(tx);
      }, { isolationLevel: 'RepeatableRead', timeout: 3_600_000 });
      const sizeBytes = (await stat(partial)).size;
      if (sizeBytes === 0) throw new Error('Archive dump is empty');
      const handle = await open(partial, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const sha256 = await fileHash(partial);
      await rename(partial, dump);
      await writeFile(path.join(job, 'manifest.json'), JSON.stringify({ version: 1, database: 'funda_mrp_archive',
        sha256, sizeBytes, createdAt: new Date().toISOString(), expected, restoreVerified: false }), { flag: 'wx' });
      return await verifySavedBackup(job, workspace);
    } catch (error) {
      if (job) await writeFile(path.join(job, 'failed.json'), JSON.stringify({ failedAt: new Date().toISOString(), restoreVerified: false }), { flag: 'wx' }).catch(() => undefined);
      throw error;
    } finally { await reader.$disconnect(); }
  });
}
