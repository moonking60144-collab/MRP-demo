import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const appRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Exercise the real CLI in a fresh process with no database connection or writes.
const harness = `
  import { pathToFileURL } from 'node:url';
  const runs = [
    { id: 100, status: 'completed', isLatest: true, completedAt: new Date() },
    { id: 18, status: 'completed', isLatest: false, completedAt: new Date('2020-01-01') },
  ];
  const counts = { count: async () => 1 };
  const client = new Proxy({
    mrpRun: {
      findFirst: async () => null,
      findMany: async ({ where }) => where.status === 'completed' ? runs : [],
    },
    productionPlanTransfer: { findMany: async () => [], count: async () => 0 },
    $queryRaw: async () => [],
    $executeRaw: async () => undefined,
    $transaction: async (callback) => callback(new Proxy({
      mrpRun: {
        findFirst: async () => null,
        findMany: async () => runs,
      },
      productionPlanTransfer: { findFirst: async () => null },
      $queryRaw: async () => [{ id: 18, status: 'completed', is_latest: false }],
      $executeRaw: async () => undefined,
    }, { get(target, property) { return property in target ? target[property] : { deleteMany: async () => { throw new Error('CLI_DELETE_FORBIDDEN'); } }; } })),
    $disconnect: async () => {},
  }, { get(target, property) { return property in target ? target[property] : counts; } });
  globalThis.prisma = client;
  globalThis.prismaDbMode = 'local';
  process.argv = ['node', 'scripts/run-retention.ts', ...process.argv.slice(1)];
  await import(pathToFileURL(process.cwd() + '/scripts/run-retention.ts').href);
`;

for (const mode of ['--dry-run', '--execute']) {
  test(`retention CLI ${mode} 明示 Archive 未設定且不能刪除精確 Run`, () => {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', harness, '--', mode, '--run-id', '18',
    ], {
      cwd: appRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MRP_RUN_RETENTION_ENABLED: 'true',
        MRP_RUN_RETENTION_MIN_COMPLETED: '1',
        MRP_RUN_RETENTION_DAYS: '30',
        MRP_RUN_RETENTION_BATCH_SIZE: '1',
        MRP_RUN_ARCHIVE_GATE_ENABLED: 'true',
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ARCHIVE_COVERAGE_READY=false/);
    assert.match(result.stdout, /ARCHIVE_GATE_REASON=archive-not-configured/);
    assert.match(result.stdout, /COVERAGE_READY_RUN_IDS=\r?\n/);
    const line = result.stdout.split('\n').find((value) => value.startsWith('RETENTION_RESULT='));
    assert.ok(line, result.stdout);
    const output = JSON.parse(line.slice('RETENTION_RESULT='.length));
    assert.deepEqual(output.deletedIds, [], 'CLI_ARCHIVE_DENIAL');
    assert.deepEqual(output.failures, [], 'CLI_ARCHIVE_DENIAL');
    assert.equal(output.outcome, mode === '--dry-run' ? 'dry-run' : 'archive-blocked');
    if (mode === '--execute') {
      assert.deepEqual(output.archiveBlocks, [
        { allowed: false, runId: 18, reason: 'archive-not-configured' },
      ]);
    }
  });
}
