import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import prisma from './db';
import { ACTIVE_STATUSES } from './mrp/run-status';

export interface DatabaseBackupConfig {
  enabled: boolean;
  directory: string;
  intervalHours: number;
  checkIntervalMinutes: number;
  retentionDays: number;
  minimumBackups: number;
  timeoutMinutes: number;
  pgDumpPath: string;
  pgRestorePath: string;
}

export interface DatabaseBackupManifest {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface VerifiedDatabaseBackup {
  archivePath: string;
  manifestPath: string;
  sha256Path: string;
  manifest: DatabaseBackupManifest;
}

export type DatabaseBackupRunResult =
  | { status: 'skipped_active_run' }
  | { status: 'skipped_locked' }
  | {
      status: 'completed';
      backup: VerifiedDatabaseBackup;
      deletedBackupFileNames: string[];
      cleanupError?: string;
    };

export type DatabaseBackupCliMode = 'dry-run' | 'status' | 'execute';

type BackupEnv = Record<string, string | undefined>;

export interface BackupCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type BackupCommandRunner = (
  command: string,
  args: string[],
  options: BackupCommandOptions,
) => Promise<void>;

export interface RunDatabaseBackupOptions {
  config?: DatabaseBackupConfig;
  env?: BackupEnv;
  now?: () => Date;
  isActiveRun?: () => Promise<boolean>;
  runCommand?: BackupCommandRunner;
}

const DEFAULT_BACKUP_DIRECTORY = 'E:\\backup\\funda-mrp-postgres';
const DEFAULT_PG_DUMP_PATH =
  'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe';
const DEFAULT_PG_RESTORE_PATH =
  'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe';
const AUTO_BACKUP_PATTERN =
  /^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump$/;
const AUTO_BACKUP_PARTIAL_PATTERN =
  /^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump\.partial$/;
const LOCK_FILE_NAME = '.funda-mrp-backup.lock';

function positiveInt(
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function getDatabaseBackupConfig(
  env: BackupEnv = process.env,
): DatabaseBackupConfig {
  return {
    enabled: isEnabled(env.DB_BACKUP_ENABLED),
    directory:
      env.DB_BACKUP_DIRECTORY?.trim() || DEFAULT_BACKUP_DIRECTORY,
    intervalHours: positiveInt(env.DB_BACKUP_INTERVAL_HOURS, 24, 24 * 30),
    checkIntervalMinutes: positiveInt(
      env.DB_BACKUP_CHECK_INTERVAL_MINUTES,
      30,
      24 * 60,
    ),
    retentionDays: positiveInt(env.DB_BACKUP_RETENTION_DAYS, 30, 3650),
    minimumBackups: positiveInt(env.DB_BACKUP_MINIMUM_BACKUPS, 3, 100),
    timeoutMinutes: positiveInt(env.DB_BACKUP_TIMEOUT_MINUTES, 30, 24 * 60),
    pgDumpPath:
      env.DB_BACKUP_PG_DUMP_PATH?.trim() || DEFAULT_PG_DUMP_PATH,
    pgRestorePath:
      env.DB_BACKUP_PG_RESTORE_PATH?.trim() || DEFAULT_PG_RESTORE_PATH,
  };
}

export function parseDatabaseBackupCliMode(
  args: string[],
): DatabaseBackupCliMode {
  const allowed = new Set(['--dry-run', '--status', '--execute']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`不支援的參數: ${unknown.join(', ')}`);
  }
  if (args.length > 1) {
    throw new Error('--dry-run、--status 與 --execute 不可同時使用');
  }
  if (args.includes('--execute')) return 'execute';
  if (args.includes('--status')) return 'status';
  return 'dry-run';
}

function resolveDatabaseUrl(env: BackupEnv): string {
  const mode = (env.DB_MODE || 'local').trim().toUpperCase();
  const modeUrl = ['LOCAL', 'DOCKER', 'REMOTE'].includes(mode)
    ? env[`DATABASE_URL_${mode}`]
    : undefined;
  return modeUrl || env.DATABASE_URL || '';
}

export function buildPgDumpInvocation(
  databaseUrl: string,
  partialPath: string,
  env: BackupEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!databaseUrl.trim()) {
    throw new Error('DATABASE_URL is empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use postgres: or postgresql:');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const username = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !databaseName || !username) {
    throw new Error('DATABASE_URL must include host, username and database');
  }

