import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';

import prisma from '../db';
import { GET } from '../../app/api/component-weekly/route';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const componentDelegate = prisma.componentWeekly as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  count: (args: unknown) => Promise<number>;
};
const bomDelegate = prisma.stagingWorkOrderBom as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};

const originals = {
  run: runDelegate.findUnique,
  componentMany: componentDelegate.findMany,
  componentCount: componentDelegate.count,
  bomMany: bomDelegate.findMany,
};

afterEach(() => {
  runDelegate.findUnique = originals.run;
  componentDelegate.findMany = originals.componentMany;
  componentDelegate.count = originals.componentCount;
  bomDelegate.findMany = originals.bomMany;
});

test('同一完成 Run 翻頁時重用全域用量警告，清單仍按頁查詢', async () => {
  runDelegate.findUnique = async () => ({
    id: 9901,
    status: 'completed',
    versionCode: 'MRP-9901',
    runDate: new Date('2026-09-11T00:00:00.000Z'),
  });
  let listReads = 0;
  componentDelegate.findMany = async (args) => {
    listReads += 1;
    const skip = Number((args as { skip?: number }).skip) || 0;
    return [{ materialPartNo: skip === 0 ? 'MAT-1' : 'MAT-2', mrpType: 'B' }];
  };
  componentDelegate.count = async () => 2;
  let warningReads = 0;
  bomDelegate.findMany = async () => {
    warningReads += 1;
    return [{
      sourceRecordId: '701',
      woNumber: 'WO-1',
      componentNo: 'MAT-1',
      minUsage: 5,
      unit: 'pc',
      sourceType: '採購',
      processCode: null,
      issuedQtyState: 'unknown',
      issuedQtyError: 'missing_issue_details',
      movementState: 'fallback',
      movementError: 'movement_source_unavailable',
    }];
  };

  const first = await GET(new NextRequest(
    'http://localhost/api/component-weekly?mrpType=B&runId=9901&page=1&limit=1',
  ));
  const second = await GET(new NextRequest(
    'http://localhost/api/component-weekly?mrpType=B&runId=9901&page=2&limit=1',
  ));
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(listReads, 2);
  assert.equal(warningReads, 1);
  assert.deepEqual(secondBody.usageWarnings, firstBody.usageWarnings);
  assert.equal(firstBody.usageWarnings.count, 1);
  assert.equal(firstBody.usageWarnings.blockingCount, 1);
});
