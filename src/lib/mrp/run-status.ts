export const MRP_RUN_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  CALCULATING: 'calculating',
  COMPLETED: 'completed',
  ERROR: 'error',
  STOPPED: 'stopped',
} as const;

export type MrpRunStatus = typeof MRP_RUN_STATUS[keyof typeof MRP_RUN_STATUS];

export const ACTIVE_STATUSES: MrpRunStatus[] = [
  MRP_RUN_STATUS.PENDING,
  MRP_RUN_STATUS.SYNCING,
  MRP_RUN_STATUS.SYNCED,
  MRP_RUN_STATUS.CALCULATING,
];

export const FINAL_STATUSES: MrpRunStatus[] = [
  MRP_RUN_STATUS.COMPLETED,
  MRP_RUN_STATUS.ERROR,
  MRP_RUN_STATUS.STOPPED,
];

export const STOP_REASON = {
  USER_STOP: 'Stopped by user',
  FORCE_RESET: 'Force-reset by user',
  STALE_CLEANUP: (mins: number) =>
    `Cleared as stale (stuck for >${mins} min)`,
  STARTUP_ORPHANED:
    'Server restarted while this run was in progress (orphaned by PM2 reload / process restart). ' +
    'The Node process was killed before the sync could complete — see Detail Logs for last activity.',
  SHUTDOWN_SIGNAL: (signal: string) =>
    `Server received ${signal} during run (likely PM2 reload). The sync was killed mid-call.`,
} as const;
