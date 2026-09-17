import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  markPendingTransferUnknown,
  recoverStalePendingTransfers,
  TRANSFER_PENDING_STALE_MS,
} from './transfer-recovery';
import { TRANSFER_STATUS } from '../transfer-state';

type RecoveryClient = Pick<PrismaClient, 'fgPlanSuggestion'>;

test('process 中斷後，下次讀取將過期 pending 轉成 unknown 而非開放重試', async () => {
  let args: unknown;
  const client = {
    fgPlanSuggestion: {
      updateMany: async (input: unknown) => {
        args = input;
        return { count: 1 };
      },
    },
  } as unknown as RecoveryClient;
  const now = new Date('2026-07-13T08:00:00.000Z');

  const count = await recoverStalePendingTransfers(
    client,
    { mrpRunId: 15, partVersion: 'TEST-V01', planSequence: 2 },
    now,
  );

  assert.equal(count, 1);
  assert.deepEqual(args, {
    where: {
      mrpRunId: 15,
      partVersion: 'TEST-V01',
      planSequence: 2,
      isTransferred: false,
      transferStatus: TRANSFER_STATUS.PENDING,
      OR: [
        { transferStartedAt: null },
        { transferStartedAt: { lt: new Date(now.getTime() - TRANSFER_PENDING_STALE_MS) } },
      ],
    },
    data: {
      transferStatus: TRANSFER_STATUS.UNKNOWN,
      transferError: '轉單流程中斷，Ragic 結果待確認；系統已鎖定重試以避免重複建單。',
      transferStartedAt: null,
    },
  });
});

test('claim 後的非預期例外只會把仍為 pending 的同一筆標為 unknown', async () => {
  let args: unknown;
  const client = {
    fgPlanSuggestion: {
      updateMany: async (input: unknown) => {
        args = input;
        return { count: 1 };
      },
    },
  } as unknown as RecoveryClient;

  await markPendingTransferUnknown(
    client,
    { mrpRunId: 15, partVersion: 'TEST-V01', planSequence: 2 },
    'DB read failed',
  );

  assert.deepEqual(args, {
    where: {
      mrpRunId: 15,
      partVersion: 'TEST-V01',
      planSequence: 2,
      isTransferred: false,
      transferStatus: TRANSFER_STATUS.PENDING,
    },
    data: {
      transferStatus: TRANSFER_STATUS.UNKNOWN,
      transferError: 'DB read failed',
      transferStartedAt: null,
    },
  });
});
