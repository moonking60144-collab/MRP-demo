import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoDataset, DemoRow, DemoRun } from './data';

export interface DemoState {
  schema: 'mrp-interview-synthetic-v1';
  revision: number;
  runs: DemoRun[];
  snapshots: Record<string, DemoDataset>;
  suggestions: DemoRow[];
  transfers: DemoRow[];
  leadTimes: Record<string, number | null>;
  autoFollow: boolean;
  ignored: string[];
  dbMode: 'local' | 'docker' | 'remote';
}
const directory = (globalThis as typeof globalThis & { demoStateDirectory?: string }).demoStateDirectory ?? join(process.cwd(), 'demo-data');
const file = join(directory, 'state.json');
const root = globalThis as typeof globalThis & { mrpDemoState?: DemoState };
export function seedRuns(): DemoRun[] {
  return [3, 2, 1].map((id) => ({ id, versionCode: `DEMO-2026090${id}-090000`, runDate: `2026-09-0${id}T00:00:00.000Z`, status: 'completed', isLatest: id === 3, completedAt: `2026-09-0${id}T01:00:06.000Z`, createdAt: `2026-09-0${id}T01:00:00.000Z`, createdBy: 'Demo', duration: 6, syncCounts: {}, errorMessage: null, stepTiming: { sync: 0, verify: 0, calculate: 0 }, stepStatus: {}, logs: [], attempt: 0 }));
}
export function state(): DemoState {
  if (root.mrpDemoState) return root.mrpDemoState;
  const initial: DemoState = { schema: 'mrp-interview-synthetic-v1', revision: 0, runs: seedRuns(), snapshots: {}, suggestions: [], transfers: [], leadTimes: {}, autoFollow: false, ignored: [], dbMode: 'local' };
  const value: DemoState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : initial;
  if (value.schema !== initial.schema || !Array.isArray(value.runs) || !value.snapshots || !Array.isArray(value.transfers) || !Array.isArray(value.suggestions)) throw new Error('Demo 狀態格式不符；請保留檔案並執行 npm run demo:reset。');
  for (const run of value.runs) if (['pending', 'syncing', 'synced', 'calculating'].includes(run.status)) { run.status = 'stopped'; run.errorMessage = 'Demo 重新啟動，計算已中斷；可續算。'; run.attempt++; }
  for (const transfer of value.transfers) if (['queued', 'pending'].includes(String(transfer.workOrderStatus))) { transfer.workOrderStatus = 'unknown'; transfer.workOrderError = 'Demo 重新啟動；請確認本機工令結果。'; }
  for (const transfer of value.transfers) if (transfer.workOrderStatus === 'succeeded' && !(transfer.workOrderResponse as { workOrder?: DemoRow } | null)?.workOrder) { transfer.workOrderStatus = 'unknown'; transfer.workOrderError = '合成工令 artifact 不完整；請確認後重新建立。'; }
  root.mrpDemoState = value;
  persist(value);
  return value;
}
function persist(value: DemoState): void {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `state-${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}
export function mutate<T>(change: (draft: DemoState) => T): T {
  const draft = structuredClone(state());
  const result = change(draft);
  draft.revision++;
  persist(draft);
  root.mrpDemoState = draft;
  return result;
}
export function latestRun(): DemoRun { return state().runs.find((run) => run.isLatest && run.status === 'completed')!; }
