import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.argv.slice(2);
if (local.some(arg => arg !== '--local')) throw new Error('用法：npm run test:postgres 或 npm run test:postgres:local');
let directory, started = false;
let url = process.env.MRP_DEMO_TEST_DATABASE_URL;
const pgEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, env: pgEnvironment, timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `${command} failed`);
  return result.stdout;
}
try {
  if (local.includes('--local')) {
    run('postgres', ['--version']);
    directory = mkdtempSync(join(tmpdir(), 'mrp-prisma-pg-'));
    const probe = createServer();
    const port = await new Promise((accept, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => accept(port)); });
    });
    run('initdb', ['-D', join(directory, 'data'), '-U', 'mrp_demo_test', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
    started = true;
    run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
    run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'mrp_demo_test', 'mrp_demo_prisma_test']);
    url = `postgresql://mrp_demo_test@127.0.0.1:${port}/mrp_demo_prisma_test`;
  }
  const result = spawnSync(process.execPath, ['--import', './scripts/test-environment.mjs', '--import', 'tsx', 'src/lib/demo-postgres/verify.ts'], {
    cwd: root, shell: false, stdio: 'inherit', timeout: 120000, killSignal: 'SIGKILL', env: { ...process.env, MRP_DEMO_TEST_DATABASE_URL: url ?? '' },
  });
  process.exitCode = result.status ?? 1;
  if (result.signal) console.error(`Prisma 驗證子程序被 ${result.signal} 結束。`);
  if (result.error) console.error(result.error.message);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']); started = false; }
    catch (error) { console.error(`臨時 PostgreSQL 停止失敗；保留 ${directory}。${error.message}`); process.exitCode = 1; }
  }
  if (directory && !started) rmSync(directory, { recursive: true, force: true });
}
