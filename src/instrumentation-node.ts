import { startDatabaseBackupScheduler } from './lib/database-backup-scheduler';

export function registerNodeInstrumentation(): void {
  startDatabaseBackupScheduler();
}
