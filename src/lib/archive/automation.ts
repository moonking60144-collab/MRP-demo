import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '.prisma/archive-client';
import { archiveConnectionUrl } from './connection';
import { backupAndVerifyArchive } from './backup';
import { rotateArchiveBackups } from './backup-rotation';
import { hasCompleteTableEvidence } from './coverage';
import { inspectDumpRuns } from './dump-inventory';
import { importArchiveBatch } from './import-batch';
import { promoteDatabaseBackupToSeed, type ProductionBackupSource } from './promote-seed';

const AUTOMATION_LOCK = 74928318;
export interface ArchiveAutomationConfig {
  enabled: boolean;
  sourceInstance: string;
  minimumRunId: number;
  productionBackupDirectory: string;
  seedDirectory: string;
  archiveBackupDirectory: string;
  stateDirectory: string;
  databaseDataDirectory: string;
  maximumSourceAgeHours: number;
  backupIntervalHours: number;
  minimumFreeBytes: bigint;
  backupRotationEnabled?: boolean;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Archive automation numeric configuration is invalid');
  return parsed;
}

export function getArchiveAutomationConfig(env = process.env): ArchiveAutomationConfig {
  const config = {
    enabled: env.ARCHIVE_AUTOMATION_ENABLED?.trim().toLowerCase() === 'true',
    sourceInstance: env.ARCHIVE_AUTOMATION_SOURCE_INSTANCE?.trim() ?? '',
    minimumRunId: positiveInteger(env.ARCHIVE_AUTOMATION_MIN_RUN_ID, 1),
    productionBackupDirectory: env.DB_BACKUP_DIRECTORY?.trim() ?? '',
    seedDirectory: env.ARCHIVE_AUTOMATION_SEED_DIRECTORY?.trim() ?? '',
    archiveBackupDirectory: env.ARCHIVE_AUTOMATION_BACKUP_DIRECTORY?.trim() ?? '',
    stateDirectory: env.ARCHIVE_AUTOMATION_STATE_DIRECTORY?.trim() ?? '',
    databaseDataDirectory: env.ARCHIVE_AUTOMATION_DATABASE_DATA_DIRECTORY?.trim() ?? '',
    maximumSourceAgeHours: positiveInteger(env.ARCHIVE_AUTOMATION_MAX_SOURCE_AGE_HOURS, 30),
    backupIntervalHours: positiveInteger(env.ARCHIVE_AUTOMATION_BACKUP_INTERVAL_HOURS, 24),
    minimumFreeBytes: BigInt(env.ARCHIVE_AUTOMATION_MIN_FREE_BYTES ?? String(20 * 1024 ** 3)),
    backupRotationEnabled: env.ARCHIVE_AUTOMATION_BACKUP_ROTATION_ENABLED === 'true',
  };
  if (!config.sourceInstance || config.sourceInstance.length > 200 ||
      ![config.productionBackupDirectory, config.seedDirectory, config.archiveBackupDirectory, config.stateDirectory, config.databaseDataDirectory].every(path.isAbsolute) ||
      new Set([config.productionBackupDirectory, config.seedDirectory, config.archiveBackupDirectory, config.stateDirectory]
        .map(value => path.resolve(value).toLowerCase())).size !== 4 || config.minimumFreeBytes < BigInt(1)) {
    throw new Error('Archive automation paths, source or capacity configuration is invalid');
  }
  return config;
}

