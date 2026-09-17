/**
 * Per-record editing lock for fg_monthly — optimistic lock using
 * editing_by + editing_since with a time-based expiry.
 *
 * NOTE: MRP-run concurrency control no longer lives here. It used to use a
 * session-level pg_advisory_lock, which leaked under Prisma's connection pool
 * (the unlock often ran on a different pooled connection than the lock). It is
 * now handled in run-orchestrator.ts: the mrp_run record in an active status
 * IS the lock, claimed atomically via a transaction-scoped pg_advisory_xact_lock.
 */
import prisma from './db';

/**
 * Acquire a per-record editing lock on fg_monthly
 * Returns true if lock acquired, false if someone else is editing
 */
export async function acquireRecordLock(
  mrpRunId: number,
  partVersion: string,
  userId: string,
): Promise<boolean> {
  const LOCK_EXPIRY_MINUTES = 5;

  // 嘗試搶鎖 — 以下三種狀況才成功：
  // 1. 沒人在編輯 (editing_by IS NULL)
  // 2. 當前 user 本來就持有鎖
  // 3. 鎖已過期 (超過 LOCK_EXPIRY_MINUTES 分鐘)
  //
  // 注意：原本用 `INTERVAL '${LOCK_EXPIRY_MINUTES} minutes'` 在 prisma 的
  // tagged template 內，會被 bind 成 placeholder `INTERVAL '$1 minutes'`，
  // PostgreSQL 對 INTERVAL literal 內的 placeholder 不認得 → syntax error。
  // 改用 MAKE_INTERVAL(mins => INT)，placeholder 是 INT 參數合法。
  const result = await prisma.$executeRaw`
    UPDATE mrp_out.fg_monthly
    SET editing_by = ${userId}, editing_since = NOW()
    WHERE mrp_run_id = ${mrpRunId}
      AND part_version = ${partVersion}
      AND (
        editing_by IS NULL
        OR editing_by = ${userId}
        OR editing_since < NOW() - MAKE_INTERVAL(mins => ${LOCK_EXPIRY_MINUTES})
      )
  `;

  return result > 0;
}

/**
 * Release a per-record editing lock
 */
export async function releaseRecordLock(
  mrpRunId: number,
  partVersion: string,
  userId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE mrp_out.fg_monthly
    SET editing_by = NULL, editing_since = NULL
    WHERE mrp_run_id = ${mrpRunId}
      AND part_version = ${partVersion}
      AND editing_by = ${userId}
  `;
}
