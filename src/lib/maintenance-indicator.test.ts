import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceIssueCount } from './maintenance-indicator';

const healthy = () => ({ source: { ok: true, status: 'healthy' },
  backup: { enabled: true, ready: true, due: false, activeRun: false, lastAutomaticResult: null },
  retention: { enabled: true, archiveGate: { reason: null as string | null }, lastAutomaticResult: null } });

test('indicator does not hide slow Source or invalid archive source', () => {
  const data = healthy();
  assert.equal(maintenanceIssueCount(data), 0);
  data.source.status = 'slow';
  assert.equal(maintenanceIssueCount(data), 1, 'SLOW_MUST_BE_VISIBLE');
  data.retention.archiveGate.reason = 'source-database-mismatch';
  assert.equal(maintenanceIssueCount(data), 2, 'ARCHIVE_SOURCE_MISMATCH_MUST_BE_VISIBLE');
});

test('normal waiting for archive and busy backup are not operational failures', () => {
  const data = healthy();
  data.retention.archiveGate.reason = 'coverage-missing';
  data.backup.due = true;
  data.backup.activeRun = true;
  assert.equal(maintenanceIssueCount(data), 0);
  data.backup.activeRun = false;
  assert.equal(maintenanceIssueCount(data), 1);
});