async function listProductionBackups(directory: string): Promise<ProductionBackupSource[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pattern = /^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump$/;
  const backups = await Promise.all(entries.filter(entry => entry.isFile() && pattern.test(entry.name)).map(async entry => {
    try {
      const archivePath = path.join(directory, entry.name);
      const [archiveStat, manifest, sidecar] = await Promise.all([
        stat(archivePath), readFile(`${archivePath}.json`, 'utf8').then(JSON.parse), readFile(`${archivePath}.sha256`, 'utf8'),
      ]);
      const [sidecarHash, sidecarName] = sidecar.trim().split(/\s+/);
      if (manifest.fileName !== entry.name || manifest.sizeBytes !== archiveStat.size || !Number.isSafeInteger(manifest.sizeBytes) ||
          manifest.sizeBytes < 1 || !/^[A-F0-9]{64}$/.test(manifest.sha256) || sidecarHash !== manifest.sha256 ||
          sidecarName !== entry.name || !Number.isFinite(Date.parse(manifest.startedAt)) ||
          !Number.isFinite(Date.parse(manifest.completedAt)) || !Number.isFinite(manifest.durationMs) || manifest.durationMs < 0) return null;
      return { archivePath, manifestPath: `${archivePath}.json`, sha256Path: `${archivePath}.sha256`, manifest } as ProductionBackupSource;
    } catch { return null; }
  }));
  return backups.filter((value): value is ProductionBackupSource => value !== null)
    .sort((a, b) => Date.parse(b.manifest.completedAt) - Date.parse(a.manifest.completedAt));
}

async function ensureCapacity(directory: string, minimumFreeBytes: bigint, create = true) {
  if (create) await mkdir(directory, { recursive: true });
  const filesystem = await statfs(directory, { bigint: true });
  const free = filesystem.bavail * filesystem.bsize;
  if (free < minimumFreeBytes) throw new Error(`Archive automation capacity threshold reached: ${directory}`);
  return free;
}

async function latestVerifiedArchiveBackup(directory: string) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const verified = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    try {
      const job = path.join(directory, entry.name);
      const [receipt, manifest] = await Promise.all([
        readFile(path.join(job, 'verified.json'), 'utf8').then(JSON.parse),
        readFile(path.join(job, 'manifest.json'), 'utf8').then(JSON.parse),
      ]);
      const coverage = manifest.expected?.tables?.['archive_meta.archive_run_coverage'];
      const dump = await stat(path.join(job, 'archive.dump'));
      if (receipt.version !== 1 || receipt.restoreVerified !== true || receipt.sha256 !== manifest.sha256 ||
          !dump.isFile() || dump.size !== manifest.sizeBytes ||
          !Number.isFinite(Date.parse(receipt.verifiedAt)) || !/^\d+$/.test(coverage?.count ?? '') ||
          !/^[a-f0-9]{64}$/.test(coverage?.sha256 ?? '')) return null;
      return { job, verifiedAt: receipt.verifiedAt as string, coverage: coverage as { count: string; sha256: string } };
    } catch { return null; }
  }));
  return verified.filter((value): value is { job: string; verifiedAt: string; coverage: { count: string; sha256: string } } => value !== null)
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt))[0] ?? null;
}

async function currentCoverageFingerprint(archive: PrismaClient) {
  return archive.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    const rows = await tx.$queryRaw<Array<{ payload: string }>>`
      SELECT to_jsonb(t)::text AS payload FROM archive_meta.archive_run_coverage t ORDER BY id
    `;
    const hash = createHash('sha256');
    for (const row of rows) hash.update(row.payload).update('\n');
    return { count: String(rows.length), sha256: hash.digest('hex') };
  });
}

async function writeAutomationState(config: ArchiveAutomationConfig, value: object) {
  await mkdir(config.stateDirectory, { recursive: true });
  const partial = path.join(config.stateDirectory, `last-result.${randomUUID()}.partial`);
  await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(partial, path.join(config.stateDirectory, 'last-result.json'));
}

