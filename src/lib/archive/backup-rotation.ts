import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectBackupRecovery } from './backup';
import { assertLockedWorkspace, withArchiveWorkspace } from './workspace';

interface Recovery { schemaSha256: string; groups?: Record<string, string> }
export function recoveryContains(keeper: Recovery, candidate: Recovery) {
  return keeper.schemaSha256 === candidate.schemaSha256 && !!keeper.groups && !!candidate.groups &&
    Object.keys(candidate.groups).length > 0 &&
    Object.entries(candidate.groups).every(([key, hash]) => keeper.groups![key] === hash);
}

async function unlinkedPath(target: string) {
  let cursor = path.resolve(target);
  while (true) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('Backup rotation refuses linked paths');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function inspectJob(root: string, name: string) {
  if (!/^archive-[A-Za-z0-9]{6}$/.test(name)) return null;
  const job = path.join(root, name);
  await unlinkedPath(job);
  if (!(await lstat(job)).isDirectory()) return null;
  const names = (await readdir(job)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['archive.dump', 'manifest.json', 'verified.json'])) return null;
  for (const file of names) {
    const info = await lstat(path.join(job, file));
    if (!info.isFile() || info.isSymbolicLink()) return null;
  }
  const manifest = JSON.parse(await readFile(path.join(job, 'manifest.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(job, 'verified.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.database !== 'funda_mrp_archive' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || receipt.version !== 1 ||
      receipt.sha256 !== manifest.sha256 || receipt.restoreVerified !== true || receipt.tablesVerified !== 23 ||
      !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(receipt.verifiedAt))) return null;
  const dump = path.join(job, 'archive.dump');
  const identity = await lstat(dump);
  if (identity.size !== manifest.sizeBytes) return null;
  return { name, job, dump, sha256: manifest.sha256 as string, sizeBytes: identity.size,
    at: Math.max(Date.parse(manifest.createdAt), Date.parse(receipt.verifiedAt)), identity };
}

async function verifyFile(job: NonNullable<Awaited<ReturnType<typeof inspectJob>>>) {
  await unlinkedPath(job.dump);
  const before = await lstat(job.dump);
  if (!before.isFile() || before.ino !== job.identity.ino || before.size !== job.sizeBytes ||
      before.mtimeMs !== job.identity.mtimeMs || before.ctimeMs !== job.identity.ctimeMs) throw new Error('Backup file identity changed');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(job.dump)) hash.update(chunk);
  const after = await lstat(job.dump);
  if (hash.digest('hex') !== job.sha256 || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs || after.size !== before.size) throw new Error('Backup physical hash changed');
}

export async function rotateArchiveBackups(directory: string, now = new Date()) {
  if (!path.isAbsolute(directory) || path.dirname(directory) === directory) throw new Error('Backup rotation root is invalid');
  await unlinkedPath(directory);
  const root = await realpath(directory);
  return withArchiveWorkspace('backup-verification', async workspace => {
    const jobs = [];
    for (const name of await readdir(root)) {
      try { const job = await inspectJob(root, name); if (job) jobs.push(job); } catch { /* Unknown artifacts stay protected. */ }
    }
    jobs.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    const keepers = jobs.slice(0, 3);
    const candidates = jobs.slice(3).reverse().filter(job => now.getTime() - job.at > 30 * 86_400_000);
    if (!candidates.length) return { outcome: 'nothing-to-rotate' as const, removedBytes: 0 };
    if (keepers.some(job => job.at > now.getTime())) throw new Error('Backup timestamp is in the future');
    // Preserve three physically recoverable backups, not merely three receipt files.
    const recoveries = [];
    for (const keeper of keepers) {
      await verifyFile(keeper);
      recoveries.push(await inspectBackupRecovery(keeper.job, workspace));
    }
    const protectedJobs: string[] = [];
    for (const candidate of candidates) {
      await verifyFile(candidate);
      const old = await inspectBackupRecovery(candidate.job, workspace);
      const replacement = recoveries.find(recovery => recovery.recovery && old.recovery &&
        recoveryContains(recovery.recovery, old.recovery));
      if (!replacement) { protectedJobs.push(candidate.name); continue; }
      for (const keeper of keepers) await verifyFile(keeper);
      await verifyFile(candidate);
      await assertLockedWorkspace(workspace);
      await writeFile(path.join(candidate.job, 'rotation.json'), JSON.stringify({ version: 1,
        at: now.toISOString(), candidateSha256: candidate.sha256, replacementSha256: replacement.sha256,
        replacement: path.basename(replacement.jobDirectory), removedFile: 'archive.dump', sizeBytes: candidate.sizeBytes,
        policy: { days: 30, minimumBackups: 3 }, state: 'authorized-before-unlink' }), { flag: 'wx' });
      await assertLockedWorkspace(workspace);
      await verifyFile(candidate);
      await unlink(candidate.dump);
      return { outcome: 'rotated' as const, removedBytes: candidate.sizeBytes, job: candidate.name,
        replacement: path.basename(replacement.jobDirectory), protectedJobs };
    }
    return { outcome: 'protected-different-content' as const, removedBytes: 0, protectedJobs };
  });
}
