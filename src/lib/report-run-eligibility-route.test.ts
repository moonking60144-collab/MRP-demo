import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET as fgGET } from '../app/api/fg-monthly/route';
import { GET as componentGET } from '../app/api/component-weekly/route';
import { GET as salesGET } from '../app/api/sales-meeting/route';

const restores: Array<() => void> = [];
function replaceMethod(target: object, key: string, replacement: () => Promise<unknown>) {
  const delegate = target as Record<string, unknown>;
  const original = delegate[key];
  delegate[key] = replacement;
  restores.push(() => { delegate[key] = original; });
}
afterEach(() => { while (restores.length) restores.pop()!(); });

const routes = [
  { name: 'fg-monthly', get: fgGET, params: 'includeIgnored=true' },
  { name: 'component-weekly', get: componentGET, params: 'mrpType=B' },
  { name: 'sales-meeting', get: salesGET, params: '' },
];

let nextRunId = 10_000;

function fixture(status: string | null) {
  const runId = nextRunId++;
  let outputReads = 0;
  const run = status === null ? null : {
    id: runId, status, versionCode: `TEST-${runId}`, runDate: new Date('2026-09-10'),
    syncCounts: {}, isLatest: true,
  };
  replaceMethod(prisma.mrpRun, 'findUnique', async () => run);
  replaceMethod(prisma.mrpRun, 'findFirst', async () => run);
  for (const model of [
    prisma.fgMonthly, prisma.componentWeekly, prisma.salesMeeting,
    prisma.stagingPartVersion, prisma.stagingWorkOrderBom,
  ]) {
    replaceMethod(model, 'findMany', async () => { outputReads++; return []; });
  }
  replaceMethod(prisma.fgMonthly, 'count', async () => { outputReads++; return 0; });
  replaceMethod(prisma.componentWeekly, 'count', async () => { outputReads++; return 0; });
  return { runId, reads: () => outputReads };
}

for (const route of routes) {
  for (const status of ['pending', 'syncing', 'synced', 'calculating', 'error', 'stopped', 'unknown']) {
    for (const explicit of [true, false]) {
      test(`${route.name}: ${status}, explicit=${explicit} blocks output reads`, async () => {
        const { runId, reads } = fixture(status);
        const response = await route.get(new NextRequest(
          `http://localhost/api/${route.name}?${route.params}${explicit ? `&runId=${runId}` : ''}`,
        ));
        assert.equal(response.status, 409, 'INCOMPLETE_RUN_MUST_BE_BLOCKED');
        const body = await response.json();
        assert.equal(body.code, 'MRP_RUN_NOT_COMPLETED');
        assert.equal(body.runStatus, status);
        assert.equal(reads(), 0);
      });
    }
  }
  for (const explicit of [true, false]) {
    test(`${route.name}: completed, explicit=${explicit} remains readable`, async () => {
      const { runId, reads } = fixture('completed');
      const response = await route.get(new NextRequest(
        `http://localhost/api/${route.name}?${route.params}${explicit ? `&runId=${runId}` : ''}`,
      ));
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert(reads() > 0);
      assert.equal((await response.json()).runId, runId);
    });
  }
  test(`${route.name}: missing explicit Run returns 404 before output reads`, async () => {
    const { runId, reads } = fixture(null);
    const response = await route.get(new NextRequest(
      `http://localhost/api/${route.name}?${route.params}&runId=${runId}`,
    ));
    assert.equal(response.status, 404);
    assert.equal(reads(), 0);
  });
  for (const id of ['-1', '0', '1.2', '999junk']) {
    test(`${route.name}: invalid id ${id} returns 400`, async () => {
      const { reads } = fixture('completed');
      const response = await route.get(new NextRequest(
        `http://localhost/api/${route.name}?${route.params}&runId=${id}`,
      ));
      assert.equal(response.status, 400);
      assert.equal(reads(), 0);
    });
  }
}
