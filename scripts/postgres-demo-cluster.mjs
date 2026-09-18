import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createPostgresDemoCluster() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const run = (command, args) => {
    const result = spawnSync(command, args, { env: environment, encoding: 'utf8', shell: false, timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `${command} failed`);
  };
  run('postgres', ['--version']);
  const directory = mkdtempSync(join(tmpdir(), 'mrp-postgres-web-'));
  let started = false;
  const stop = () => {
    if (started) {
      try { run('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']); started = false; }
      catch (error) { throw new Error(`臨時 PostgreSQL 停止失敗；保留 ${directory}。${error.message}`); }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const probe = createServer();
    const port = await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => accept(port)); }); });
    run('initdb', ['-D', join(directory, 'data'), '-U', 'mrp_demo_test', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
    started = true;
    run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
    run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'mrp_demo_test', 'mrp_demo_prisma_demo']);
    return { url: `postgresql://mrp_demo_test@127.0.0.1:${port}/mrp_demo_prisma_demo`, directory, stop };
  } catch (error) { stop(); throw error; }
}
