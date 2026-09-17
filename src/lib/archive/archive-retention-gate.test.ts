import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archiveRetentionGate,
  createArchiveRetentionGate,
  createArchiveRetentionPreflight,
  getArchiveRetentionGateStatus,
  isArchiveRetentionDenialReason,
  type ArchiveRetentionLiveSnapshotReader,
} from './archive-retention-gate';
import { ARCHIVE_RUN_TABLES } from './coverage';

const configuredEnv = {
  MRP_RUN_ARCHIVE_GATE_ENABLED: 'true',
  MRP_RUN_ARCHIVE_SOURCE_INSTANCE: 'fixture-server',
  MRP_RUN_ARCHIVE_SOURCE_DB_MODE: 'local',
  ARCHIVE_DATABASE_URL: 'postgresql://archive_reader@127.0.0.1/funda_mrp_archive',
};
const live = {} as ArchiveRetentionLiveSnapshotReader;

function verifiedCoverage() {
  const digest = 'a'.repeat(64);
  return {
    sourceInstance: 'fixture-server', sourceRunId: 217, sourceSha256: digest,
    sourceStatus: 'completed', status: 'verified', verifiedAt: new Date('2026-09-08T01:00:00Z'),
    attempt: { status: 'verified', completedAt: new Date('2026-09-08T01:00:00Z') },
    source: {
      sourceSha256: digest, sourceInstance: 'fixture-server',
      source: { sha256: digest, sourceInstance: 'fixture-server', schemaGeneration: 'G4',
        hashVerifiedAt: new Date('2026-09-08T00:00:00Z') },
    },
    tables: ARCHIVE_RUN_TABLES.map(tableName => ({
      tableName, status: 'verified', sourcePresent: true, sourceRows: BigInt(1), archiveRows: BigInt(1),
      sourceDigest: digest, archiveDigest: digest, verifiedAt: new Date('2026-09-08T01:00:00Z'),
    })),
  };
}

test('Archive retention gate 缺少或未知設定時維持 fail-closed', () => {
  assert.deepEqual(getArchiveRetentionGateStatus({}), {
    enabled: false,
    coverageReady: false,
    reason: 'gate-disabled',
  });
  assert.deepEqual(
    getArchiveRetentionGateStatus({ MRP_RUN_ARCHIVE_GATE_ENABLED: 'unexpected' }),
    { enabled: false, coverageReady: false, reason: 'gate-disabled' },
  );
});

test('Archive reader 尚未建立時即使啟用設定也不得放行', () => {
  for (const value of ['1', 'true', 'on', ' TRUE ']) {
    assert.deepEqual(
      getArchiveRetentionGateStatus({ MRP_RUN_ARCHIVE_GATE_ENABLED: value }),
      { enabled: true, coverageReady: false, reason: 'archive-not-configured' },
    );
  }
  assert.deepEqual(getArchiveRetentionGateStatus({
    ...configuredEnv,
    MRP_RUN_ARCHIVE_SOURCE_INSTANCE: ' fixture-server ',
  }), { enabled: true, coverageReady: false, reason: 'archive-not-configured' });
  assert.deepEqual(getArchiveRetentionGateStatus({
    ...configuredEnv,
    ARCHIVE_DATABASE_URL: 'postgresql://archive_loader@127.0.0.1/funda_mrp_archive',
  }), { enabled: true, coverageReady: false, reason: 'archive-not-configured' });
});

test('完整設定只代表可以查詢，實際放行仍要求 verified coverage', () => {
  assert.deepEqual(getArchiveRetentionGateStatus(configuredEnv), {
    enabled: true,
    coverageReady: false,
    reason: null,
  });
});

test('Archive gate 只允許封存來源對應的 live DB mode', () => {
  assert.deepEqual(getArchiveRetentionGateStatus({
    ...configuredEnv,
    MRP_RUN_ARCHIVE_SOURCE_DB_MODE: 'remote',
  }), {
    enabled: true,
    coverageReady: false,
    reason: 'source-database-mismatch',
  });
});

