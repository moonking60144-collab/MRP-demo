import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import prisma from '../db';
import { listRunDetails, listRuns } from './run-orchestrator';

const runDelegate = prisma.mrpRun as unknown as {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};
const originalFindMany = runDelegate.findMany;

const fullRun = {
  id: 7,
  versionCode: 'MRP-20260727-120000',
  runDate: new Date('2026-07-27T00:00:00.000Z'),
  status: 'completed',
  isLatest: true,
  createdAt: new Date('2026-07-27T04:00:00.000Z'),
  completedAt: new Date('2026-07-27T04:10:00.000Z'),
  createdBy: 'test',
  syncCounts: { orders: 10 },
  stepTiming: { orders: 1000 },
  errorMessage: null,
  stepStatus: { _totalActiveMs: 95_400 },
  logs: [{ ts: 1, level: 'info', msg: 'done' }],
};

afterEach(() => {
  runDelegate.findMany = originalFindMany;
});

test('Run 清單預設只查 summary 欄位，不輸出 logs 或 stepStatus', async () => {
  const receivedArgs: Array<Record<string, unknown>> = [];
  runDelegate.findMany = async (args) => {
    receivedArgs.push(args);
    const summarySource: Record<string, unknown> = { ...fullRun };
    delete summarySource.logs;
    return [summarySource];
  };

  const runs = await listRuns(5);
  const select = receivedArgs[0].select as Record<string, boolean>;

  assert.equal(select.stepStatus, true);
  assert.equal(select.logs, undefined);
  assert.equal('stepStatus' in runs[0], false);
  assert.equal('logs' in runs[0], false);
  assert.equal(runs[0].duration, 95);
});

test('Run 清單相容模式回傳舊完整資料契約', async () => {
  const receivedArgs: Array<Record<string, unknown>> = [];
  runDelegate.findMany = async (args) => {
    receivedArgs.push(args);
    return [fullRun];
  };

  const runs = await listRunDetails(5);

  assert.equal(receivedArgs[0].select, undefined);
  assert.deepEqual(runs, [fullRun]);
});
