import prisma from './db';
import { getDatabaseBackupStatus } from './database-backup-scheduler';
import { getRunRetentionStatus } from './mrp/run-retention-status';
import { ACTIVE_STATUSES } from './mrp/run-status';
import { getRagicHealthSnapshot } from './ragic-health';

export async function getMaintenanceStatus() {
  const activeRun = Boolean(
    await prisma.mrpRun.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true },
    }),
  );
  const [backup, retention, ragic] = await Promise.all([
    getDatabaseBackupStatus({ isActiveRun: async () => activeRun }),
    getRunRetentionStatus({ activeRun }),
    getRagicHealthSnapshot(),
  ]);

  return {
    ragic,
    backup: {
      enabled: backup.config.enabled,
      ready:
        backup.directoryExists &&
        backup.pgDumpExists &&
        backup.pgRestoreExists,
      due: backup.due,
      activeRun: backup.activeRun,
      intervalHours: backup.config.intervalHours,
      retentionDays: backup.config.retentionDays,
      minimumBackups: backup.config.minimumBackups,
      lastAutomaticResult: backup.lastAutomaticResult
        ? {
            outcome: backup.lastAutomaticResult.outcome,
            startedAt: backup.lastAutomaticResult.startedAt,
            completedAt: backup.lastAutomaticResult.completedAt,
            durationMs: backup.lastAutomaticResult.durationMs,
            fileName: backup.lastAutomaticResult.fileName,
            sizeBytes: backup.lastAutomaticResult.sizeBytes,
          }
        : null,
      latestBackup: backup.latestBackup
        ? {
            completedAt: backup.latestBackup.manifest.completedAt,
            durationMs: backup.latestBackup.manifest.durationMs,
            sizeBytes: backup.latestBackup.manifest.sizeBytes,
          }
        : null,
    },
    retention: {
      enabled: retention.config.enabled,
      activeRun: retention.activeRun,
      retentionDays: retention.config.retentionDays,
      minimumCompletedRuns: retention.config.minimumCompletedRuns,
      batchSize: retention.config.batchSize,
      completedRunCount: retention.completedRunCount,
      eligibleRunCount: retention.eligibleRunCount,
      blockedRunCount: retention.blockedRunCount,
      nextEligibleRunId: retention.nextEligibleRunId,
      nextCoverageReadyRunId: retention.nextCoverageReadyRunId,
      archiveGate: retention.archiveGate,
      lastAutomaticResult: retention.lastAutomaticResult
        ? {
            outcome: retention.lastAutomaticResult.outcome,
            candidateIds: retention.lastAutomaticResult.candidateIds,
            deletedIds: retention.lastAutomaticResult.deletedIds,
            archiveBlocks: retention.lastAutomaticResult.archiveBlocks,
            failureCount: retention.lastAutomaticResult.failureCount,
            startedAt: retention.lastAutomaticResult.startedAt,
            completedAt: retention.lastAutomaticResult.completedAt,
            durationMs: retention.lastAutomaticResult.durationMs,
          }
        : null,
    },
  };
}

export type MaintenanceStatus = Awaited<ReturnType<typeof getMaintenanceStatus>>;
