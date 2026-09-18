import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') throw new Error('此測試驗證 macOS／Linux 臨時 cluster；Windows 使用手動準備的展示庫。');
const probe = createServer();
await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(3142, '127.0.0.1', () => probe.close(accept)); });
const child = spawn('npm', ['run', 'start:postgres:local'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '3142' } });
let log = '', exited = false, temporary;
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
child.once('error', error => { log += error.message; exited = true; }); child.once('exit', () => { exited = true; });
const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const open = port => new Promise(accept => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); accept(true); }); socket.once('error', () => accept(false)); socket.setTimeout(1000, () => { socket.destroy(); accept(true); }); });
const result = { status: 'failed', node: process.version, platform: process.platform, checks: [] };
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try { const response = await fetch('http://127.0.0.1:3142/api/db-health', { signal: AbortSignal.timeout(2000) }); const body = await response.json(); ready = response.ok && body.storage === 'postgresql' && body.demo === true; } catch {}
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 200));
  }
  assert.ok(ready, `POSTGRES_WEB_STARTUP:${log}`);
  temporary = log.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.temporaryPostgres === true);
  assert.ok(temporary?.port && temporary.directory, '必須取得本次 launcher 擁有的 cluster 身分。');
  assert.equal((await fetch('http://127.0.0.1:3142/')).status, 200);
  const streamController = new AbortController();
  const stream = await fetch('http://127.0.0.1:3142/api/runs/stream', { signal: streamController.signal });
  assert.match(stream.headers.get('Content-Type'), /text\/event-stream/);
  for (const path of ['fg-monthly?runId=3&includePeriods=1', 'component-weekly?runId=3&mrpType=B', 'sales-meeting?runId=3', 'source-data?runId=3&table=inventory']) {
    const response = await fetch(`http://127.0.0.1:3142/api/${path}`, { signal: AbortSignal.timeout(15000) }); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('X-MRP-Storage'), 'postgresql'); assert.ok(body.items.length > 0); result.checks.push(path);
  }
  process.kill(-child.pid, 'SIGINT');
  try { process.kill(-child.pid, 'SIGINT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const shutdownDeadline = Date.now() + 15000;
  while (Date.now() < shutdownDeadline && (!exited || groupAlive() || await open(3142) || await open(temporary.port))) await new Promise(accept => setTimeout(accept, 100));
  assert.equal(exited, true, 'POSTGRES_WEB_LAUNCHER_CLEANUP');
  assert.equal(await open(3142), false, 'POSTGRES_WEB_SERVER_CLEANUP');
  assert.equal(await open(temporary.port), false, 'POSTGRES_WEB_CLUSTER_CLEANUP');
  assert.equal(groupAlive(), false, 'POSTGRES_WEB_PROCESS_TREE_CLEANUP');
  assert.equal(existsSync(temporary.directory), false, 'POSTGRES_WEB_CLUSTER_DIRECTORY_CLEANUP');
  streamController.abort();
  result.checks.push('actual-npm-repeated-SIGINT-closes-server-and-owned-PG-and-removes-temp-directory'); result.status = 'passed';
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  if (child.pid && groupAlive()) { process.kill(-child.pid, 'SIGTERM'); await new Promise(accept => setTimeout(accept, 1000)); if (groupAlive()) process.kill(-child.pid, 'SIGKILL'); }
  if (temporary && await open(temporary.port)) spawnSync('pg_ctl', ['-D', join(temporary.directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'inherit', timeout: 60000 });
  mkdirSync(join(root, 'release'), { recursive: true }); writeFileSync(join(root, 'release/postgres-web-smoke.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
