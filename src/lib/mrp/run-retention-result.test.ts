import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAutomaticRunRetentionResult,
  parseAutomaticRunRetentionResult,
} from './run-retention-result';

const startedAt = new Date('2026-07-29T01:00:00.000Z');
const completedAt = new Date('2026-07-29T01:00:01.250Z');

test('自動 retention 結果區分刪除、無候選與部分失敗', () => {
  assert.equal(
    createAutomaticRunRetentionResult({
      startedAt,
      completedAt,
      candidateIds: [8],
      deletedIds: [8],
    }).outcome,
    'deleted',
  );
  assert.equal(
    createAutomaticRunRetentionResult({
      startedAt,
      completedAt,
    }).outcome,
    'no-candidate',
  );
  assert.equal(
    createAutomaticRunRetentionResult({
      startedAt,
      completedAt,
      candidateIds: [7],
      archiveBlocks: [{
        allowed: false,
        runId: 7,
        reason: 'coverage-missing',
      }],
    }).outcome,
    'archive-blocked',
  );
  assert.equal(
    createAutomaticRunRetentionResult({
      startedAt,
      completedAt,
      candidateIds: [8, 9],
      deletedIds: [8],
      archiveBlocks: [{
        allowed: false,
        runId: 9,
        reason: 'ingest-not-verified',
      }],
    }).outcome,
    'partial-archive-blocked',
  );
  assert.equal(
    createAutomaticRunRetentionResult({
      startedAt,
      completedAt,
      candidateIds: [8, 9],
      deletedIds: [8],
      failureCount: 1,
    }).outcome,
    'partial-failure',
  );
});

test('自動 retention 結果保留固定時間與 duration contract', () => {
  const result = createAutomaticRunRetentionResult({
    startedAt,
    completedAt,
    candidateIds: [8],
    error: 'database unavailable',
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.durationMs, 1250);
  assert.equal(result.startedAt, startedAt.toISOString());
  assert.equal(result.completedAt, completedAt.toISOString());
});

test('損壞的 app_settings retention JSON 不會進入維護狀態', () => {
  assert.equal(parseAutomaticRunRetentionResult({ outcome: 'deleted' }), null);
  assert.equal(
    parseAutomaticRunRetentionResult({
      ...createAutomaticRunRetentionResult({
        startedAt,
        completedAt,
        candidateIds: [8],
        deletedIds: [8],
      }),
      deletedIds: ['8'],
    }),
    null,
  );
  assert.equal(
    parseAutomaticRunRetentionResult({
      ...createAutomaticRunRetentionResult({
        startedAt,
        completedAt,
        candidateIds: [8],
      }),
      archiveBlocks: [{ allowed: false, runId: 8, reason: 'unknown' }],
    }),
    null,
  );
});

test('舊版 retention result 缺少 archiveBlocks 時向後相容為空陣列', () => {
  const current = createAutomaticRunRetentionResult({
    startedAt,
    completedAt,
  });
  const legacy: Record<string, unknown> = { ...current };
  delete legacy.archiveBlocks;

  assert.deepEqual(parseAutomaticRunRetentionResult(legacy)?.archiveBlocks, []);
});
