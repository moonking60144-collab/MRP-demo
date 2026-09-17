'use client';

import type { WorkOrderStatusEvent } from '@/lib/work-order-state';

const listeners = new Map<number, Set<(event: WorkOrderStatusEvent) => void>>();
let eventSource: EventSource | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function publish(event: WorkOrderStatusEvent): void {
  for (const listener of listeners.get(event.transferId) ?? []) listener(event);
}

function listenerCount(): number {
  let count = 0;
  for (const transferListeners of listeners.values()) count += transferListeners.size;
  return count;
}

function connect(): void {
  if (eventSource || typeof window === 'undefined') return;
  eventSource = new EventSource('/api/production-plans/stream');
  eventSource.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data) as {
        type?: string;
        statuses?: WorkOrderStatusEvent[];
      } & Partial<WorkOrderStatusEvent>;
      if (payload.type === 'sync') {
        for (const status of payload.statuses ?? []) publish(status);
      } else if (
        payload.type === 'work-order-status'
        && typeof payload.transferId === 'number'
        && typeof payload.workOrderStatus === 'string'
      ) {
        publish(payload as WorkOrderStatusEvent);
      }
    } catch {
      // EventSource 會繼續接收後續合法事件。
    }
  };
}

export function subscribeWorkOrderStatus(
  transferId: number,
  listener: (event: WorkOrderStatusEvent) => void,
): () => void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  const transferListeners = listeners.get(transferId) ?? new Set();
  transferListeners.add(listener);
  listeners.set(transferId, transferListeners);
  connect();
  return () => {
    const current = listeners.get(transferId);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(transferId);
    if (listenerCount() > 0) return;
    closeTimer = setTimeout(() => {
      if (listenerCount() === 0) {
        eventSource?.close();
        eventSource = null;
      }
      closeTimer = null;
    }, 1_000);
  };
}
