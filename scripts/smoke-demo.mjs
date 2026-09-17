import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:3142';
async function assertPortFree() {
  const probe = createServer();
  await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(3142, '127.0.0.1', () => probe.close(accept)); });
}
await assertPortFree();
const child = spawn(process.execPath, ['scripts/start-demo.mjs'], { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '3142' } });
let log = '', exited = false;
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
child.once('exit', () => { exited = true; });
child.once('error', error => { log += error.message; exited = true; });
const result = { status: 'failed', platform: process.platform, node: process.version, checks: [] };
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try { const response = await fetch(`${origin}/api/db-health`, { signal: AbortSignal.timeout(2000) }); const body = await response.json(); ready = response.ok && body.demo === true; }
    catch { /* 啟動中的 server 尚未接受 HTTP。 */ }
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 250));
  }
  assert.ok(ready, `Demo startup failed: ${log}`);
  const response = await fetch(origin); assert.equal(response.status, 200); assert.match(await response.text(), /<html/i);
  for (const route of ['fg-monthly?runId=3', 'component-weekly?runId=3&mrpType=B', 'sales-meeting?runId=3']) {
    const response = await fetch(`${origin}/api/${route}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.runId, 3); assert.ok(body.items.length > 0); result.checks.push(route);
  }
  const storage = await (await fetch(`${origin}/api/storage-status`)).json();
  assert.equal(storage.demo, true); assert.deepEqual(storage.warnings, []);
  assert.equal(exited, false, '受測 launcher 必須仍在運行，不能拿其他服務的回應當成成功。');
  result.checks.push('actual-standalone-start-SSR-and-local-synthetic-API'); result.status = 'passed';
} catch (error) { result.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (child.pid && !exited) {
    try {
      if (process.platform === 'win32') assert.equal(spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).status, 0);
      else await new Promise((accept, reject) => {
        const timer = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); reject(new Error('受測 launcher 停止逾時。')); }, 10000);
        child.once('exit', () => { clearTimeout(timer); accept(); }); child.kill('SIGTERM');
      });
      await assertPortFree();
    } catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
  }
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release/offline-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
