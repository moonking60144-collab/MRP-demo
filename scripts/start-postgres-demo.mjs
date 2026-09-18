import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDemoCluster } from './postgres-demo-cluster.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--local')) throw new Error('用法：npm run start:postgres 或 npm run start:postgres:local');
let cluster;
let child, stopping = false;
const stop = () => { stopping = true; child?.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  if (!existsSync(join(root, '.next/standalone/server.js'))) throw new Error('尚未建置；請先執行 npm ci 與 npm run build。');
  if (args.includes('--local')) cluster = await createPostgresDemoCluster();
  if (cluster) console.log(JSON.stringify({ temporaryPostgres: true, directory: cluster.directory, port: Number(new URL(cluster.url).port) }));
  if (stopping) throw new Error('PostgreSQL Demo 啟動已取消。');
  const environment = { ...process.env, MRP_DEMO_POSTGRES_URL: cluster?.url ?? process.env.MRP_DEMO_POSTGRES_URL ?? '' };
  const preparation = spawnSync(process.execPath, ['--import', 'tsx', 'src/lib/demo-postgres/prepare-web-command.ts'], { cwd: root, env: environment, stdio: 'inherit', shell: false, timeout: 120000, killSignal: 'SIGKILL' });
  if (preparation.error || preparation.status !== 0) throw new Error('PostgreSQL Demo 初始化失敗；網站未啟動。');
  if (stopping) throw new Error('PostgreSQL Demo 啟動已取消。');
  child = spawn(process.execPath, ['scripts/start-demo.mjs'], { cwd: root, env: environment, stdio: 'inherit' });
  process.exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => accept(code ?? 1)); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  try { cluster?.stop(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
