import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from './db';

const LAST_AUTOMATIC_RESULT_KEY = 'database_backup_last_automatic_result';
const AUTOMATIC_BACKUP_FILE_PATTERN =
  /^funda_mrp_auto_\d{8}_\d{6}_\d{3}\.dump$/;
const RESULT_KEYS = new Set([
  'outcome',
  'startedAt',
  'completedAt',
  'durationMs',
  'fileName',
  'sizeBytes',
]);

export type AutomaticDatabaseBackupOutcome =
  | 'completed'
  | 'skipped-active-run'
  | 'skipped-locked'
  | 'rotation-failed'
  | 'failed';

export interface AutomaticDatabaseBackupResult {
  outcome: AutomaticDatabaseBackupOutcome;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fileName: string | null;
  sizeBytes: number | null;
}

interface CreateAutomaticDatabaseBackupResultInput {
  outcome: AutomaticDatabaseBackupOutcome;
  startedAt: Date;
  completedAt: Date;
  fileName?: string | null;
  sizeBytes?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAutomaticDatabaseBackupResult(
  input: CreateAutomaticDatabaseBackupResultInput,
): AutomaticDatabaseBackupResult {
  return {
    outcome: input.outcome,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: Math.max(
      0,
      input.completedAt.getTime() - input.startedAt.getTime(),
    ),
    fileName: input.fileName ?? null,
    sizeBytes: input.sizeBytes ?? null,
  };
}

export function parseAutomaticDatabaseBackupResult(
  value: unknown,
): AutomaticDatabaseBackupResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !RESULT_KEYS.has(key))
  ) {
    return null;
  }

  const validOutcome =
    value.outcome === 'completed' ||
    value.outcome === 'skipped-active-run' ||
    value.outcome === 'skipped-locked' ||
    value.outcome === 'rotation-failed' ||
    value.outcome === 'failed';
  const validStartedAt =
    typeof value.startedAt === 'string' &&
    Number.isFinite(Date.parse(value.startedAt));
  const validCompletedAt =
    typeof value.completedAt === 'string' &&
    Number.isFinite(Date.parse(value.completedAt));
  const hasPublishedBackup =
    value.outcome === 'completed' || value.outcome === 'rotation-failed';
  const validPublishedBackup = hasPublishedBackup
    ? typeof value.fileName === 'string' &&
      AUTOMATIC_BACKUP_FILE_PATTERN.test(value.fileName) &&
      typeof value.sizeBytes === 'number' &&
      Number.isFinite(value.sizeBytes) &&
      value.sizeBytes > 0
    : value.fileName === null && value.sizeBytes === null;

  if (
    !validOutcome ||
    !validStartedAt ||
    !validCompletedAt ||
    !Number.isFinite(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !validPublishedBackup
  ) {
    return null;
  }

  return {
    outcome: value.outcome as AutomaticDatabaseBackupOutcome,
    startedAt: value.startedAt as string,
    completedAt: value.completedAt as string,
    durationMs: value.durationMs as number,
    fileName: value.fileName as string | null,
    sizeBytes: value.sizeBytes as number | null,
  };
}

export async function getLastAutomaticDatabaseBackupResult(
  client: PrismaClient = prisma,
): Promise<AutomaticDatabaseBackupResult | null> {
  const row = await client.appSetting.findUnique({
    where: { key: LAST_AUTOMATIC_RESULT_KEY },
    select: { value: true },
  });
  return parseAutomaticDatabaseBackupResult(row?.value);
}

export async function saveLastAutomaticDatabaseBackupResult(
  result: AutomaticDatabaseBackupResult,
  client: PrismaClient = prisma,
): Promise<void> {
  const value = result as unknown as Prisma.InputJsonValue;
  await client.appSetting.upsert({
    where: { key: LAST_AUTOMATIC_RESULT_KEY },
    create: { key: LAST_AUTOMATIC_RESULT_KEY, value },
    update: { value },
  });
}
