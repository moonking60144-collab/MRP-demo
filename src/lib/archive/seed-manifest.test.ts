import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArchiveSeedManifest, verifyArchiveSeedFiles } from './seed-manifest';

const content = 'controlled seed bytes';
const manifest = {
  manifestVersion: 1, kind: 'funda-mrp-archive-seed',
  seedFileName: 'seed.dump', sourceFileName: 'auto.dump', schemaGeneration: 'G4',
  sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
  createdAt: '2026-09-04T08:12:34.7156747Z',
  runCoverage: { count: 2, minRunId: 18, maxRunId: 220, runIds: [220, 18] },
  validation: { physicalSha256Verified: true },
};

test('seed manifest 保留精確 Run 集合，不把最小最大編號當完整範圍', () => {
  assert.deepEqual(parseArchiveSeedManifest(manifest).runCoverage.runIds, [18, 220]);
  for (const value of [
    { ...manifest, schemaGeneration: 'G9' },
    { ...manifest, seedFileName: '../seed.dump' },
    { ...manifest, sizeBytes: 0 },
    { ...manifest, runCoverage: { ...manifest.runCoverage, runIds: [18, 18] } },
    { ...manifest, runCoverage: { ...manifest.runCoverage, count: 3 } },
  ]) assert.throws(() => parseArchiveSeedManifest(value));
});

test('seed 驗證重算檔案 hash；manifest 的舊 true 不能掩蓋檔案變更或代表已匯入', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-seed-test-'));
  const dump = path.join(directory, 'seed.dump');
  try {
    await writeFile(dump, content);
    await writeFile(path.join(directory, 'seed.archive.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'seed.sha256'), `${manifest.sha256}  seed.dump\n`);
    const verified = await verifyArchiveSeedFiles(dump);
    assert.equal(verified.archived, false);
    assert.equal(verified.archiveVerified, false);
    await writeFile(dump, 'x'.repeat(Buffer.byteLength(content)));
    await assert.rejects(verifyArchiveSeedFiles(dump), /physical SHA256 mismatch/, 'SEED_HASH_MUST_MATCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
