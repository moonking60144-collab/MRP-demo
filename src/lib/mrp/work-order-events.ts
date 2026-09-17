import { EventEmitter } from 'events';
import type { WorkOrderStatusEvent } from '@/lib/work-order-state';

const globalEvents = globalThis as unknown as { __fundaWorkOrderEvents?: EventEmitter };
const emitter = globalEvents.__fundaWorkOrderEvents
  ?? (globalEvents.__fundaWorkOrderEvents = new EventEmitter());
emitter.setMaxListeners(0);

const WORK_ORDER_STATUS_CHANGED = 'work-order-status-changed';

export function emitWorkOrderStatus(payload: WorkOrderStatusEvent): void {
  emitter.emit(WORK_ORDER_STATUS_CHANGED, payload);
}

export function onWorkOrderStatus(handler: (payload: WorkOrderStatusEvent) => void): () => void {
  emitter.on(WORK_ORDER_STATUS_CHANGED, handler);
  return () => { emitter.off(WORK_ORDER_STATUS_CHANGED, handler); };
}
