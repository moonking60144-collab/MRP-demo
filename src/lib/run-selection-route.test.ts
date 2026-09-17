import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET } from '../app/api/runs/selection/route';
const delegate = prisma.mrpRun as unknown as { findFirst: (args: unknown) => Promise<unknown> };
const original = delegate.findFirst;
afterEach(() => { delegate.findFirst = original; });
for (const stored of [true, false]) test('版本選擇保留指定版本或回退最新：' + stored, async () => {
  const queries: unknown[] = [];
  delegate.findFirst = async args => { queries.push(args); return queries.length === 1 && !stored ? null : { id: stored ? 56 : 57, status: 'completed' }; };
  const response = await GET(new NextRequest('http://localhost/api/runs/selection?runId=56'));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.run.id, stored ? 56 : 57);
  assert.equal(body.fallback, !stored);
  assert.deepEqual((queries[0] as {where:unknown}).where, { id:56, status:'completed' });
  assert(response.headers.get('server-timing')?.includes('selection'));
});
test('不合法版本不查 DB', async () => {
  delegate.findFirst = async () => { throw Error('must not query'); };
  assert.equal((await GET(new NextRequest('http://localhost/api/runs/selection?runId=3oops'))).status,400);
});
test('資料庫失敗不冒充沒有版本', async () => {
  delegate.findFirst = async () => { throw Error('offline'); };
  assert.equal((await GET(new NextRequest('http://localhost/api/runs/selection'))).status,503);
});
test('沒有指定版本時只查最新完成版本', async () => {
  const queries: unknown[] = [];
  delegate.findFirst = async args => { queries.push(args); return { id: 57, status: 'completed' }; };
  const response = await GET(new NextRequest('http://localhost/api/runs/selection'));
  assert.equal((await response.json()).run.id, 57);
  assert.equal(queries.length, 1);
  assert.deepEqual((queries[0] as {where:unknown}).where, { status: 'completed' });
  assert.deepEqual((queries[0] as {orderBy:unknown}).orderBy, { id: 'desc' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('沒有完成版本時回傳空選擇', async () => {
  delegate.findFirst = async () => null;
  const response = await GET(new NextRequest('http://localhost/api/runs/selection'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).run, null);
});
