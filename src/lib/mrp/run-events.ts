import { EventEmitter } from 'events';
import type { AutomaticRunRetentionResult } from './run-retention-result';

export interface RunCompletedEvent {
  latestRunId: number;
  versionCode: string;
}

export interface RunRetentionCompletedEvent {
  result: AutomaticRunRetentionResult;
}

// 進程內事件匯流排：run 跑完 → emit → SSE 端點推給所有連線的 client。
// pm2 為 fork 單進程，記憶體 emitter 足以廣播；若改 cluster 多進程需換 Redis pub/sub。
// 用 globalThis 單例，避免 Next dev HMR 重載模組造成 emit 與 subscribe 落在不同 emitter。
const g = globalThis as unknown as { __fundaRunEvents?: EventEmitter };
const emitter = g.__fundaRunEvents ?? (g.__fundaRunEvents = new EventEmitter());
// 連線數 = listener 數，設 0 解除預設 10 個上限的警告。
emitter.setMaxListeners(0);

const RUN_COMPLETED = 'run-completed';
const RUN_RETENTION_COMPLETED = 'run-retention-completed';

export function emitRunCompleted(payload: RunCompletedEvent): void {
  emitter.emit(RUN_COMPLETED, payload);
}

/** 訂閱 run 完成事件，回傳取消訂閱函式。 */
export function onRunCompleted(handler: (payload: RunCompletedEvent) => void): () => void {
  emitter.on(RUN_COMPLETED, handler);
  return () => { emitter.off(RUN_COMPLETED, handler); };
}

export function emitRunRetentionCompleted(
  payload: RunRetentionCompletedEvent,
): void {
  emitter.emit(RUN_RETENTION_COMPLETED, payload);
}

export function onRunRetentionCompleted(
  handler: (payload: RunRetentionCompletedEvent) => void,
): () => void {
  emitter.on(RUN_RETENTION_COMPLETED, handler);
  return () => { emitter.off(RUN_RETENTION_COMPLETED, handler); };
}
