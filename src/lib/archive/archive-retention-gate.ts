import type { Prisma as ArchivePrisma } from '.prisma/archive-client';
import { openArchiveReader } from '../archive-db';
import { currentDbMode, isDbMode } from '../db';
import { archiveConnectionUrl } from './connection';
import {
  ARCHIVE_RUN_TABLES,
  hasCompleteTableEvidence,
  type ArchiveTableEvidence,
} from './coverage';
import type { ArchiveSchemaGeneration } from './seed-manifest';
import {
  missingColumns,
  quotedTable,
  streamSnapshot,
  type ArchiveRunTable,
} from './snapshot-data';

export const ARCHIVE_RETENTION_DENIAL_REASONS = [
  'gate-disabled',
  'archive-not-configured',
  'source-database-mismatch',
  'archive-unreachable',
  'coverage-missing',
  'ingest-not-verified',
  'dump-hash-not-verified',
  'required-tables-not-verified',
  'live-snapshot-mismatch',
] as const;

export type ArchiveRetentionDenialReason =
  (typeof ARCHIVE_RETENTION_DENIAL_REASONS)[number];

export interface ArchiveRetentionDeniedDecision {
  allowed: false;
  runId: number;
  reason: ArchiveRetentionDenialReason;
}

export interface ArchiveRetentionAllowedDecision {
  allowed: true;
  runId: number;
  verifiedAt: string;
}

export type ArchiveRetentionDecision =
  | ArchiveRetentionDeniedDecision
  | ArchiveRetentionAllowedDecision;

export type ArchiveRetentionLiveSnapshotReader = Pick<
  ArchivePrisma.TransactionClient,
  '$executeRawUnsafe' | '$queryRawUnsafe'
>;

export type ArchiveRetentionPreflight = (
  runId: number,
) => Promise<ArchiveRetentionDecision>;

export type ArchiveRetentionGate = (
  runId: number,
  live: ArchiveRetentionLiveSnapshotReader,
) => Promise<ArchiveRetentionDecision>;

export interface ArchiveRetentionGateStatus {
  enabled: boolean;
  coverageReady: boolean;
  reason: ArchiveRetentionDenialReason | null;
}

type ArchiveRetentionEnv = Record<string, string | undefined>;

interface ArchiveRetentionCoverage {
  sourceInstance: string;
  sourceRunId: number;
  sourceSha256: string;
  sourceStatus: string;
  status: string;
  verifiedAt: Date | null;
  attempt: { status: string; completedAt: Date | null };
  source: {
    sourceSha256: string;
    sourceInstance: string;
    source: {
      sha256: string;
      sourceInstance: string;
      schemaGeneration: string;
      hashVerifiedAt: Date;
    };
  };
  tables: ArchiveTableEvidence[];
}

interface VerifiedArchiveRetentionCoverage {
  decision: ArchiveRetentionAllowedDecision;
  coverage: ArchiveRetentionCoverage;
  generation: ArchiveSchemaGeneration;
}

type ArchiveRetentionEvaluation =
  | { decision: ArchiveRetentionDeniedDecision }
  | VerifiedArchiveRetentionCoverage;

type ArchiveCoverageLookup = (
  sourceInstance: string,
  sourceRunId: number,
) => Promise<ArchiveRetentionCoverage | null>;

type LiveSnapshotComparison = (
  runId: number,
  live: ArchiveRetentionLiveSnapshotReader,
  verified: VerifiedArchiveRetentionCoverage,
) => Promise<boolean>;

const SAFE_G1_LIVE_MIGRATION_DEFAULTS: Record<string, string> = {
  'public.mrp_run.order_demand_contract_version': "'order-demand-v1'::text",
  'staging.work_order_bom.movement_detail_count': '0',
  'staging.work_order_bom.movement_state': "'fallback'::text",
  'mrp_out.component_weekly.future_purchase_count': '0',
  'mrp_out.component_weekly.future_purchase_qty': '0::numeric',
  'mrp_out.component_weekly.overdue_purchase_count': '0',
  'mrp_out.component_weekly.overdue_purchase_qty': '0::numeric',
  'mrp_out.component_weekly.shortage_qty': '0::numeric',
};

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function isArchiveRetentionDenialReason(
  value: unknown,
): value is ArchiveRetentionDenialReason {
  return ARCHIVE_RETENTION_DENIAL_REASONS.includes(
    value as ArchiveRetentionDenialReason,
  );
}

