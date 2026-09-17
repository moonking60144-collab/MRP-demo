export const TRANSFER_STATUS = {
  IDLE: 'idle',
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  UNKNOWN: 'unknown',
  FAILED: 'failed',
} as const;

export type TransferStatus = (typeof TRANSFER_STATUS)[keyof typeof TRANSFER_STATUS];

export function isTransferBlocked(status: string | null | undefined): boolean {
  return status === TRANSFER_STATUS.PENDING || status === TRANSFER_STATUS.UNKNOWN;
}

export class TransferStateConflictError extends Error {
  constructor(
    message: string,
    readonly transferStatus: TransferStatus,
  ) {
    super(message);
    this.name = 'TransferStateConflictError';
  }
}
