interface MaintenanceIndicatorInput {
  source: { ok: boolean; status: string } | null;
  backup: { enabled: boolean; ready: boolean; due: boolean; activeRun: boolean; lastAutomaticResult: { outcome: string } | null };
  retention: { enabled: boolean; archiveGate: { reason: string | null }; lastAutomaticResult: { outcome: string } | null };
}

export function maintenanceIssueCount(data: MaintenanceIndicatorInput | null) {
  if (!data) return 0;
  const source = Boolean(data.source && (!data.source.ok || data.source.status === 'slow'));
  const backup = data.backup.enabled && (!data.backup.ready ||
    ['failed', 'rotation-failed'].includes(data.backup.lastAutomaticResult?.outcome ?? '') ||
    (data.backup.due && !data.backup.activeRun));
  const retention = ['failed', 'partial-failure'].includes(data.retention.lastAutomaticResult?.outcome ?? '') ||
    (data.retention.enabled && ['gate-disabled', 'archive-not-configured', 'source-database-mismatch',
      'archive-unreachable', 'live-snapshot-mismatch'].includes(data.retention.archiveGate.reason ?? ''));
  return Number(source) + Number(backup) + Number(retention);
}
