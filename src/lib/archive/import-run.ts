import { PrismaClient } from '.prisma/archive-client';
import { archiveConnectionUrl } from './connection';
import { ARCHIVE_RUN_TABLES, hasCompleteTableEvidence, type ArchiveTableEvidence } from './coverage';
import { assertRestoreIdentity, loadRestoreReceipt, restoreConnectionUrl } from './restore-seed';
import { assertWorkspaceTransaction, type LockedArchiveWorkspace } from './workspace';
import {
  ARCHIVE_IMPORT_VERSION, assertSourceSchema, columnsFor, insertSnapshotBatch,
  missingColumns, RESTORE_LOCK, streamSnapshot,
} from './snapshot-data';

export async function importArchiveRun(sourceRunId: number, workspace?: LockedArchiveWorkspace) {
  if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) throw new Error('A positive source Run ID is required');
  const archiveUrl = new URL(archiveConnectionUrl('loader'));
  archiveUrl.searchParams.set('connection_limit', '1');
  archiveUrl.searchParams.set('max_idle_connection_lifetime', '0');
  archiveUrl.searchParams.set('max_connection_lifetime', '0');
  const archive = new PrismaClient({ datasourceUrl: archiveUrl.toString() });
  const source = workspace?.client ?? new PrismaClient({ datasourceUrl: restoreConnectionUrl() });
  let archiveLock: string | null = null;
  let attemptId: string | null = null;
  try {
    await assertRestoreIdentity(source, workspace);
    const [identity] = await archive.$queryRaw<Array<{ database: string; role: string }>>`
      SELECT current_database() AS database, current_user AS role
    `;
    if (identity?.database !== 'funda_mrp_archive' || identity.role !== 'archive_loader') {
      throw new Error('Archive import requires archive_loader on funda_mrp_archive');
    }
    return await source.$transaction(async sourceTx => {
      await sourceTx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await sourceTx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      if (workspace) await assertWorkspaceTransaction(workspace, sourceTx);
      const [sourceLock] = await sourceTx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${RESTORE_LOCK}) AS acquired
      `;
      if (!sourceLock.acquired) throw new Error('Archive staging is busy');
      const receipt = await loadRestoreReceipt(sourceTx);
      if (!receipt || receipt.status !== 'ready' || !receipt.fingerprints?.[sourceRunId]) {
        throw new Error('No verified restore receipt for the requested Run');
      }
      if (await assertSourceSchema(sourceTx, receipt.schemaGeneration) !== receipt.schemaDigest) {
        throw new Error('Restore schema changed after verification');
      }
      const registered = await archive.archiveSourceRun.findUnique({
        where: { sourceSha256_sourceRunId: { sourceSha256: receipt.sourceSha256, sourceRunId } },
      });
      if (!registered || registered.sourceInstance !== receipt.sourceInstance) throw new Error('Restore source provenance is not registered');
      const lockKey = `archive-run:${receipt.sourceInstance}:${sourceRunId}`;
      const [lock] = await archive.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS acquired
      `;
      if (!lock.acquired) throw new Error('This Archive Run is already being imported');
      archiveLock = lockKey;
      // The previous owner cannot still hold the Run lock; unfinished attempts are recoverable.
      await archive.archiveImportAttempt.updateMany({
        where: { sourceRunId, source: { sourceInstance: receipt.sourceInstance }, status: { in: ['pending', 'importing', 'verifying'] } },
        data: { status: 'interrupted', completedAt: new Date(), errorCode: 'previous-owner-ended' },
      });
      const attempt = await archive.archiveImportAttempt.create({ data: {
        sourceSha256: receipt.sourceSha256, sourceRunId, status: 'importing', importerVersion: ARCHIVE_IMPORT_VERSION,
      } });
      attemptId = attempt.id;
      return await archive.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
        const existing = await tx.archiveRunCoverage.findUnique({
          where: { sourceInstance_sourceRunId: { sourceInstance: receipt.sourceInstance, sourceRunId } },
          include: { tables: true },
        });
        if (existing && (existing.sourceSha256 !== receipt.sourceSha256 || existing.status !== 'verified')) {
          throw new Error('Archive Run source is already pinned or its coverage is not verified');
        }
        const [run] = await sourceTx.$queryRaw<Array<{ versionCode: string; runDate: string; status: string }>>`
          SELECT version_code AS "versionCode", run_date::text AS "runDate", status FROM public.mrp_run WHERE id = ${sourceRunId}
        `;
        if (!run) throw new Error('Source Run disappeared');
        const coverage = existing ?? await tx.archiveRunCoverage.create({ data: {
          sourceInstance: receipt.sourceInstance, sourceRunId, sourceSha256: receipt.sourceSha256,
          attemptId: attempt.id, versionCode: run.versionCode, runDate: new Date(run.runDate),
          sourceStatus: run.status, sourceRun: {}, status: 'importing',
        } });
        const evidence: ArchiveTableEvidence[] = [];
        for (const table of ARCHIVE_RUN_TABLES) {
          const expected = receipt.fingerprints![sourceRunId][table];
          const present = columnsFor(receipt.schemaGeneration, table) !== null;
          let original: { rows: string; digest: string } | null = null;
          if (present) {
            original = await streamSnapshot(sourceTx, table, receipt.schemaGeneration, { sourceRunId },
              existing ? undefined : async rows => {
                await insertSnapshotBatch(tx, table, coverage.id, rows);
                if (table === 'public.mrp_run') {
                  await tx.$executeRaw`
                    UPDATE archive_meta.archive_run_coverage SET source_run = ${rows[0]}::jsonb,
                      order_demand_contract_version = ${rows[0]}::jsonb ->> 'order_demand_contract_version'
                    WHERE id = ${coverage.id}::uuid
                  `;
                }
              });
            if (!expected || expected.rows !== original.rows || expected.digest !== original.digest) {
              throw new Error(`Restored snapshot changed: ${table}`);
            }
          } else if (expected !== null) {
            throw new Error(`Restore receipt has invalid absence evidence: ${table}`);
          }
          const copied = await streamSnapshot(tx, table, receipt.schemaGeneration, { archiveRunId: coverage.id });
          if (present ? copied.rows !== original!.rows || copied.digest !== original!.digest : copied.rows !== '0') {
            throw new Error(`Archive snapshot verification failed: ${table}`);
          }
          const record = {
            tableName: table, status: present ? 'verified' : 'not-in-source', sourcePresent: present,
            sourceColumns: columnsFor(receipt.schemaGeneration, table)?.map(column => column.name) ?? [],
            missingColumns: missingColumns(receipt.schemaGeneration, table),
            sourceRows: present ? BigInt(original!.rows) : null, archiveRows: BigInt(copied.rows),
            sourceDigest: original?.digest ?? null, archiveDigest: present ? copied.digest : null, verifiedAt: new Date(),
          };
          if (existing) {
            const stored = existing.tables.find(item => item.tableName === table);
            if (!stored || stored.status !== record.status || stored.sourcePresent !== record.sourcePresent ||
                stored.sourceRows !== record.sourceRows || stored.archiveRows !== record.archiveRows ||
                stored.sourceDigest !== record.sourceDigest || stored.archiveDigest !== record.archiveDigest ||
                JSON.stringify(stored.sourceColumns) !== JSON.stringify(record.sourceColumns) ||
                JSON.stringify(stored.missingColumns) !== JSON.stringify(record.missingColumns)) {
              throw new Error(`Archive table evidence changed: ${table}`);
            }
            evidence.push(stored);
          } else {
            evidence.push(await tx.archiveTableVerification.create({ data: { archiveRunId: coverage.id, ...record } }));
          }
        }
        if (!hasCompleteTableEvidence(receipt.schemaGeneration, evidence)) throw new Error('Incomplete Archive table verification');
        if (!existing) await tx.archiveRunCoverage.update({ where: { id: coverage.id }, data: { status: 'verified', verifiedAt: new Date() } });
        await tx.archiveImportAttempt.update({ where: { id: attempt.id }, data: { status: 'verified', completedAt: new Date() } });
        return { outcome: existing ? 'already-imported' as const : 'imported' as const, archiveRunId: coverage.id, sourceRunId, tablesVerified: evidence.length };
      }, { timeout: 1_800_000 });
    }, { isolationLevel: 'RepeatableRead', timeout: 1_800_000 });
  } catch (error) {
    if (attemptId) {
      // A lost COMMIT response must not downgrade a transaction that actually committed.
      await archive.archiveImportAttempt.updateMany({
        where: { id: attemptId, status: { in: ['pending', 'importing', 'verifying'] } },
        data: { status: 'failed', completedAt: new Date(), errorCode: 'import-or-verification-failed' },
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (archiveLock) await archive.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${archiveLock}, 0))`.catch(() => undefined);
    if (!workspace) await source.$disconnect();
    await archive.$disconnect();
  }
}
