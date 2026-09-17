import { Prisma, PrismaClient } from '.prisma/archive-client';
import { archiveConnectionUrl } from './connection';
import { verifyArchiveSeed } from './seed-manifest';

export async function registerArchiveSeed(dumpPath: string, sourceInstance: string) {
  if (!sourceInstance.trim() || sourceInstance.length > 200 || sourceInstance !== sourceInstance.trim()) {
    throw new Error('A stable Archive source instance is required');
  }
  const { manifest, hashVerifiedAt } = await verifyArchiveSeed(dumpPath);
  const client = new PrismaClient({ datasourceUrl: archiveConnectionUrl('loader') });
  try {
    const [identity] = await client.$queryRaw<Array<{ database: string; role: string }>>`
      SELECT current_database() AS database, current_user AS role
    `;
    if (identity.database !== 'funda_mrp_archive' || identity.role !== 'archive_loader') {
      throw new Error('Archive seed registration requires archive_loader on funda_mrp_archive');
    }
    return await client.$transaction(async tx => {
      const existing = await tx.archiveSource.findUnique({
        where: { sha256: manifest.sha256 }, include: { runs: true },
      });
      if (existing) {
        const ids = existing.runs.map(run => run.sourceRunId).sort((a, b) => a - b);
        if (existing.sourceInstance !== sourceInstance || existing.schemaGeneration !== manifest.schemaGeneration ||
            existing.sizeBytes !== BigInt(manifest.sizeBytes) ||
            JSON.stringify(ids) !== JSON.stringify(manifest.runCoverage.runIds)) {
          throw new Error('Registered Archive seed provenance conflicts with this request');
        }
        return { outcome: 'already-registered' as const, sha256: manifest.sha256, runCount: ids.length };
      }
      await tx.archiveSource.create({ data: {
        sha256: manifest.sha256, sourceInstance,
        seedFileName: manifest.seedFileName, sourceFileName: manifest.sourceFileName,
        schemaGeneration: manifest.schemaGeneration, sizeBytes: BigInt(manifest.sizeBytes),
        manifest: manifest as unknown as Prisma.InputJsonValue, hashVerifiedAt,
      } });
      await tx.archiveSourceRun.createMany({ data: manifest.runCoverage.runIds.map(sourceRunId => ({
        sourceSha256: manifest.sha256, sourceInstance, sourceRunId,
      })) });
      // Source registration must never create an import attempt or verified Run coverage.
      return { outcome: 'registered' as const, sha256: manifest.sha256, runCount: manifest.runCoverage.count };
    });
  } finally {
    await client.$disconnect();
  }
}
