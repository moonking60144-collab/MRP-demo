import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPgDumpInvocation,
  getDatabaseBackupConfig,
  listVerifiedDatabaseBackups,
  parseDatabaseBackupCliMode,
  removeExpiredDatabaseBackups,
  runDatabaseBackup,
  type BackupCommandRunner,
  type DatabaseBackupConfig,
  type DatabaseBackupManifest,
} from './database-backup';
import {
  isDatabaseBackupDue,
  runScheduledDatabaseBackupCheck,
} from './database-backup-scheduler';
import type { AutomaticDatabaseBackupResult } from './database-backup-result';

const DATABASE_URL =
  'postgresql://backup%40user:p%40ss%3Aword@db.example.test:5433/funda_mrp?sslmode=require';

function config(directory: string): DatabaseBackupConfig {
  return {
    enabled: false,
    directory,
    intervalHours: 24,
    checkIntervalMinutes: 30,
    retentionDays: 30,
    minimumBackups: 3,
    timeoutMinutes: 30,
    pgDumpPath: '/tools/pg_dump',
    pgRestorePath: '/tools/pg_restore',
  };
}

async function createTempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'funda-mrp-backup-'));
}

function successfulCommandRunner(): BackupCommandRunner {
  return async (command, args) => {
    if (command.endsWith('pg_dump')) {
      const fileArg = args.find((arg) => arg.startsWith('--file='));
      assert.ok(fileArg);
      await writeFile(fileArg.slice('--file='.length), 'custom archive');
      return;
    }
    assert.ok(command.endsWith('pg_restore'));
    assert.equal(args[0], '--list');
  };
}

async function createVerifiedBackup(
  directory: string,
  fileName: string,
  completedAt: Date,
): Promise<void> {
  const archivePath = path.join(directory, fileName);
  const content = `archive:${fileName}`;
  const sha256 = createHash('sha256')
    .update(content)
    .digest('hex')
    .toUpperCase();
  const manifest: DatabaseBackupManifest = {
    fileName,
    sizeBytes: Buffer.byteLength(content),
    sha256,
    startedAt: completedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: 1,
  };
  await writeFile(archivePath, content);
  await writeFile(
    `${archivePath}.sha256`,
    `${sha256}  ${fileName}\n`,
  );
  await writeFile(
    `${archivePath}.json`,
    `${JSON.stringify(manifest)}\n`,
  );
}

test('database backup 設定預設關閉並限制無效數值', () => {
  assert.deepEqual(getDatabaseBackupConfig({}), {
    enabled: false,
    directory: 'E:\\backup\\funda-mrp-postgres',
    intervalHours: 24,
    checkIntervalMinutes: 30,
    retentionDays: 30,
    minimumBackups: 3,
    timeoutMinutes: 30,
    pgDumpPath: 'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
    pgRestorePath:
      'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe',
  });
  assert.deepEqual(
    getDatabaseBackupConfig({
      DB_BACKUP_ENABLED: 'true',
      DB_BACKUP_DIRECTORY: '/backup',
      DB_BACKUP_INTERVAL_HOURS: '0',
      DB_BACKUP_CHECK_INTERVAL_MINUTES: '15',
      DB_BACKUP_RETENTION_DAYS: '45',
      DB_BACKUP_MINIMUM_BACKUPS: '5',
      DB_BACKUP_TIMEOUT_MINUTES: '99999',
      DB_BACKUP_PG_DUMP_PATH: '/pg_dump',
      DB_BACKUP_PG_RESTORE_PATH: '/pg_restore',
    }),
    {
      enabled: true,
      directory: '/backup',
      intervalHours: 24,
      checkIntervalMinutes: 15,
      retentionDays: 45,
      minimumBackups: 5,
      timeoutMinutes: 1440,
      pgDumpPath: '/pg_dump',
      pgRestorePath: '/pg_restore',
    },
  );
});

test('database backup CLI 預設 dry-run 並拒絕混用模式', () => {
  assert.equal(parseDatabaseBackupCliMode([]), 'dry-run');
  assert.equal(parseDatabaseBackupCliMode(['--dry-run']), 'dry-run');
  assert.equal(parseDatabaseBackupCliMode(['--status']), 'status');
  assert.equal(parseDatabaseBackupCliMode(['--execute']), 'execute');
  assert.throws(
    () => parseDatabaseBackupCliMode(['--dry-run', '--execute']),
    /不可同時使用/,
  );
  assert.throws(
    () => parseDatabaseBackupCliMode(['--force']),
    /不支援的參數/,
  );
});

