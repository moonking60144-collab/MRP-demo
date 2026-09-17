import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAutomaticDatabaseBackupResult,
  parseAutomaticDatabaseBackupResult,
} from './database-backup-result';

const startedAt = new Date('2026-07-30T01:00:00.000Z');
const completedAt = new Date('2026-07-30T01:00:02.500Z');

test('自動備份結果記錄成功、跳過與失敗，不保存連線錯誤內容', () => {
  assert.deepEqual(
    createAutomaticDatabaseBackupResult({
      outcome: 'completed',
      startedAt,
      completedAt,
      fileName: 'funda_mrp_auto_20260730_090000_000.dump',
      sizeBytes: 1234,
    }),
    {
      outcome: 'completed',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: 2500,
      fileName: 'funda_mrp_auto_20260730_090000_000.dump',
      sizeBytes: 1234,
    },
  );
  assert.equal(
    createAutomaticDatabaseBackupResult({
      outcome: 'skipped-active-run',
      startedAt,
      completedAt,
    }).outcome,
    'skipped-active-run',
  );
  assert.equal(
    createAutomaticDatabaseBackupResult({
      outcome: 'failed',
      startedAt,
      completedAt,
    }).outcome,
    'failed',
  );
});

test('損壞的 app_settings backup JSON 不會進入維護狀態', () => {
  const valid = createAutomaticDatabaseBackupResult({
    outcome: 'rotation-failed',
    startedAt,
    completedAt,
    fileName: 'funda_mrp_auto_20260730_090000_000.dump',
    sizeBytes: 1234,
  });

  assert.deepEqual(parseAutomaticDatabaseBackupResult(valid), valid);
  assert.equal(
    parseAutomaticDatabaseBackupResult({ ...valid, durationMs: -1 }),
    null,
  );
  assert.equal(
    parseAutomaticDatabaseBackupResult({
      ...valid,
      fileName: 'E:\\backup\\secret.dump',
    }),
    null,
  );
  assert.equal(
    parseAutomaticDatabaseBackupResult({
      ...valid,
      connectionError: 'postgresql://user:password@server/database',
    }),
    null,
  );
});
