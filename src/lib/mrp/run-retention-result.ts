import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../db';
import {
  isArchiveRetentionDenialReason,
  type ArchiveRetentionDeniedDecision,
} from '../archive/archive-retention-gate';

const LAST_AUTOMATIC_RESULT_KEY = 'mrp_run_retention_last_automatic_result';

export type AutomaticRunRetentionOutcome =
  | 'deleted'
  | 'no-candidate'
  | 'archive-blocked'
  | 'partial-archive-blocked'
  | 'partial-failure'
  | 'failed';

export interface AutomaticRunRetentionResult {
  outcome: AutomaticRunRetentionOutcome;
  candidateIds: number[];
  deletedIds: number[];
  archiveBlocks: ArchiveRetentionDeniedDecision[];
  failureCount: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string | null;
}

interface CreateAutomaticRunRetentionResultInput {
  startedAt: Date;
  completedAt: Date;
  candidateIds?: number[];
  deletedIds?: number[];
  archiveBlocks?: ArchiveRetentionDeniedDecision[];
  failureCount?: number;
  error?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item > 0)
  );
}

function parseArchiveBlocks(
  value: unknown,
): ArchiveRetentionDeniedDecision[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const blocks: ArchiveRetentionDeniedDecision[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      item.allowed !== false ||
      !Number.isInteger(item.runId) ||
      (item.runId as number) < 1 ||
      !isArchiveRetentionDenialReason(item.reason)
    ) {
      return null;
    }
    blocks.push({
      allowed: false,
      runId: item.runId as number,
      reason: item.reason,
    });
  }
  return blocks;
}

export function createAutomaticRunRetentionResult(
  input: CreateAutomaticRunRetentionResultInput,
): AutomaticRunRetentionResult {
  const candidateIds = input.candidateIds ?? [];
  const deletedIds = input.deletedIds ?? [];
  const archiveBlocks = input.archiveBlocks ?? [];
  const failureCount = input.failureCount ?? 0;
  const error = input.error ?? null;
  const outcome: AutomaticRunRetentionOutcome =
    error || (failureCount > 0 && deletedIds.length === 0)
      ? 'failed'
      : failureCount > 0
        ? 'partial-failure'
        : deletedIds.length > 0
          ? archiveBlocks.length > 0
            ? 'partial-archive-blocked'
            : 'deleted'
          : archiveBlocks.length > 0
            ? 'archive-blocked'
            : 'no-candidate';

  return {
    outcome,
    candidateIds,
    deletedIds,
    archiveBlocks,
    failureCount,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: Math.max(
      0,
      input.completedAt.getTime() - input.startedAt.getTime(),
    ),
    error,
  };
}

export function parseAutomaticRunRetentionResult(
  value: unknown,
): AutomaticRunRetentionResult | null {
  if (!isRecord(value)) return null;

  const archiveBlocks = parseArchiveBlocks(value.archiveBlocks);

  const validOutcome =
    value.outcome === 'deleted' ||
    value.outcome === 'no-candidate' ||
    value.outcome === 'archive-blocked' ||
    value.outcome === 'partial-archive-blocked' ||
    value.outcome === 'partial-failure' ||
    value.outcome === 'failed';
  const validStartedAt =
    typeof value.startedAt === 'string' &&
    Number.isFinite(Date.parse(value.startedAt));
  const validCompletedAt =
    typeof value.completedAt === 'string' &&
    Number.isFinite(Date.parse(value.completedAt));
  const validError = value.error === null || typeof value.error === 'string';

  if (
    !validOutcome ||
    !isNumberArray(value.candidateIds) ||
    !isNumberArray(value.deletedIds) ||
    archiveBlocks === null ||
    !Number.isInteger(value.failureCount) ||
    (value.failureCount as number) < 0 ||
    !validStartedAt ||
    !validCompletedAt ||
    !Number.isFinite(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !validError
  ) {
    return null;
  }

  return {
    outcome: value.outcome as AutomaticRunRetentionOutcome,
    candidateIds: value.candidateIds,
    deletedIds: value.deletedIds,
    archiveBlocks,
    failureCount: value.failureCount as number,
    startedAt: value.startedAt as string,
    completedAt: value.completedAt as string,
    durationMs: value.durationMs as number,
    error: value.error as string | null,
  };
}

export async function getLastAutomaticRunRetentionResult(
  client: PrismaClient = prisma,
): Promise<AutomaticRunRetentionResult | null> {
  const row = await client.appSetting.findUnique({
    where: { key: LAST_AUTOMATIC_RESULT_KEY },
    select: { value: true },
  });
  return parseAutomaticRunRetentionResult(row?.value);
}

export async function saveLastAutomaticRunRetentionResult(
  result: AutomaticRunRetentionResult,
  client: PrismaClient = prisma,
): Promise<void> {
  const value = result as unknown as Prisma.InputJsonValue;
  await client.appSetting.upsert({
    where: { key: LAST_AUTOMATIC_RESULT_KEY },
    create: { key: LAST_AUTOMATIC_RESULT_KEY, value },
    update: { value },
  });
}