test('pg_dump 參數不含密碼或 DATABASE_URL', () => {
  const invocation = buildPgDumpInvocation(
    DATABASE_URL,
    '/backup/archive.dump.partial',
    {
      DATABASE_URL,
      DATABASE_URL_LOCAL: DATABASE_URL,
      SAFE_ENV: 'kept',
    },
  );
  assert.ok(invocation.args.includes('--username=backup@user'));
  assert.ok(invocation.args.includes('--dbname=funda_mrp'));
  assert.ok(invocation.args.includes('--host=db.example.test'));
  assert.ok(invocation.args.includes('--port=5433'));
  assert.ok(invocation.args.every((arg) => !arg.includes('p@ss:word')));
  assert.ok(invocation.args.every((arg) => !arg.includes('postgresql://')));
  assert.equal(invocation.env.PGPASSWORD, 'p@ss:word');
  assert.equal(invocation.env.PGSSLMODE, 'require');
  assert.equal(invocation.env.DATABASE_URL, undefined);
  assert.equal(invocation.env.DATABASE_URL_LOCAL, undefined);
  assert.equal(invocation.env.SAFE_ENV, 'kept');
});

test('active MRP Run 會在建立目錄與執行 pg_dump 前跳過備份', async () => {
  const directory = path.join(await createTempDirectory(), 'not-created');
  let commands = 0;
  const result = await runDatabaseBackup({
    config: config(directory),
    env: { DATABASE_URL },
    isActiveRun: async () => true,
    runCommand: async () => {
      commands += 1;
    },
  });
  assert.deepEqual(result, { status: 'skipped_active_run' });
  assert.equal(commands, 0);
  await assert.rejects(() => stat(directory), /ENOENT/);
});

test('existing backup lock 阻止同時執行第二份備份', async () => {
  const directory = await createTempDirectory();
  await writeFile(
    path.join(directory, '.funda-mrp-backup.lock'),
    '{"pid":1}',
  );
  let commands = 0;
  const result = await runDatabaseBackup({
    config: config(directory),
    env: { DATABASE_URL },
    isActiveRun: async () => false,
    runCommand: async () => {
      commands += 1;
    },
  });
  assert.deepEqual(result, { status: 'skipped_locked' });
  assert.equal(commands, 0);
});

test('pg_restore 驗證失敗時只留下 partial，不發布正式備份', async () => {
  const directory = await createTempDirectory();
  const runner: BackupCommandRunner = async (command, args) => {
    if (command.endsWith('pg_dump')) {
      const fileArg = args.find((arg) => arg.startsWith('--file='));
      assert.ok(fileArg);
      await writeFile(fileArg.slice('--file='.length), 'partial archive');
      return;
    }
    throw new Error('invalid archive');
  };

  await assert.rejects(
    () =>
      runDatabaseBackup({
        config: config(directory),
        env: { DATABASE_URL },
        now: () => new Date('2026-07-28T08:00:00.123Z'),
        isActiveRun: async () => false,
        runCommand: runner,
      }),
    /invalid archive/,
  );
  const files = await readdirNames(directory);
  assert.ok(files.some((file) => file.endsWith('.dump.partial')));
  assert.ok(!files.some((file) => file.endsWith('.dump')));
  assert.ok(!files.includes('.funda-mrp-backup.lock'));
});

test('連續驗證失敗只保留最新自動 partial，不影響手動備份', async () => {
  const directory = await createTempDirectory();
  const manualBackup = path.join(
    directory,
    'funda_mrp_20260728_113257.dump',
  );
  await writeFile(manualBackup, 'manual recovery');
  const runner: BackupCommandRunner = async (command, args) => {
    if (command.endsWith('pg_dump')) {
      const fileArg = args.find((arg) => arg.startsWith('--file='));
      assert.ok(fileArg);
      await writeFile(fileArg.slice('--file='.length), 'partial archive');
      return;
    }
    throw new Error('invalid archive');
  };
  const runFailure = (value: Date) =>
    assert.rejects(
      () =>
        runDatabaseBackup({
          config: config(directory),
          env: { DATABASE_URL },
          now: () => value,
          isActiveRun: async () => false,
          runCommand: runner,
        }),
      /invalid archive/,
    );

  await runFailure(new Date(2026, 6, 28, 16, 0, 0, 0));
  await runFailure(new Date(2026, 6, 28, 16, 30, 0, 0));

  const files = await readdirNames(directory);
  assert.deepEqual(
    files.filter((file) => file.endsWith('.dump.partial')),
    ['funda_mrp_auto_20260728_163000_000.dump.partial'],
  );
  assert.equal(await readFile(manualBackup, 'utf8'), 'manual recovery');
});