export function getArchiveRetentionGateStatus(
  env: ArchiveRetentionEnv = process.env,
): ArchiveRetentionGateStatus {
  if (!isEnabled(env.MRP_RUN_ARCHIVE_GATE_ENABLED)) {
    return { enabled: false, coverageReady: false, reason: 'gate-disabled' };
  }

  const sourceInstance = env.MRP_RUN_ARCHIVE_SOURCE_INSTANCE;
  if (
    !sourceInstance ||
    sourceInstance !== sourceInstance.trim() ||
    sourceInstance.length > 200
  ) {
    return { enabled: true, coverageReady: false, reason: 'archive-not-configured' };
  }
  const sourceDbMode = env.MRP_RUN_ARCHIVE_SOURCE_DB_MODE;
  if (!isDbMode(sourceDbMode) || sourceDbMode !== currentDbMode()) {
    return { enabled: true, coverageReady: false, reason: 'source-database-mismatch' };
  }
  try {
    archiveConnectionUrl('reader', env);
  } catch {
    return { enabled: true, coverageReady: false, reason: 'archive-not-configured' };
  }

  // Configuration alone is not proof that any concrete Run can be deleted.
  return { enabled: true, coverageReady: false, reason: null };
}

async function loadArchiveRetentionCoverage(
  sourceInstance: string,
  sourceRunId: number,
) {
  const reader = await openArchiveReader();
  try {
    return await reader.archiveRunCoverage.findUnique({
      where: { sourceInstance_sourceRunId: { sourceInstance, sourceRunId } },
      include: {
        attempt: true,
        tables: true,
        source: { include: { source: true } },
      },
    });
  } finally {
    await reader.$disconnect().catch(() => undefined);
  }
}

function denied(
  runId: number,
  reason: ArchiveRetentionDenialReason,
): ArchiveRetentionDeniedDecision {
  return { allowed: false, runId, reason };
}

async function evaluateArchiveRetentionCoverage(
  runId: number,
  lookup: ArchiveCoverageLookup,
  env: ArchiveRetentionEnv,
): Promise<ArchiveRetentionEvaluation> {
  const gateStatus = getArchiveRetentionGateStatus(env);
  if (!gateStatus.enabled) return { decision: denied(runId, 'gate-disabled') };
  if (gateStatus.reason) {
    return { decision: denied(runId, gateStatus.reason) };
  }
  if (!Number.isSafeInteger(runId) || runId < 1) {
    return { decision: denied(runId, 'coverage-missing') };
  }

  const sourceInstance = env.MRP_RUN_ARCHIVE_SOURCE_INSTANCE!;
  let coverage: ArchiveRetentionCoverage | null;
  try {
    coverage = await lookup(sourceInstance, runId);
  } catch {
    return { decision: denied(runId, 'archive-unreachable') };
  }
  if (!coverage) return { decision: denied(runId, 'coverage-missing') };
  if (
    coverage.sourceInstance !== sourceInstance ||
    coverage.sourceRunId !== runId ||
    coverage.sourceStatus !== 'completed' ||
    coverage.status !== 'verified' ||
    coverage.attempt.status !== 'verified' ||
    !coverage.attempt.completedAt ||
    !Number.isFinite(coverage.attempt.completedAt.getTime()) ||
    !coverage.verifiedAt ||
    !Number.isFinite(coverage.verifiedAt.getTime())
  ) {
    return { decision: denied(runId, 'ingest-not-verified') };
  }

  const sourceRun = coverage.source;
  const source = sourceRun.source;
  if (
    sourceRun.sourceInstance !== sourceInstance ||
    source.sourceInstance !== sourceInstance ||
    sourceRun.sourceSha256 !== coverage.sourceSha256 ||
    source.sha256 !== coverage.sourceSha256 ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !Number.isFinite(source.hashVerifiedAt.getTime())
  ) {
    return { decision: denied(runId, 'dump-hash-not-verified') };
  }
  if (
    !['G1', 'G4'].includes(source.schemaGeneration) ||
    !hasCompleteTableEvidence(
      source.schemaGeneration as ArchiveSchemaGeneration,
      coverage.tables,
    )
  ) {
    return { decision: denied(runId, 'required-tables-not-verified') };
  }

  return {
    decision: {
      allowed: true,
      runId,
      verifiedAt: coverage.verifiedAt.toISOString(),
    },
    coverage,
    generation: source.schemaGeneration as ArchiveSchemaGeneration,
  };
}

async function relationExists(
  live: ArchiveRetentionLiveSnapshotReader,
  table: ArchiveRunTable,
): Promise<boolean> {
  const rows = await live.$queryRawUnsafe<Array<{ present: boolean }>>(
    'SELECT to_regclass($1::text) IS NOT NULL AS present',
    table,
  );
  return rows[0]?.present === true;
}

