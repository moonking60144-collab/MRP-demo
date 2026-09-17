interface MaintenanceIndicatorInput {
  ragic: { ok: boolean; status: string } | null;
  backup: { enabled: boolean; ready: boolean; due: boolean; activeRun: boolean; lastAutomaticResult: { outcome: string } | null };
  retention: { enabled: boolean; archiveGate: { reason: string | null }; lastAutomaticResult: { outcome: string } | null };
}

export function maintenanceIssueCount(data: MaintenanceIndicatorInput | null) {
  if (!data) return 0;
  const ragic = Boolean(data.ragic && (!data.ragic.ok || data.ragic.status === 'slow'));
  const backup = data.backup.enabled && (!data.backup.ready ||
    ['failed', 'rotation-failed'].includes(data.backup.lastAutomaticResult?.outcome ?? '') ||
    (data.backup.due && !data.backup.activeRun));
  const retention = ['failed', 'partial-failure'].includes(data.retention.lastAutomaticResult?.outcome ?? '') ||
    (data.retention.enabled && ['gate-disabled', 'archive-not-configured', 'source-database-mismatch',
      'archive-unreachable', 'live-snapshot-mismatch'].includes(data.retention.archiveGate.reason ?? ''));
  return Number(ragic) + Number(backup) + Number(retention);
}
