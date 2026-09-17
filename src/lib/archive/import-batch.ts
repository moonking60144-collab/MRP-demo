import { PrismaClient } from '.prisma/archive-client';
import { archiveConnectionUrl } from './connection';
import { hasCompleteTableEvidence } from './coverage';
import { verifyArchiveSeed } from './seed-manifest';
import { restoreArchiveSeed } from './restore-seed';
import { importArchiveRun } from './import-run';
import { assertLockedWorkspace, resetArchiveWorkspace, withArchiveWorkspace } from './workspace';

export async function importArchiveBatch(
  dumpPath: string, sha256: string, sourceInstance: string, minimumRunId: number, selectedRunIds?: number[],
) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !sourceInstance.trim() || !Number.isSafeInteger(minimumRunId) || minimumRunId < 1) {
    throw new Error('Batch requires a fixed SHA256, source instance and positive minimum Run ID');
  }
  const { manifest } = await verifyArchiveSeed(dumpPath);
  if (manifest.sha256 !== sha256) throw new Error('Batch source SHA256 differs from pinned source');
  const selected = selectedRunIds ? new Set(selectedRunIds) : null;
  if (selected && (selected.size !== selectedRunIds!.length || selectedRunIds!.some(id =>
    !Number.isSafeInteger(id) || id < minimumRunId || !manifest.runCoverage.runIds.includes(id)))) {
    throw new Error('Selected Archive Run IDs are invalid for this source');
  }
  return withArchiveWorkspace('automatic-staging', async workspace => {
    const archive = new PrismaClient({ datasourceUrl: archiveConnectionUrl('loader') });
    try {
      const [identity] = await archive.$queryRaw<Array<{ database: string; role: string }>>`
        SELECT current_database() AS database, current_user AS role
      `;
      if (identity.database !== 'funda_mrp_archive' || identity.role !== 'archive_loader') throw new Error('Batch Archive identity is invalid');
      const covered = await archive.archiveRunCoverage.findMany({ where: { sourceInstance }, include: { tables: true, source: { include: { source: true } } } });
      if (covered.some(run => {
        const generation = run.source.source.schemaGeneration;
        return run.status !== 'verified' || (generation !== 'G1' && generation !== 'G4') || !hasCompleteTableEvidence(generation, run.tables);
      })) {
        throw new Error('Existing Archive coverage is incomplete; inspect before batch import');
      }
      const existing = new Set(covered.map(run => run.sourceRunId));
      const candidates = manifest.runCoverage.runIds.filter(id =>
        id >= minimumRunId && !existing.has(id) && (!selected || selected.has(id)));
      if (!candidates.length) return { outcome: 'nothing-to-import' as const, sha256, imported: [], pending: [] };
      await resetArchiveWorkspace(workspace);
      await workspace.client.$executeRawUnsafe('CREATE SCHEMA archive_restore');
      await workspace.client.$executeRawUnsafe(`CREATE TABLE archive_restore.receipt (
        id integer PRIMARY KEY CHECK (id = 1), source_sha256 char(64) NOT NULL,
        source_instance text NOT NULL, schema_generation text NOT NULL,
        status text NOT NULL, schema_digest char(64), fingerprints jsonb, completed_at timestamptz)`);
      await restoreArchiveSeed(dumpPath, sourceInstance, workspace);
      const { manifest: restored } = await verifyArchiveSeed(dumpPath);
      if (restored.sha256 !== sha256) throw new Error('Batch source changed during restore');
      const imported: number[] = [];
      const pending: number[] = [];
      for (const id of candidates) {
        await assertLockedWorkspace(workspace);
        const [run] = await workspace.client.$queryRaw<Array<{ status: string }>>`SELECT status FROM public.mrp_run WHERE id = ${id}`;
        if (run?.status !== 'completed') { pending.push(id); continue; }
        await importArchiveRun(id, workspace);
        imported.push(id);
      }
      return { outcome: 'imported' as const, sha256, imported, pending };
    } finally { await archive.$disconnect(); }
  });
}
