import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const lockPath = path.join(projectRoot, '.next-dev-process.json');
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

async function readActiveDevPid() {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const pid = Number(lock.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (error) {
      if (error?.code === 'EPERM') return pid;
      await rm(lockPath, { force: true });
      return null;
    }
  } catch {
    return null;
  }
}

async function runNext(nextCommand) {
  await access(nextBin, constants.R_OK);
  const child = spawn(process.execPath, [nextBin, nextCommand, ...commandArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (nextCommand === 'dev') {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal, pid: child.pid }));
  });
}

if (command !== 'dev' && command !== 'build') {
  console.error('用法：node scripts/next-command.mjs <dev|build> [...args]');
  process.exit(1);
}

if (command === 'build') {
  const activeDevPid = await readActiveDevPid();
  if (activeDevPid) {
    console.error(`偵測到同一專案的 next dev 正在執行（PID ${activeDevPid}）。`);
    console.error('請先停止 dev server，再執行 npm run build；避免 Next 改寫 generated types 造成頁面重新載入。');
    process.exit(1);
  }
}

const result = await runNext(command);
if (command === 'dev') await rm(lockPath, { force: true });
if (result.signal) console.error(`Next ${command} 因 ${result.signal} 結束。`);
process.exit(result.code);