test('成功備份驗證後才發布 archive、SHA256 與 manifest', async () => {
  const directory = await createTempDirectory();
  const times = [
    new Date(2026, 6, 28, 16, 0, 0, 123),
    new Date(2026, 6, 28, 16, 0, 5, 456),
  ];
  const result = await runDatabaseBackup({
    config: config(directory),
    env: { DATABASE_URL },
    now: () => times.shift() ?? new Date(2026, 6, 28, 16, 0, 5, 456),
    isActiveRun: async () => false,
    runCommand: successfulCommandRunner(),
  });
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;

  assert.equal(
    result.backup.manifest.fileName,
    'funda_mrp_auto_20260728_160000_123.dump',
  );
  assert.equal(result.backup.manifest.durationMs, 5333);
  assert.equal(result.backup.manifest.sizeBytes, 14);
  assert.equal(
    await readFile(result.backup.archivePath, 'utf8'),
    'custom archive',
  );
  assert.match(
    await readFile(result.backup.sha256Path, 'utf8'),
    /^[A-F0-9]{64}  funda_mrp_auto_/,
  );
  assert.equal((await listVerifiedDatabaseBackups(directory)).length, 1);
  assert.ok(
    !(await readdirNames(directory)).some((file) => file.endsWith('.partial')),
  );
});

test('rotation 只刪過期且超過最低保留數的自動完整備份', async () => {
  const directory = await createTempDirectory();
  await mkdir(directory, { recursive: true });
  const dates = [
    new Date('2026-06-01T00:00:00.000Z'),
    new Date('2026-06-02T00:00:00.000Z'),
    new Date('2026-06-03T00:00:00.000Z'),
    new Date('2026-06-04T00:00:00.000Z'),
  ];
  for (let index = 0; index < dates.length; index += 1) {
    const fileName =
      `funda_mrp_auto_2026060${index + 1}_080000_000.dump`;
    await createVerifiedBackup(directory, fileName, dates[index]);
    const archivePath = path.join(directory, fileName);
    await utimes(archivePath, dates[index], dates[index]);
  }
  const manualBackup = path.join(
    directory,
    'funda_mrp_20260728_113257.dump',
  );
  await writeFile(manualBackup, 'manual recovery');

  const deleted = await removeExpiredDatabaseBackups(
    config(directory),
    new Date('2026-07-28T00:00:00.000Z'),
  );
  assert.deepEqual(deleted, [
    'funda_mrp_auto_20260601_080000_000.dump',
  ]);
  assert.equal((await listVerifiedDatabaseBackups(directory)).length, 3);
  assert.equal(await readFile(manualBackup, 'utf8'), 'manual recovery');
});

test('pg_dump 失敗時不發布正式備份並釋放 lock', async () => {
  const directory = await createTempDirectory();
  await assert.rejects(
    () =>
      runDatabaseBackup({
        config: config(directory),
        env: { DATABASE_URL },
        isActiveRun: async () => false,
        runCommand: async () => {
          throw new Error('pg_dump unavailable');
        },
      }),
    /pg_dump unavailable/,
  );
  const files = await readdirNames(directory);
  assert.ok(!files.some((file) => file.endsWith('.dump')));
  assert.ok(!files.includes('.funda-mrp-backup.lock'));
});

test('仍存活 process 持有的舊 lock 不會被 timeout 覆蓋', async () => {
  const directory = await createTempDirectory();
  const lockPath = path.join(directory, '.funda-mrp-backup.lock');
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, host: hostname() }),
  );
  const now = new Date(2026, 6, 28, 16, 0, 0, 0);
  const old = new Date(now.getTime() - 61 * 60 * 1000);
  await utimes(lockPath, old, old);

  const result = await runDatabaseBackup({
    config: { ...config(directory), timeoutMinutes: 30 },
    env: { DATABASE_URL },
    now: () => now,
    isActiveRun: async () => false,
    runCommand: successfulCommandRunner(),
  });
  assert.deepEqual(result, { status: 'skipped_locked' });
});

test('超過兩倍 command timeout 的 stale lock 可自動恢復', async () => {
  const directory = await createTempDirectory();
  const lockPath = path.join(directory, '.funda-mrp-backup.lock');
  await writeFile(lockPath, '{"pid":999999}');
  const now = new Date(2026, 6, 28, 16, 0, 0, 0);
  const old = new Date(now.getTime() - 61 * 60 * 1000);
  await utimes(lockPath, old, old);

  const result = await runDatabaseBackup({
    config: { ...config(directory), timeoutMinutes: 30 },
    env: { DATABASE_URL },
    now: () => now,
    isActiveRun: async () => false,
    runCommand: successfulCommandRunner(),
  });
  assert.equal(result.status, 'completed');
  assert.ok(!((await readdirNames(directory)).includes('.funda-mrp-backup.lock')));
});

