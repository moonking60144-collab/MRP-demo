import { access } from 'node:fs/promises';
import {
  getDatabaseBackupConfig,
  listVerifiedDatabaseBackups,
  runDatabaseBackup,
  type DatabaseBackupConfig,
  type DatabaseBackupRunResult,
  type RunDatabaseBackupOptions,
  type VerifiedDatabaseBackup,
} from './database-backup';
import {
  createAutomaticDatabaseBackupResult,
  getLastAutomaticDatabaseBackupResult,
  saveLastAutomaticDatabaseBackupResult,
  type AutomaticDatabaseBackupResult,
  type AutomaticDatabaseBackupOutcome,
} from './database-backup-result';

interface DatabaseBackupSchedulerOptions extends RunDatabaseBackupOptions {
  getLastAutomaticResult?: () => Promise<AutomaticDatabaseBackupResult | null>;
  saveAutomaticResult?: (
    result: AutomaticDatabaseBackupResult,
  ) => Promise<void>;
}

export interface DatabaseBackupStatus {
  config: DatabaseBackupConfig;
  latestBackup: VerifiedDatabaseBackup | null;
  lastAutomaticResult: AutomaticDatabaseBackupResult | null;
  due: boolean;
  activeRun: boolean;
  directoryExists: boolean;
  pgDumpExists: boolean;
  pgRestoreExists: boolean;
}

interface DatabaseBackupSchedulerGlobal {
  __databaseBackupInitialTimer?: ReturnType<typeof setTimeout>;
  __databaseBackupInterval?: ReturnType<typeof setInterval>;
  __databaseBackupInFlight?: Promise<void>;
}

const schedulerGlobal =
  globalThis as typeof globalThis & DatabaseBackupSchedulerGlobal;
const INITIAL_CHECK_DELAY_MS = 60_000;

export function isDatabaseBackupDue(
  latestBackup: VerifiedDatabaseBackup | null,
  now: Date,
  intervalHours: number,
): boolean {
  if (!latestBackup) return true;
  return (
    now.getTime() - Date.parse(latestBackup.manifest.completedAt) >=
    intervalHours * 60 * 60 * 1000
  );
}

export async function getDatabaseBackupStatus(
  options: DatabaseBackupSchedulerOptions = {},
): Promise<DatabaseBackupStatus> {
  const config =
    options.config ?? getDatabaseBackupConfig(options.env ?? process.env);
  const now = options.now?.() ?? new Date();
  const exists = async (targetPath: string): Promise<boolean> => {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  };
  const [
    backups,
    lastAutomaticResult,
    activeRun,
    directoryExists,
    pgDumpExists,
    pgRestoreExists,
  ] = await Promise.all([
      listVerifiedDatabaseBackups(config.directory),
      options.getLastAutomaticResult
        ? options.getLastAutomaticResult()
        : getLastAutomaticDatabaseBackupResult(),
      options.isActiveRun ? options.isActiveRun() : Promise.resolve(false),
      exists(config.directory),
      exists(config.pgDumpPath),
      exists(config.pgRestorePath),
    ]);
  const latestBackup = backups[0] ?? null;

  return {
    config,
    latestBackup,
    lastAutomaticResult,
    due: isDatabaseBackupDue(latestBackup, now, config.intervalHours),
    activeRun,
    directoryExists,
    pgDumpExists,
    pgRestoreExists,
  };
}

function automaticOutcome(
  result: DatabaseBackupRunResult,
): AutomaticDatabaseBackupOutcome {
  if (result.status === 'skipped_active_run') return 'skipped-active-run';
  if (result.status === 'skipped_locked') return 'skipped-locked';
  return result.cleanupError ? 'rotation-failed' : 'completed';
}

async function persistAutomaticResult(
  result: AutomaticDatabaseBackupResult,
  options: DatabaseBackupSchedulerOptions,
): Promise<void> {
  try {
    await (options.saveAutomaticResult ?? saveLastAutomaticDatabaseBackupResult)(
      result,
    );
  } catch (error) {
    console.error(
      '[DatabaseBackup] Could not persist scheduled backup result:',
      error,
    );
  }
}

function logScheduledResult(result: DatabaseBackupRunResult): void {
  if (result.status === 'completed') {
    console.info(
      `[DatabaseBackup] Completed ${result.backup.manifest.fileName} ` +
        `(${result.backup.manifest.sizeBytes} bytes, ` +
        `${result.backup.manifest.durationMs}ms)`,
    );
    if (result.deletedBackupFileNames.length > 0) {
      console.info(
        `[DatabaseBackup] Removed expired backup(s): ` +
          result.deletedBackupFileNames.join(', '),
      );
    }
    if (result.cleanupError) {
      console.error(
        `[DatabaseBackup] Backup succeeded but rotation failed: ` +
          result.cleanupError,
      );
    }
    return;
  }
  if (result.status === 'skipped_active_run') {
    console.info('[DatabaseBackup] Skipped because an MRP Run is active');
    return;
  }
  console.info('[DatabaseBackup] Skipped because another backup owns the lock');
}

export async function runScheduledDatabaseBackupCheck(
  options: DatabaseBackupSchedulerOptions = {},
): Promise<void> {
  if (schedulerGlobal.__databaseBackupInFlight) {
    return;
  }

  const task = (async () => {
    const config =
      options.config ?? getDatabaseBackupConfig(options.env ?? process.env);
    if (!config.enabled) return;
    const startedAt = options.now?.() ?? new Date();
    try {
      const backups = await listVerifiedDatabaseBackups(config.directory);
      if (
        !isDatabaseBackupDue(
          backups[0] ?? null,
          startedAt,
          config.intervalHours,
        )
      ) {
        return;
      }
      const result = await runDatabaseBackup({ ...options, config });
      logScheduledResult(result);
      const completedAt = options.now?.() ?? new Date();
      const publishedBackup =
        result.status === 'completed' ? result.backup.manifest : null;
      await persistAutomaticResult(
        createAutomaticDatabaseBackupResult({
          outcome: automaticOutcome(result),
          startedAt,
          completedAt,
          fileName: publishedBackup?.fileName,
          sizeBytes: publishedBackup?.sizeBytes,
        }),
        options,
      );
    } catch (error) {
      console.error('[DatabaseBackup] Scheduled backup failed:', error);
      await persistAutomaticResult(
        createAutomaticDatabaseBackupResult({
          outcome: 'failed',
          startedAt,
          completedAt: options.now?.() ?? new Date(),
        }),
        options,
      );
    }
  })();
  schedulerGlobal.__databaseBackupInFlight = task;

  try {
    await task;
  } finally {
    schedulerGlobal.__databaseBackupInFlight = undefined;
  }
}

export function startDatabaseBackupScheduler(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const config = getDatabaseBackupConfig();
  if (
    !config.enabled ||
    schedulerGlobal.__databaseBackupInitialTimer ||
    schedulerGlobal.__databaseBackupInterval
  ) {
    return;
  }

  schedulerGlobal.__databaseBackupInitialTimer = setTimeout(() => {
    schedulerGlobal.__databaseBackupInitialTimer = undefined;
    void runScheduledDatabaseBackupCheck();
  }, INITIAL_CHECK_DELAY_MS);
  schedulerGlobal.__databaseBackupInitialTimer.unref?.();

  schedulerGlobal.__databaseBackupInterval = setInterval(() => {
    void runScheduledDatabaseBackupCheck();
  }, config.checkIntervalMinutes * 60 * 1000);
  schedulerGlobal.__databaseBackupInterval.unref?.();
}
