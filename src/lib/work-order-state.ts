export const WORK_ORDER_STATUS = {
  IDLE: 'idle',
  QUEUED: 'queued',
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  UNKNOWN: 'unknown',
  FAILED: 'failed',
} as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUS)[keyof typeof WORK_ORDER_STATUS];

export interface WorkOrderStatusEvent {
  transferId: number;
  workOrderStatus: WorkOrderStatus;
  workOrderError: string | null;
  workOrderStartedAt: string | null;
  workOrderCompletedAt: string | null;
}

export class WorkOrderStateConflictError extends Error {
  constructor(
    message: string,
    readonly workOrderStatus: WorkOrderStatus,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'WorkOrderStateConflictError';
  }
}