test('backend scheduler 同一 process 的重疊檢查只執行一份備份', async () => {
  const directory = await createTempDirectory();
  let dumpCommands = 0;
  const automaticResults: AutomaticDatabaseBackupResult[] = [];
  const runCommand: BackupCommandRunner = async (command, args) => {
    if (command.endsWith('pg_dump')) {
      dumpCommands += 1;
      const fileArg = args.find((arg) => arg.startsWith('--file='));
      assert.ok(fileArg);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(fileArg.slice('--file='.length), 'custom archive');
    }
  };
  const options = {
    config: { ...config(directory), enabled: true },
    env: { DATABASE_URL },
    now: () => new Date(2026, 6, 28, 16, 0, 0, 0),
    isActiveRun: async () => false,
    runCommand,
    saveAutomaticResult: async (result: AutomaticDatabaseBackupResult) => {
      automaticResults.push(result);
    },
  };

  await Promise.all([
    runScheduledDatabaseBackupCheck(options),
    runScheduledDatabaseBackupCheck(options),
  ]);
  assert.equal(dumpCommands, 1);
  assert.equal((await listVerifiedDatabaseBackups(directory)).length, 1);
  assert.equal(automaticResults.length, 1);
  assert.equal(automaticResults[0]?.outcome, 'completed');
  assert.match(
    automaticResults[0]?.fileName ?? '',
    /^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump$/,
  );
});

test('backend scheduler 重疊失敗不向第二個 caller 傳遞 rejected Promise', async () => {
  const directory = await createTempDirectory();
  let dumpCommands = 0;
  const automaticResults: AutomaticDatabaseBackupResult[] = [];
  const options = {
    config: { ...config(directory), enabled: true },
    env: { DATABASE_URL },
    now: () => new Date(2026, 6, 28, 16, 0, 0, 0),
    isActiveRun: async () => false,
    runCommand: async () => {
      dumpCommands += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('backup failed');
    },
    saveAutomaticResult: async (result: AutomaticDatabaseBackupResult) => {
      automaticResults.push(result);
    },
  };

  const results = await Promise.allSettled([
    runScheduledDatabaseBackupCheck(options),
    runScheduledDatabaseBackupCheck(options),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(dumpCommands, 1);
  assert.equal(automaticResults.length, 1);
  assert.deepEqual(automaticResults[0], {
    outcome: 'failed',
    startedAt: new Date(2026, 6, 28, 16, 0, 0, 0).toISOString(),
    completedAt: new Date(2026, 6, 28, 16, 0, 0, 0).toISOString(),
    durationMs: 0,
    fileName: null,
    sizeBytes: null,
  });
});

test('損壞的 manifest 時間不會阻止 scheduler 補做備份', async () => {
  const directory = await createTempDirectory();
  const fileName = 'funda_mrp_auto_20260728_080000_000.dump';
  await createVerifiedBackup(
    directory,
    fileName,
    new Date('2026-07-28T00:00:00.000Z'),
  );
  const manifestPath = path.join(directory, `${fileName}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  manifest.completedAt = 'not-a-date';
  await writeFile(manifestPath, JSON.stringify(manifest));

  assert.deepEqual(await listVerifiedDatabaseBackups(directory), []);
  assert.equal(
    isDatabaseBackupDue(null, new Date('2026-07-29T00:00:00.000Z'), 24),
    true,
  );
});

test('scheduler 依最後驗證完成時間判斷是否到期', async () => {
  const directory = await createTempDirectory();
  await createVerifiedBackup(
    directory,
    'funda_mrp_auto_20260728_080000_000.dump',
    new Date('2026-07-28T00:00:00.000Z'),
  );
  const [latest] = await listVerifiedDatabaseBackups(directory);
  assert.equal(
    isDatabaseBackupDue(
      latest,
      new Date('2026-07-28T23:59:59.999Z'),
      24,
    ),
    false,
  );
  assert.equal(
    isDatabaseBackupDue(
      latest,
      new Date('2026-07-29T00:00:00.000Z'),
      24,
    ),
    true,
  );
  assert.equal(
    isDatabaseBackupDue(null, new Date('2026-07-28T00:00:00.000Z'), 24),
    true,
  );
});

async function readdirNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}
