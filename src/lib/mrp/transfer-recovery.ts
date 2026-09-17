import type { Prisma, PrismaClient } from '@prisma/client';
import { TRANSFER_STATUS } from '@/lib/transfer-state';

export const TRANSFER_PENDING_STALE_MS = 5 * 60_000;

type TransferRecoveryClient = Pick<PrismaClient, 'fgPlanSuggestion'>;
type TransferScope = Pick<
  Prisma.FgPlanSuggestionWhereInput,
  'mrpRunId' | 'partVersion' | 'planSequence'
>;

const INTERRUPTED_TRANSFER_MESSAGE =
  '轉單流程中斷，Ragic 結果待確認；系統已鎖定重試以避免重複建單。';

export async function recoverStalePendingTransfers(
  client: TransferRecoveryClient,
  scope: TransferScope,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TRANSFER_PENDING_STALE_MS);
  const result = await client.fgPlanSuggestion.updateMany({
    where: {
      ...scope,
      isTransferred: false,
      transferStatus: TRANSFER_STATUS.PENDING,
      OR: [
        { transferStartedAt: null },
        { transferStartedAt: { lt: cutoff } },
      ],
    },
    data: {
      transferStatus: TRANSFER_STATUS.UNKNOWN,
      transferError: INTERRUPTED_TRANSFER_MESSAGE,
      transferStartedAt: null,
    },
  });
  return result.count;
}

export async function markPendingTransferUnknown(
  client: TransferRecoveryClient,
  scope: TransferScope,
  message: string,
): Promise<number> {
  const result = await client.fgPlanSuggestion.updateMany({
    where: {
      ...scope,
      isTransferred: false,
      transferStatus: TRANSFER_STATUS.PENDING,
    },
    data: {
      transferStatus: TRANSFER_STATUS.UNKNOWN,
      transferError: message,
      transferStartedAt: null,
    },
  });
  return result.count;
}