export async function runArchiveAutomation(config = getArchiveAutomationConfig(), now = new Date()) {
  if (!config.enabled) return { outcome: 'disabled' as const };
  const lockUrl = new URL(archiveConnectionUrl('loader'));
  lockUrl.searchParams.set('connection_limit', '1');
  lockUrl.searchParams.set('max_idle_connection_lifetime', '0');
  lockUrl.searchParams.set('max_connection_lifetime', '0');
  const archive = new PrismaClient({ datasourceUrl: lockUrl.toString() });
  let locked = false;
  try {
    const [identity] = await archive.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
    if (identity?.database !== 'funda_mrp_archive' || identity.role !== 'archive_loader') throw new Error('Archive automation lock identity is invalid');
    const [lock] = await archive.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(${AUTOMATION_LOCK}) AS acquired`;
    if (!lock.acquired) return { outcome: 'skipped-locked' as const };
    locked = true;
    await ensureCapacity(config.databaseDataDirectory, config.minimumFreeBytes, false);
    const lastArchiveBackup = await latestVerifiedArchiveBackup(config.archiveBackupDirectory);
    let sourceBackup: string | null = null;
    let candidates: number[] = [];
    let promotion = null;
    let imported: number[] = [];
    let sourceError: unknown;
    try {
      const backups = await listProductionBackups(config.productionBackupDirectory);
      const source = backups[0];
      if (!source) throw new Error('No verified production backup is available');
      sourceBackup = source.manifest.fileName;
      const ageMs = now.getTime() - Date.parse(source.manifest.completedAt);
      if (ageMs < 0 || ageMs > config.maximumSourceAgeHours * 60 * 60 * 1000) throw new Error('Latest production backup is stale');
      const [inventory, covered] = await Promise.all([
        inspectDumpRuns(source.archivePath),
        archive.archiveRunCoverage.findMany({ where: { sourceInstance: config.sourceInstance }, include: { tables: true, source: { include: { source: true } } } }),
      ]);
      if (covered.some(run => {
        const generation = run.source.source.schemaGeneration;
        return run.status !== 'verified' || (generation !== 'G1' && generation !== 'G4') || !hasCompleteTableEvidence(generation, run.tables);
      })) throw new Error('Existing Archive coverage is incomplete');
      if (!inventory.hasStatus) throw new Error('Production backup Run status is unavailable');
      const coveredIds = new Set(covered.map(run => run.sourceRunId));
      candidates = inventory.completedRunIds.filter(id => id >= config.minimumRunId && !coveredIds.has(id));
      if (candidates.length) {
        await ensureCapacity(config.seedDirectory, config.minimumFreeBytes);
        promotion = await promoteDatabaseBackupToSeed(source, config.seedDirectory);
        const batch = await importArchiveBatch(promotion.dumpPath, promotion.manifest.sha256,
          config.sourceInstance, config.minimumRunId, candidates);
        imported = batch.imported;
        if (batch.pending.length || imported.length !== candidates.length) {
          throw new Error('Selected completed Runs did not converge after verified restore');
        }
      }
    } catch (error) {
      sourceError = error;
    }
    const currentCoverage = await currentCoverageFingerprint(archive);
    const backupDue = !lastArchiveBackup ||
      now.getTime() - Date.parse(lastArchiveBackup.verifiedAt) >= config.backupIntervalHours * 60 * 60 * 1000 ||
      JSON.stringify(currentCoverage) !== JSON.stringify(lastArchiveBackup.coverage);
    let archiveBackup = null;
    let backupError: unknown;
    if (backupDue) {
      try {
        await ensureCapacity(config.archiveBackupDirectory, config.minimumFreeBytes);
        archiveBackup = await backupAndVerifyArchive(config.archiveBackupDirectory);
      } catch (error) { backupError = error; }
    }
    if (sourceError || backupError) {
      const messages = [sourceError && `source: ${sourceError instanceof Error ? sourceError.message : 'unknown'}`,
        backupError && `backup: ${backupError instanceof Error ? backupError.message : 'unknown'}`].filter(Boolean);
      throw new Error(`Archive automation failed (${messages.join('; ')})`);
    }
    const rotation = config.backupRotationEnabled ? await rotateArchiveBackups(config.archiveBackupDirectory) : null;
    return { outcome: 'completed' as const, sourceBackup, candidates,
      imported, seed: promotion?.dumpPath ?? null, archiveBackup, rotation };
  } finally {
    if (locked) await archive.$queryRaw`SELECT pg_advisory_unlock(${AUTOMATION_LOCK})`.catch(() => undefined);
    await archive.$disconnect();
  }
}

export async function runAndPersistArchiveAutomation(config = getArchiveAutomationConfig()) {
  const startedAt = new Date();
  try {
    const result = await runArchiveAutomation(config, startedAt);
    await writeAutomationState(config, { version: 1, status: 'completed', startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(), result });
    return result;
  } catch (error) {
    await writeAutomationState(config, { version: 1, status: 'failed', startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Unknown failure' }).catch(() => undefined);
    throw error;
  }
}
