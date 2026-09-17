import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capacityLevel, measureDirectory, measureProductionBackups } from './storage-status';

test('capacity uses real bytes and rejects incomplete inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrp-capacity-'));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'a'), 'abc');
  await writeFile(path.join(root, 'nested', 'b'), '12345');
  assert.deepEqual(await measureDirectory(root), { bytes: 8, files: 2 });
  await assert.rejects(measureDirectory(root, 2), /limit/);
  await symlink(root, path.join(root, 'linked'));
  await assert.rejects(measureDirectory(root), /linked/);
});

test('capacity thresholds distinguish warning, critical and healthy', () => {
  const gib = 1024 ** 3;
  assert.deepEqual(capacityLevel(19 * gib, 100 * gib), { warning: true, critical: true });
  assert.deepEqual(capacityLevel(30 * gib, 100 * gib), { warning: true, critical: false });
  assert.deepEqual(capacityLevel(60 * gib, 1000 * gib), { warning: true, critical: false });
  assert.deepEqual(capacityLevel(60 * gib, 100 * gib), { warning: false, critical: false });
});

test('production inventory only measures routine dumps, not deployment recovery trees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrp-backup-capacity-'));
  await writeFile(path.join(root, 'funda_mrp_auto_20260908_050054_512.dump'), 'abc');
  await mkdir(path.join(root, 'deployment-safety'));
  await symlink(root, path.join(root, 'deployment-safety', 'linked'));
  assert.deepEqual(await measureProductionBackups(root), { bytes: 3, files: 1 });
});
