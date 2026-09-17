import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import prisma, { currentDbMode } from './db';
import { withSharedArchiveReader } from './archive-db';

export interface StorageStatus {
  demo?: boolean;
  measuredAt: string;
  databaseMode: string;
  database: { name: string; bytes: number } | null;
  archive: { name: string; bytes: number; verifiedRuns: number } | null;
  files: { label: string; bytes: number | null; files: number | null }[];
  volumes: { label: string; totalBytes: number; freeBytes: number; warning: boolean; critical: boolean }[];
  warnings: string[];
}

export async function measureDirectory(directory: string, limit = 20_000) {
  if (!path.isAbsolute(directory)) throw new Error('Storage path must be absolute');
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const visit = async (target: string): Promise<void> => {
    if (++entries > limit) throw new Error('Storage inventory limit reached');
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Storage inventory contains linked paths');
    if (info.isFile()) { bytes += info.size; files++; return; }
    if (!info.isDirectory()) throw new Error('Storage inventory contains unsupported entries');
    for (const name of await readdir(target)) await visit(path.join(target, name));
  };
  await visit(directory);
  return { bytes, files };
}

export function capacityLevel(freeBytes: number, totalBytes: number) {
  return { critical: freeBytes < 20 * 1024 ** 3, warning: freeBytes < 50 * 1024 ** 3 || freeBytes / totalBytes < 0.15 };
}

export async function measureProductionBackups(directory: string) {
  if (!path.isAbsolute(directory) || (await lstat(directory)).isSymbolicLink()) throw new Error('Invalid backup root');
  let bytes = 0;
  let files = 0;
  const names = await readdir(directory);
  if (names.length > 20_000) throw new Error('Storage inventory limit reached');
  for (const name of names) {
    if (!/^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump(?:\.json|\.sha256)?$/.test(name)) continue;
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid backup file');
    bytes += info.size;
    files++;
  }
  return { bytes, files };
}

async function collectStorageStatus(): Promise<StorageStatus> {
  const result: StorageStatus = { measuredAt: new Date().toISOString(), databaseMode: currentDbMode(),
    database: null, archive: null, files: [], volumes: [], warnings: [] };
  const storageRoot = process.env.ARCHIVE_STORAGE_ROOT?.trim();
  const dataDirectory = process.env.MRP_DATABASE_DATA_DIRECTORY?.trim();
  await Promise.all([
    (async () => {
      try {
        const [row] = await prisma.$queryRaw<Array<{ name: string; bytes: bigint }>>`
          SELECT current_database() AS name, pg_database_size(current_database()) AS bytes`;
        result.database = { name: row.name, bytes: Number(row.bytes) };
      } catch { result.warnings.push('目前資料庫容量無法讀取'); }
    })(),
    (async () => {
      try {
        await withSharedArchiveReader(async reader => {
          const [row] = await reader.$queryRaw<Array<{ bytes: bigint; runs: bigint }>>`
            SELECT pg_database_size(current_database()) AS bytes,
              (SELECT count(*) FROM archive_meta.archive_run_coverage WHERE status='verified') AS runs`;
          result.archive = { name: 'funda_mrp_archive', bytes: Number(row.bytes), verifiedRuns: Number(row.runs) };
        });
      } catch { result.warnings.push('封存庫容量或已驗證版本數無法讀取'); }
    })(),
    (async () => {
      const directories = [
        { label: '正式庫例行備份', directory: process.env.DB_BACKUP_DIRECTORY, production: true },
        { label: '原始封存來源', directory: storageRoot && path.join(storageRoot, 'seeds') },
        { label: '封存庫備份', directory: storageRoot && path.join(storageRoot, 'archive-db-backups') },
      ];
      result.files = await Promise.all(directories.map(async ({ label, directory, production }) => {
        try {
          if (!directory) throw new Error('Not configured');
          return { label, ...await (production ? measureProductionBackups(directory) : measureDirectory(directory)) };
        } catch { result.warnings.push(`${label}占用未取得`); return { label, bytes: null, files: null }; }
      }));
      for (const { label, directory } of [{ label: '資料庫磁碟', directory: dataDirectory }, { label: '封存磁碟', directory: storageRoot }]) {
        try {
          if (!directory || !path.isAbsolute(directory)) throw new Error('Not configured');
          const volume = await statfs(directory, { bigint: true });
          const totalBytes = Number(volume.blocks * volume.bsize);
          const freeBytes = Number(volume.bavail * volume.bsize);
          if (totalBytes <= 0) throw new Error('Unknown filesystem capacity');
          result.volumes.push({ label, totalBytes, freeBytes, ...capacityLevel(freeBytes, totalBytes) });
        } catch { result.warnings.push(`${label}剩餘空間未取得`); }
      }
    })(),
  ]);
  return result;
}

let cached: { key: string; expires: number; value: Promise<StorageStatus> } | undefined;
export function getStorageStatus() {
  const key = JSON.stringify([currentDbMode(), process.env.ARCHIVE_DATABASE_URL, process.env.ARCHIVE_STORAGE_ROOT,
    process.env.MRP_DATABASE_DATA_DIRECTORY, process.env.DB_BACKUP_DIRECTORY]);
  if (!cached || cached.key !== key || cached.expires <= Date.now()) {
    cached = { key, expires: Date.now() + 60_000, value: collectStorageStatus() };
  }
  return cached.value;
}
