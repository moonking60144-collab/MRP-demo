import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectDumpRuns } from './dump-inventory';

export type ArchiveSchemaGeneration = 'G1' | 'G4';

export interface ArchiveSeedManifest {
  manifestVersion: 1;
  kind: 'funda-mrp-archive-seed';
  seedFileName: string;
  sourceFileName: string;
  schemaGeneration: ArchiveSchemaGeneration;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  runCoverage: { count: number; minRunId: number; maxRunId: number; runIds: number[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fileName(value: unknown): value is string {
  return typeof value === 'string' && /^[^\\/:\x00]+\.dump$/.test(value) && value !== '.dump';
}

export function parseArchiveSeedManifest(value: unknown): ArchiveSeedManifest {
  if (!record(value) || value.manifestVersion !== 1 || value.kind !== 'funda-mrp-archive-seed') {
    throw new Error('Invalid Archive seed manifest');
  }
  if (!fileName(value.seedFileName) || !fileName(value.sourceFileName) ||
      (value.schemaGeneration !== 'G1' && value.schemaGeneration !== 'G4') ||
      !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) <= 0 ||
      typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Invalid Archive seed identity');
  }
  const coverage = value.runCoverage;
  if (!record(coverage) || !Array.isArray(coverage.runIds) || coverage.runIds.length === 0 ||
      coverage.runIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Invalid Archive seed Run coverage');
  }
  const runIds = [...coverage.runIds].sort((a, b) => a - b) as number[];
  if (new Set(runIds).size !== runIds.length || coverage.count !== runIds.length ||
      coverage.minRunId !== runIds[0] || coverage.maxRunId !== runIds[runIds.length - 1]) {
    throw new Error('Archive seed Run coverage mismatch');
  }
  return {
    manifestVersion: 1,
    kind: 'funda-mrp-archive-seed',
    seedFileName: value.seedFileName,
    sourceFileName: value.sourceFileName,
    schemaGeneration: value.schemaGeneration as ArchiveSchemaGeneration,
    sizeBytes: value.sizeBytes as number,
    sha256: value.sha256.toLowerCase(),
    createdAt: value.createdAt,
    runCoverage: { count: runIds.length, minRunId: runIds[0], maxRunId: runIds[runIds.length - 1], runIds },
  };
}

export async function verifyArchiveSeedFiles(dumpPath: string) {
  const stem = dumpPath.replace(/\.dump$/, '');
  if (stem === dumpPath) throw new Error('Archive seed must be a .dump file');
  const [manifestText, sidecar, before] = await Promise.all([
    readFile(`${stem}.archive.json`, 'utf8'), readFile(`${stem}.sha256`, 'utf8'), stat(dumpPath),
  ]);
  const manifest = parseArchiveSeedManifest(JSON.parse(manifestText.replace(/^\uFEFF/, '')));
  if (!before.isFile() || path.basename(dumpPath) !== manifest.seedFileName || before.size !== manifest.sizeBytes) {
    throw new Error('Archive seed file identity or size mismatch');
  }
  if (sidecar.trim().toLowerCase() !== `${manifest.sha256}  ${manifest.seedFileName}`.toLowerCase()) {
    throw new Error('Archive seed SHA256 sidecar mismatch');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dumpPath)) hash.update(chunk);
  const after = await stat(dumpPath);
  if (hash.digest('hex') !== manifest.sha256 || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
    throw new Error('Archive seed physical SHA256 mismatch or file changed');
  }
  // Manifest validation flags describe an old observation, never current import verification.
  return { manifest, hashVerifiedAt: new Date(), archived: false as const, archiveVerified: false as const };
}

export async function verifyArchiveSeed(dumpPath: string) {
  const before = await stat(dumpPath);
  const verified = await verifyArchiveSeedFiles(dumpPath);
  const inventory = await inspectDumpRuns(dumpPath);
  const after = await stat(dumpPath);
  if (JSON.stringify(inventory.runIds) !== JSON.stringify(verified.manifest.runCoverage.runIds) ||
      inventory.hasOrderDemandContract !== (verified.manifest.schemaGeneration === 'G4')) {
    throw new Error('Seed manifest does not match actual dump Run inventory or generation');
  }
  if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
    throw new Error('Archive seed changed during inventory verification');
  }
  return verified;
}
