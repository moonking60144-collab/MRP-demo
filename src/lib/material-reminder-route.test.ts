import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma, { currentDbMode, getClientForMode } from './db';
import { GET, POST } from '../app/api/fg-material-reminders/route';
import { GET as weekly } from '../app/api/fg-material-reminders/weekly/route';

const client = getClientForMode(currentDbMode())!;
const originals = { run: prisma.mrpRun.findUnique, query: client.$queryRawUnsafe, cw: prisma.componentWeekly.findMany, periods: prisma.componentWeeklyPeriod.findMany };
afterEach(() => {
  prisma.mrpRun.findUnique = originals.run;
  client.$queryRawUnsafe = originals.query;
  prisma.componentWeekly.findMany = originals.cw;
  prisma.componentWeeklyPeriod.findMany = originals.periods;
});
const request = (values: Record<string, string>) => new NextRequest(`http://local/api/fg-material-reminders?${new URLSearchParams(values)}`);
const post = (body: unknown) => new NextRequest('http://local/api/fg-material-reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('沒有明確 Run、空查詢及混用 archive/source 一律拒絕，沒有 fallback 查詢', async () => {
  prisma.mrpRun.findUnique = (() => { throw new Error('unexpected DB call'); }) as typeof prisma.mrpRun.findUnique;
  const targets = JSON.stringify([{ partVersion: 'SY-A', aggregated: false }]);
  const cases: Record<string, string>[] = [{ targets }, { targets, runId: '0' }, { targets: '[]', runId: '265' }, { targets, runId: '265', dbSource: 'bad' }, { targets, runId: '265', archiveId: '' }, { targets, runId: '265', archiveId: 'x', dbSource: 'local' }];
  for (const params of cases) {
    assert.equal((await GET(request(params))).status, 400);
  }
});
test('不存在或未完成 Run 不讀取材料，也不轉到 latest', async () => {
  client.$queryRawUnsafe = (() => { throw new Error('unexpected materials query'); }) as typeof client.$queryRawUnsafe;
  for (const [run, expected] of [[null, 404], [{ status: 'running' }, 409]] as const) {
    prisma.mrpRun.findUnique = (async () => run) as unknown as typeof prisma.mrpRun.findUnique;
    assert.equal((await GET(request({ runId: '265', targets: '[{"partVersion":"SY-A","aggregated":false}]' }))).status, expected);
    assert.equal((await weekly(request({ runId: '265', mrpType: 'B', material: 'A' }))).status, expected);
  }
});
test('列表可用單次 POST 讀取 200 筆摘要，不回傳材料明細', async () => {
  prisma.mrpRun.findUnique = (async () => ({ status: 'completed' })) as unknown as typeof prisma.mrpRun.findUnique;
  const targets = Array.from({ length: 200 }, (_, index) => ({ partVersion: `SY-${index}`, aggregated: false }));
  let queryCount = 0;
  client.$queryRawUnsafe = (async (_query, _scope, values) => {
    queryCount += 1;
    return queryCount === 1 ? (values as string[]).map(partVersion => ({ partVersion, aggregated: false, members: null })) : [];
  }) as typeof client.$queryRawUnsafe;
  const response = await POST(post({ runId: 265, archiveId: null, dbSource: null, includeRows: false, targets }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.detailRowsIncluded, false);
  assert.equal(body.items.length, 200);
  assert.equal(body.items.every((item: { reminder: { rows: unknown[] } }) => item.reminder.rows.length === 0), true);
  assert.equal(queryCount, 2);
});
test('明細模式限單一品項，避免 200 筆列表載入完整材料列', async () => {
  const targets = Array.from({ length: 2 }, (_, index) => ({ partVersion: `SY-${index}`, aggregated: false }));
  assert.equal((await POST(post({ runId: 265, includeRows: true, targets }))).status, 400);
});
test('元件導向 API 使用 exact material／Run／type，不用包含搜尋與跨版本聚合', async () => {
  prisma.mrpRun.findUnique = (async () => ({ status: 'completed', versionCode: 'MRP-265' })) as unknown as typeof prisma.mrpRun.findUnique;
  const where = { mrpRunId: 265, mrpType: 'B', materialPartNo: 'A+V01' };
  prisma.componentWeekly.findMany = (async args => { assert.deepEqual(args?.where, where); return []; }) as typeof prisma.componentWeekly.findMany;
  prisma.componentWeeklyPeriod.findMany = (async args => { assert.deepEqual(args?.where, where); return []; }) as typeof prisma.componentWeeklyPeriod.findMany;
  const response = await weekly(request({ runId: '265', mrpType: 'B', material: 'A+V01' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runId, 265);
});