  const childEnv = { ...env } as NodeJS.ProcessEnv;
  for (const key of Object.keys(childEnv)) {
    if (key === 'DATABASE_URL' || key.startsWith('DATABASE_URL_')) {
      delete childEnv[key];
    }
  }
  childEnv.PGPASSWORD = decodeURIComponent(parsed.password);
  childEnv.PGAPPNAME = 'funda-mrp-backup';
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode) childEnv.PGSSLMODE = sslMode;

  return {
    args: [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      `--file=${partialPath}`,
      `--host=${parsed.hostname}`,
      `--port=${parsed.port || '5432'}`,
      `--username=${username}`,
      `--dbname=${databaseName}`,
    ],
    env: childEnv,
  };
}

export async function runBackupCommand(
  command: string,
  args: string[],
  options: BackupCommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          `${path.basename(command)} failed (code=${String(code)}, signal=${String(signal)})` +
            (detail ? `: ${detail}` : ''),
        ),
      );
    });
  });
}

function formatBackupTimestamp(value: Date): string {
  const pad = (part: number, width = 2) =>
    String(part).padStart(width, '0');
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    '_',
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
    '_',
    pad(value.getMilliseconds(), 3),
  ].join('');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleDatabaseBackupPartials(
  directory: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && AUTO_BACKUP_PARTIAL_PATTERN.test(entry.name),
      )
      .map((entry) => unlink(path.join(directory, entry.name))),
  );
}

function validateBackupDirectory(directory: string): void {
  const posixAbsolute = path.isAbsolute(directory);
  const windowsAbsolute = path.win32.isAbsolute(directory);
  if (!posixAbsolute && !windowsAbsolute) {
    throw new Error('DB_BACKUP_DIRECTORY must be an absolute path');
  }
  if (process.platform !== 'win32' && windowsAbsolute && !posixAbsolute) {
    throw new Error('Windows DB_BACKUP_DIRECTORY cannot execute on this platform');
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex').toUpperCase();
}

async function isActiveMrpRun(): Promise<boolean> {
  return Boolean(
    await prisma.mrpRun.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true },
    }),
  );
}

async function isBackupLockOwnerAlive(lockPath: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!value || typeof value !== 'object') return false;
    const lock = value as Record<string, unknown>;
    if (lock.host !== hostname() || !Number.isInteger(lock.pid)) return false;
    const pid = lock.pid as number;
    if (pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrnoException(error) && error.code === 'EPERM';
    }
  } catch {
    return false;
  }
}

