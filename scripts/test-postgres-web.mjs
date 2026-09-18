import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDemoCluster } from './postgres-demo-cluster.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cluster = await createPostgresDemoCluster();
try {
  const result = spawnSync(process.execPath, ['--import', './scripts/test-environment.mjs', '--import', 'tsx', 'src/lib/demo-postgres/web-verification.ts'], { cwd: root, env: { ...process.env, MRP_DEMO_POSTGRES_URL: cluster.url }, stdio: 'inherit', shell: false, timeout: 120000, killSignal: 'SIGKILL' });
  process.exitCode = result.status ?? 1;
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`PostgreSQL 網站驗證被 ${result.signal} 結束。`);
} finally { cluster.stop(); }