test('預設關閉的 Archive gate 不查詢且回傳帶 Run identity 的拒絕結果', async () => {
  const previous = process.env.MRP_RUN_ARCHIVE_GATE_ENABLED;
  delete process.env.MRP_RUN_ARCHIVE_GATE_ENABLED;
  try {
    assert.deepEqual(await archiveRetentionGate(217, live), {
      allowed: false,
      runId: 217,
      reason: 'gate-disabled',
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MRP_RUN_ARCHIVE_GATE_ENABLED;
    } else {
      process.env.MRP_RUN_ARCHIVE_GATE_ENABLED = previous;
    }
  }
});

test('Archive gate 只放行固定來源且完整驗證的 completed Run', async () => {
  const calls: Array<[string, number]> = [];
  const gate = createArchiveRetentionGate(async (sourceInstance, runId) => {
    calls.push([sourceInstance, runId]);
    return verifiedCoverage();
  }, configuredEnv, async () => true);
  assert.deepEqual(await gate(217, live), {
    allowed: true,
    runId: 217,
    verifiedAt: '2026-09-08T01:00:00.000Z',
  });
  assert.deepEqual(calls, [['fixture-server', 217]]);
});

test('Archive preflight 只驗證 coverage，完整 live snapshot 仍由 transaction gate 驗證', async () => {
  const preflight = createArchiveRetentionPreflight(
    async () => verifiedCoverage(),
    configuredEnv,
  );
  assert.deepEqual(await preflight(217), {
    allowed: true,
    runId: 217,
    verifiedAt: '2026-09-08T01:00:00.000Z',
  });

  const gate = createArchiveRetentionGate(
    async () => verifiedCoverage(),
    configuredEnv,
    async () => false,
  );
  assert.deepEqual(await gate(217, live), {
    allowed: false,
    runId: 217,
    reason: 'live-snapshot-mismatch',
  });
});

test('Archive gate 對連線、缺 coverage、匯入、hash 與表驗證錯誤全部 fail-closed', async () => {
  const unreachable = createArchiveRetentionPreflight(async () => { throw new Error('secret connection detail'); }, configuredEnv);
  assert.deepEqual(await unreachable(217), { allowed: false, runId: 217, reason: 'archive-unreachable' });
  const missing = createArchiveRetentionPreflight(async () => null, configuredEnv);
  assert.deepEqual(await missing(217), { allowed: false, runId: 217, reason: 'coverage-missing' });

  const ingest = verifiedCoverage();
  ingest.attempt.status = 'importing';
  assert.deepEqual(await createArchiveRetentionPreflight(async () => ingest, configuredEnv)(217),
    { allowed: false, runId: 217, reason: 'ingest-not-verified' });

  const badHash = verifiedCoverage();
  badHash.source.source.sha256 = '0'.repeat(64);
  assert.deepEqual(await createArchiveRetentionPreflight(async () => badHash, configuredEnv)(217),
    { allowed: false, runId: 217, reason: 'dump-hash-not-verified' });

  const missingTable = verifiedCoverage();
  missingTable.tables.pop();
  assert.deepEqual(await createArchiveRetentionPreflight(async () => missingTable, configuredEnv)(217),
    { allowed: false, runId: 217, reason: 'required-tables-not-verified' });
});

test('Archive gate 不接受 caller 與 coverage 的 Run identity 不一致', async () => {
  const crossed = verifiedCoverage();
  crossed.sourceRunId = 216;
  assert.deepEqual(await createArchiveRetentionPreflight(async () => crossed, configuredEnv)(217),
    { allowed: false, runId: 217, reason: 'ingest-not-verified' });
});

test('Archive denial reason validator 只接受正式 contract', () => {
  assert.equal(isArchiveRetentionDenialReason('coverage-missing'), true);
  assert.equal(isArchiveRetentionDenialReason('live-snapshot-mismatch'), true);
  assert.equal(isArchiveRetentionDenialReason('source-database-mismatch'), true);
  assert.equal(isArchiveRetentionDenialReason('verified'), false);
  assert.equal(isArchiveRetentionDenialReason(undefined), false);
});
