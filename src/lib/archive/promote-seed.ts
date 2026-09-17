import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { inspectDumpRuns } from './dump-inventory';
import { verifyArchiveSeed, type ArchiveSeedManifest } from './seed-manifest';

async function sha256File(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export interface ProductionBackupSource {
  archivePath: string;
  manifestPath: string;
  sha256Path: string;
  manifest: { fileName: string; sizeBytes: number; sha256: string; startedAt: string; completedAt: string; durationMs: number };
}

export async function promoteDatabaseBackupToSeed(backup: ProductionBackupSource, seedRoot: string) {
  if (!path.isAbsolute(seedRoot)) throw new Error('Archive seed directory must be absolute');
  const sourceBefore = await stat(backup.archivePath);
  const sha256 = backup.manifest.sha256.toLowerCase();
  if (!sourceBefore.isFile() || sourceBefore.size !== backup.manifest.sizeBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Production backup identity is invalid');
  }
  const inventory = await inspectDumpRuns(backup.archivePath);
  const generation = inventory.hasOrderDemandContract ? 'G4' : 'G1';
  const timestamp = backup.manifest.completedAt.replace(/[-:TZ.]/g, '').slice(0, 17);
  const finalDirectory = path.join(seedRoot, `auto-${timestamp}-${sha256.slice(0, 12)}-${generation}`);
  const dumpPath = path.join(finalDirectory, 'seed.dump');
  try {
    const existing = await verifyArchiveSeed(dumpPath);
    if (existing.manifest.sha256 !== sha256 || existing.manifest.sourceFileName !== backup.manifest.fileName) {
      throw new Error('Existing permanent seed conflicts with production backup');
    }
    return { outcome: 'already-promoted' as const, dumpPath, manifest: existing.manifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(seedRoot, { recursive: true });
  const partialDirectory = `${finalDirectory}.partial-${randomUUID()}`;
  await mkdir(partialDirectory);
  const partialDump = path.join(partialDirectory, 'seed.dump');
  await copyFile(backup.archivePath, partialDump, constants.COPYFILE_EXCL);
  const [sourceAfter, copied, observedSha] = await Promise.all([
    stat(backup.archivePath), stat(partialDump), sha256File(partialDump),
  ]);
  if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeMs !== sourceBefore.mtimeMs ||
      sourceAfter.ctimeMs !== sourceBefore.ctimeMs || sourceAfter.ino !== sourceBefore.ino ||
      copied.size !== backup.manifest.sizeBytes || observedSha !== sha256) {
    throw new Error('Production backup changed or failed hash verification during promotion');
  }
  const handle = await open(partialDump, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  const manifest: ArchiveSeedManifest = {
    manifestVersion: 1, kind: 'funda-mrp-archive-seed', seedFileName: 'seed.dump',
    sourceFileName: backup.manifest.fileName, schemaGeneration: generation,
    sha256, sizeBytes: copied.size, createdAt: backup.manifest.completedAt,
    runCoverage: { count: inventory.runIds.length, minRunId: inventory.runIds[0],
      maxRunId: inventory.runIds[inventory.runIds.length - 1], runIds: inventory.runIds },
  };
  await Promise.all([
    writeFile(path.join(partialDirectory, 'seed.archive.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }),
    writeFile(path.join(partialDirectory, 'seed.sha256'), `${sha256}  seed.dump\n`, { flag: 'wx' }),
  ]);
  await verifyArchiveSeed(partialDump);
  await rename(partialDirectory, finalDirectory);
  const verified = await verifyArchiveSeed(dumpPath);
  return { outcome: 'promoted' as const, dumpPath, manifest: verified.manifest };
}
