import { calculateSyntheticRun } from './calculator';
import { latestRun, mutate, state } from './store';
import { events } from './events';
import type { DemoRun } from './data';
import { seedOperationExamples } from './operations';

const active = (run: DemoRun) => ['pending', 'syncing', 'synced', 'calculating'].includes(run.status);
export class DemoError extends Error { constructor(message: string, public status = 400) { super(message); } }
const root = globalThis as typeof globalThis & { demoPrepared?: Promise<void> };
export function prepareDemo(): Promise<void> {
  return root.demoPrepared ??= (async () => {
    for (const run of state().runs.filter((item) => item.status === 'completed')) if (!state().snapshots[String(run.id)]) {
      const result = await calculateSyntheticRun(run);
      mutate((draft) => { draft.snapshots[String(run.id)] = result.data; draft.suggestions.push(...result.suggestions); const item = draft.runs.find((entry) => entry.id === run.id)!; item.syncCounts = Object.fromEntries(Object.entries(result.data.source).map(([key, rows]) => [key, rows.length])); });
    }
    seedOperationExamples();
  })();
}
export function startRun(resumeId?: number, applySkipInventory = false): DemoRun {
  if (state().runs.some(active)) throw new DemoError('已有 Demo 計算執行中。', 409);
  const run = mutate((draft) => {
    if (draft.runs.length >= 30 && !resumeId) throw new DemoError('Demo 最多保留 30 個即時版本；請執行 npm run demo:reset 重置本機展示資料。', 409);
    let item = resumeId ? draft.runs.find((entry) => entry.id === resumeId) : undefined;
    if (resumeId && (!item || !['stopped', 'error'].includes(item.status))) throw new DemoError('只有已中斷的 Demo 版本可續算。', 409);
    if (!item) { const now = new Date().toISOString(); item = { ...latestRun(), id: Math.max(...draft.runs.map((entry) => entry.id)) + 1, versionCode: `DEMO-${now.replace(/\D/g, '').slice(0, 14)}`, runDate: latestRun().runDate, createdAt: now, status: 'pending', isLatest: false, completedAt: null, duration: 0, errorMessage: null, logs: [], stepStatus: {}, attempt: 0 }; draft.runs.unshift(item); }
    item.status = 'calculating'; item.attempt++; item.completedAt = null; item.errorMessage = null; item.stepStatus = { _phase: 'calculating', ...Object.fromEntries(Object.entries(item.syncCounts).map(([key, count]) => [key, { status: 'done', label: `${key}（合成輸入）`, fetched: count, inserted: count }])) }; item.logs = [{ ts: Date.now(), seq: 1, level: 'info', msg: '以合成快照執行原版 MRP 引擎；沒有資料庫或 Ragic 連線。' }];
    return structuredClone(item);
  });
  const settings = structuredClone(state());
  void calculateSyntheticRun(run, settings.leadTimes, settings.transfers, async (step) => {
    if (!ownsAttempt(run)) throw new DemoError('Demo 計算已停止。', 409);
    while (ownsAttempt(run) && state().runs.find((entry) => entry.id === run.id)?.stepStatus._paused) await new Promise((resolve) => setTimeout(resolve, 200));
    if (!ownsAttempt(run)) throw new DemoError('Demo 計算已停止。', 409);
    mutate((draft) => { const item = draft.runs.find((entry) => entry.id === run.id)!; item.stepStatus._phase = step.startsWith('component_') ? `calc_component_${step.at(-1)!.toUpperCase()}` : step === 'sales_meeting' ? 'calc_sales_meeting' : 'calculating'; item.stepStatus[step] = { status: 'done', count: 1, total: 1 }; item.logs.push({ ts: Date.now(), seq: item.logs.length + 1, level: 'info', msg: `計算 ${step}` }); });
    // A yield lets the original stop/pause controls interrupt between engines.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!ownsAttempt(run)) throw new DemoError('Demo 計算已停止。', 409);
  }, applySkipInventory).then((result) => {
    if (!ownsAttempt(run)) return;
    mutate((draft) => {
      for (const item of draft.runs) item.isLatest = item.id === run.id;
      const completed = draft.runs.find((item) => item.id === run.id)!;
      completed.status = 'completed'; completed.stepStatus._phase = 'completed'; completed.completedAt = new Date().toISOString(); completed.duration = (Date.now() - Date.parse(completed.createdAt)) / 1000; completed.syncCounts = Object.fromEntries(Object.entries(result.data.source).map(([key, rows]) => [key, rows.length]));
      result.data.run = structuredClone(completed); draft.snapshots[String(run.id)] = result.data;
      draft.suggestions = draft.suggestions.filter((row) => row.mrpRunId !== run.id).concat(result.suggestions);
    });
    events.emit('runs', { type: 'run-completed', latestRunId: run.id, versionCode: run.versionCode, autoFollow: state().autoFollow });
  }).catch((error) => { if (ownsAttempt(run)) mutate((draft) => { const item = draft.runs.find((entry) => entry.id === run.id)!; item.status = 'error'; item.errorMessage = error instanceof Error ? error.message : String(error); }); });
  return run;
}
function ownsAttempt(run: DemoRun): boolean { const current = state().runs.find((entry) => entry.id === run.id); return !!current && active(current) && current.attempt === run.attempt; }
export function stopRun(id?: number): DemoRun {
  return mutate((draft) => { const item = draft.runs.find((entry) => (id ? entry.id === id : active(entry))); if (!item || !active(item)) throw new DemoError('沒有可停止的 Demo 計算。', 409); item.status = 'stopped'; item.attempt++; item.errorMessage = 'Demo 計算由使用者停止；可重新續算。'; return item; });
}
export function pauseRun(id: number, paused: boolean): void {
  mutate((draft) => { const run = draft.runs.find((item) => item.id === id); if (!run || !active(run)) throw new DemoError('没有執行中的 Demo 計算。', 409); run.stepStatus._paused = paused; });
}