async function acquireBackupLock(
  directory: string,
  timeoutMs: number,
  now: Date,
): Promise<(() => Promise<void>) | null> {
  const lockPath = path.join(directory, LOCK_FILE_NAME);
  const staleAfterMs = timeoutMs * 2;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify(
            {
              pid: process.pid,
              host: hostname(),
              startedAt: now.toISOString(),
            },
            null,
            2,
          ),
          'utf8',
        );
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }

      return async () => {
        await handle.close();
        await unlink(lockPath);
      };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (statError) {
        if (isErrnoException(statError) && statError.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (
        now.getTime() - lockStat.mtimeMs <= staleAfterMs ||
        await isBackupLockOwnerAlive(lockPath)
      ) {
        return null;
      }

      const stalePath = `${lockPath}.stale-${now.getTime()}-${process.pid}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath);
      } catch (renameError) {
        if (
          isErrnoException(renameError) &&
          ['ENOENT', 'EEXIST'].includes(renameError.code ?? '')
        ) {
          continue;
        }
        throw renameError;
      }
    }
  }
  return null;
}

function isDatabaseBackupManifest(
  value: unknown,
): value is DatabaseBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Record<string, unknown>;
  return (
    typeof manifest.fileName === 'string' &&
    AUTO_BACKUP_PATTERN.test(manifest.fileName) &&
    typeof manifest.sizeBytes === 'number' &&
    Number.isSafeInteger(manifest.sizeBytes) &&
    manifest.sizeBytes > 0 &&
    typeof manifest.sha256 === 'string' &&
    /^[A-F0-9]{64}$/.test(manifest.sha256) &&
    typeof manifest.startedAt === 'string' &&
    Number.isFinite(Date.parse(manifest.startedAt)) &&
    typeof manifest.completedAt === 'string' &&
    Number.isFinite(Date.parse(manifest.completedAt)) &&
    typeof manifest.durationMs === 'number' &&
    Number.isFinite(manifest.durationMs) &&
    manifest.durationMs >= 0
  );
}

export async function listVerifiedDatabaseBackups(
  directory: string,
): Promise<VerifiedDatabaseBackup[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const verified = await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && AUTO_BACKUP_PATTERN.test(entry.name),
      )
      .map(async (entry): Promise<VerifiedDatabaseBackup | null> => {
        const archivePath = path.join(directory, entry.name);
        const manifestPath = `${archivePath}.json`;
        const sha256Path = `${archivePath}.sha256`;
        if (
          !(await pathExists(manifestPath)) ||
          !(await pathExists(sha256Path))
        ) {
          return null;
        }
        try {
          const [archiveStat, manifestText, sha256Text] = await Promise.all([
            stat(archivePath),
            readFile(manifestPath, 'utf8'),
            readFile(sha256Path, 'utf8'),
          ]);
          const manifest: unknown = JSON.parse(manifestText);
          if (
            !isDatabaseBackupManifest(manifest) ||
            manifest.fileName !== entry.name ||
            manifest.sizeBytes !== archiveStat.size
          ) {
            return null;
          }
          const [sidecarHash, sidecarFileName] = sha256Text.trim().split(/\s+/);
          if (
            sidecarHash !== manifest.sha256 ||
            sidecarFileName !== entry.name
          ) {
            return null;
          }
          return { archivePath, manifestPath, sha256Path, manifest };
        } catch {
          return null;
        }
      }),
  );

  return verified
    .filter((backup): backup is VerifiedDatabaseBackup => backup !== null)
    .sort(
      (a, b) =>
        Date.parse(b.manifest.completedAt) -
        Date.parse(a.manifest.completedAt),
    );
}

export async function removeExpiredDatabaseBackups(
  config: DatabaseBackupConfig,
  now = new Date(),
): Promise<string[]> {
  const backups = await listVerifiedDatabaseBackups(config.directory);
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000;
  const expired = backups.filter(
    (backup, index) =>
      index >= config.minimumBackups &&
      Date.parse(backup.manifest.completedAt) < cutoff,
  );

  for (const backup of expired) {
    await Promise.all([
      unlink(backup.archivePath),
      unlink(backup.manifestPath),
      unlink(backup.sha256Path),
    ]);
  }
  return expired.map((backup) => backup.manifest.fileName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDatabaseBackup(
  options: RunDatabaseBackupOptions = {},
): Promise<DatabaseBackupRunResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? getDatabaseBackupConfig(env);
  const now = options.now ?? (() => new Date());
  const activeRun = options.isActiveRun ?? isActiveMrpRun;
  const commandRunner = options.runCommand ?? runBackupCommand;
  const timeoutMs = config.timeoutMinutes * 60 * 1000;

  validateBackupDirectory(config.directory);
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl.trim()) throw new Error('DATABASE_URL is empty');
  if (await activeRun()) return { status: 'skipped_active_run' };

  await mkdir(config.directory, { recursive: true });
  const startedAt = now();
  const releaseLock = await acquireBackupLock(
    config.directory,
    timeoutMs,
    startedAt,
  );
  if (!releaseLock) return { status: 'skipped_locked' };

  try {
    if (await activeRun()) return { status: 'skipped_active_run' };
    await removeStaleDatabaseBackupPartials(config.directory);

    const fileName =
      `funda_mrp_auto_${formatBackupTimestamp(startedAt)}.dump`;
    const archivePath = path.join(config.directory, fileName);
    const partialPath = `${archivePath}.partial`;
    const sha256Path = `${archivePath}.sha256`;
    const manifestPath = `${archivePath}.json`;
    const sha256PartialPath = `${sha256Path}.partial`;
    const manifestPartialPath = `${manifestPath}.partial`;
    const invocation = buildPgDumpInvocation(databaseUrl, partialPath, env);

    await commandRunner(config.pgDumpPath, invocation.args, {
      env: invocation.env,
      timeoutMs,
    });
    const partialStat = await stat(partialPath);
    if (partialStat.size < 1) {
      throw new Error('pg_dump returned success but the archive is empty');
    }

    await commandRunner(
      config.pgRestorePath,
      ['--list', partialPath],
      { env: invocation.env, timeoutMs },
    );
    const sha256 = await sha256File(partialPath);
    const completedAt = now();
    const manifest: DatabaseBackupManifest = {
      fileName,
      sizeBytes: partialStat.size,
      sha256,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    };

    await Promise.all([
      writeFile(
        sha256PartialPath,
        `${sha256}  ${fileName}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
      writeFile(
        manifestPartialPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
    ]);
    await rename(sha256PartialPath, sha256Path);
    await rename(manifestPartialPath, manifestPath);
    await rename(partialPath, archivePath);

    const backup: VerifiedDatabaseBackup = {
      archivePath,
      manifestPath,
      sha256Path,
      manifest,
    };
    let deletedBackupFileNames: string[] = [];
    let cleanupError: string | undefined;
    try {
      deletedBackupFileNames = await removeExpiredDatabaseBackups(
        config,
        completedAt,
      );
    } catch (error) {
      cleanupError = errorMessage(error);
    }

    return {
      status: 'completed',
      backup,
      deletedBackupFileNames,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } finally {
    await releaseLock();
  }
}