async function emptyRunTable(
  live: ArchiveRetentionLiveSnapshotReader,
  table: ArchiveRunTable,
  runId: number,
): Promise<boolean> {
  if (!(await relationExists(live, table))) return true;
  const rows = await live.$queryRawUnsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count FROM ${quotedTable(table)} WHERE mrp_run_id = $1::integer`,
    runId,
  );
  return rows[0]?.count === '0';
}

async function hasOnlyArchivedGenerationValues(
  live: ArchiveRetentionLiveSnapshotReader,
  table: ArchiveRunTable,
  generation: ArchiveSchemaGeneration,
  runId: number,
): Promise<boolean> {
  const generationMissingColumns = missingColumns(generation, table);
  if (generationMissingColumns.length === 0) return true;
  const liveColumns = await live.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT attname AS name
     FROM pg_attribute
     WHERE attrelid = to_regclass($1::text)
       AND attnum > 0
       AND NOT attisdropped`,
    table,
  );
  const existing = new Set(liveColumns.map((column) => column.name));
  const addedColumns = generationMissingColumns.filter((column) => existing.has(column));
  if (addedColumns.length === 0) return true;

  const differsFromArchive = addedColumns.map((column) => {
    const migrationDefault = SAFE_G1_LIVE_MIGRATION_DEFAULTS[`${table}.${column}`];
    return migrationDefault
      ? `"${column}" IS DISTINCT FROM ${migrationDefault}`
      : `"${column}" IS NOT NULL`;
  }).join(' OR ');
  const key = table === 'public.mrp_run' ? 'id' : 'mrp_run_id';
  const rows = await live.$queryRawUnsafe<Array<{ changed: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM ${quotedTable(table)}
       WHERE "${key}" = $1::integer AND (${differsFromArchive})
     ) AS changed`,
    runId,
  );
  return rows[0]?.changed === false;
}

async function compareLiveArchiveSnapshot(
  runId: number,
  live: ArchiveRetentionLiveSnapshotReader,
  verified: VerifiedArchiveRetentionCoverage,
): Promise<boolean> {
  await live.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  const evidence = new Map(
    verified.coverage.tables.map((table) => [table.tableName, table]),
  );

  for (const table of ARCHIVE_RUN_TABLES) {
    const expected = evidence.get(table)!;
    if (!expected.sourcePresent) {
      if (!(await emptyRunTable(live, table, runId))) return false;
      continue;
    }
    if (!(await hasOnlyArchivedGenerationValues(
      live,
      table,
      verified.generation,
      runId,
    ))) return false;

    const actual = await streamSnapshot(
      live as ArchivePrisma.TransactionClient,
      table,
      verified.generation,
      { sourceRunId: runId },
    );
    if (
      expected.sourceRows === null ||
      actual.rows !== expected.sourceRows.toString() ||
      actual.digest !== expected.sourceDigest
    ) {
      return false;
    }
  }
  return true;
}

export function createArchiveRetentionPreflight(
  lookup: ArchiveCoverageLookup = loadArchiveRetentionCoverage,
  env: ArchiveRetentionEnv = process.env,
): ArchiveRetentionPreflight {
  return async (runId) =>
    (await evaluateArchiveRetentionCoverage(runId, lookup, env)).decision;
}

export function createArchiveRetentionGate(
  lookup: ArchiveCoverageLookup = loadArchiveRetentionCoverage,
  env: ArchiveRetentionEnv = process.env,
  compareLive: LiveSnapshotComparison = compareLiveArchiveSnapshot,
): ArchiveRetentionGate {
  return async (runId, live) => {
    const verified = await evaluateArchiveRetentionCoverage(runId, lookup, env);
    if (!('coverage' in verified)) return verified.decision;
    try {
      if (!(await compareLive(runId, live, verified))) {
        return denied(runId, 'live-snapshot-mismatch');
      }
    } catch {
      return denied(runId, 'live-snapshot-mismatch');
    }
    return verified.decision;
  };
}

export const archiveRetentionPreflight = createArchiveRetentionPreflight();
export const archiveRetentionGate = createArchiveRetentionGate();

export async function getArchiveRetentionGateStatusForRun(
  runId: number,
  preflight: ArchiveRetentionPreflight = archiveRetentionPreflight,
): Promise<ArchiveRetentionGateStatus> {
  const staticStatus = getArchiveRetentionGateStatus();
  if (!staticStatus.enabled || staticStatus.reason) return staticStatus;
  const decision = await preflight(runId);
  return decision.allowed
    ? { enabled: true, coverageReady: true, reason: null }
    : { enabled: true, coverageReady: false, reason: decision.reason };
}
