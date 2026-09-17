import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { PATCH } from '../app/api/component-weekly/[materialPartNo]/purchase-lead-time/route';
import { readPurchaseLeadTimeResponse } from './component-weekly-lead-time-response';

const runDelegate = prisma.mrpRun as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const inventoryDelegate = prisma.stagingInventory as unknown as {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
};
const originalRunFindUnique = runDelegate.findUnique;
const originalInventoryFindMany = inventoryDelegate.findMany;
const originalFetch = globalThis.fetch;

for (const observed of ['26', '12', '40', 'unavailable']) {
  test(`前置期 PATCH 逾時後讀回 ${observed}，只寫一次且由實際回讀決定結果`, async (t) => {
    stubSnapshot(12, true);
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (handler: (...args: unknown[]) => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(handler, 1);
    });
    let reads = 0;
    let writes = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'PATCH') {
        writes += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      reads += 1;
      if (reads > 1 && observed === 'unavailable') throw new TypeError('fetch failed');
      return Response.json({ 2401: { '1005345': 'ERP-B', '1037338': reads === 1 ? '12' : observed } });
    };
    const response = await PATCH(request({
      ragicRecordId: '2401', expectedPurchaseLeadWeeks: 12, expectedConfigured: true, purchaseLeadWeeks: 26,
    }), { params: Promise.resolve({ materialPartNo: 'ERP-B' }) });
    assert.equal(writes, 1);
    assert.equal(reads, 2, 'readback failure must not enter the sync retry policy');
    assert.deepEqual(waits, [15_000, 45_000, 15_000], 'interactive operation reserves time for readback');
    if (observed === '26') {
      assert.equal(response.status, 200);
      assert.equal((await readPurchaseLeadTimeResponse(response)).purchaseLeadWeeks, 26);
    } else {
      assert.equal(response.status, 502);
      await assert.rejects(() => readPurchaseLeadTimeResponse(response), /不要直接重送/);
    }
  });
}

test('前置期讀取來源失敗時不執行 PATCH，也不套用同步長時間重試', async () => {
  stubSnapshot(12, true);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const response = await PATCH(request({
    ragicRecordId: '2401', expectedPurchaseLeadWeeks: 12, expectedConfigured: true, purchaseLeadWeeks: 26,
  }), { params: Promise.resolve({ materialPartNo: 'ERP-B' }) });
  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  await assert.rejects(() => readPurchaseLeadTimeResponse(response), /未執行更新/);
});

afterEach(() => {
  runDelegate.findUnique = originalRunFindUnique;
  inventoryDelegate.findMany = originalInventoryFindMany;
  globalThis.fetch = originalFetch;
});

function request(body: Record<string, unknown>, mrpType = 'B') {
  return new NextRequest(
    `http://localhost/api/component-weekly/ERP-B/purchase-lead-time?runId=55&mrpType=${mrpType}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function stubSnapshot(purchaseLeadWeeks: number, purchaseLeadWeeksConfigured: boolean | null) {
  runDelegate.findUnique = async () => ({ versionCode: 'MRP-TEST' });
  inventoryDelegate.findMany = async () => [{
    id: 1,
    ragicRecordId: '2401',
    erpPartNo: 'ERP-B',
    subtypeCode: null,
    purchaseLeadWeeks,
    purchaseLeadWeeksConfigured,
  }];
}

test('前置期更新保留明確 0，寫後核對成功但不修改目前 Run', async () => {
  stubSnapshot(0, false);
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      method: String(init?.method ?? 'GET'),
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (calls.length === 1) {
      return Response.json({
        2401: { '1005345': 'ERP-B', '1037338': '' },
      });
    }
    if (calls.length === 2) return Response.json({ status: 'SUCCESS' });
    return Response.json({
      2401: { '1005345': 'ERP-B', '1037338': '0' },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 0,
      expectedConfigured: false,
      purchaseLeadWeeks: 0,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url.pathname, '/default/g6mrp/1/2401');
  assert.equal(calls[1].url.searchParams.get('checkLock'), 'true');
  assert.deepEqual(calls[1].body, { '1037338': 0 });
  assert.equal(body.purchaseLeadWeeks, 0);
  assert.equal(body.purchaseLeadWeeksConfigured, true);
  assert.equal(body.currentRunUnchanged, true);
  assert.equal(body.requiresNewRun, true);
});

test('Ragic 目前值與 Run 快照不同時阻擋覆蓋', async () => {
  stubSnapshot(12, true);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      2401: { '1005345': 'ERP-B', '1037338': '26' },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: 26,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'RAGIC_VALUE_CHANGED');
  assert.equal(body.currentPurchaseLeadWeeks, 26);
  assert.equal(calls, 1);
});

test('清除前置期會寫入空字串，與明確 0 保持不同語意', async () => {
  stubSnapshot(12, true);
  const writeBodies: unknown[] = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (String(init?.method ?? 'GET') === 'PATCH') {
      writeBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'SUCCESS' });
    }
    return Response.json({
      2401: {
        '1005345': 'ERP-B',
        '1037338': calls === 1 ? '12' : '',
      },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: null,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(writeBodies, [{ '1037338': '' }]);
  assert.equal(body.purchaseLeadWeeks, 0);
  assert.equal(body.purchaseLeadWeeksConfigured, false);
  assert.equal(body.requiresNewRun, true);
});

test('目標與 Ragic 現值相同時不重複寫入，也不要求新 Run', async () => {
  stubSnapshot(12, true);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      2401: { '1005345': 'ERP-B', '1037338': '12' },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: 12,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(body.updated, false);
  assert.equal(body.requiresNewRun, false);
});

test('legacy null 快照的正數前置期可做 no-op 核對，不誤判快照衝突', async () => {
  stubSnapshot(12, null);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      2401: { '1005345': 'ERP-B', '1037338': '12' },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: null,
      purchaseLeadWeeks: 12,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(body.updated, false);
  assert.equal(body.purchaseLeadWeeks, 12);
  assert.equal(body.purchaseLeadWeeksConfigured, true);
});

test('同一 ERP 料號有多筆 Run 快照時 fail closed，完全不呼叫 Ragic', async () => {
  runDelegate.findUnique = async () => ({ versionCode: 'MRP-TEST' });
  inventoryDelegate.findMany = async () => [
    {
      id: 2,
      ragicRecordId: '2402',
      erpPartNo: 'ERP-B',
      subtypeCode: null,
      purchaseLeadWeeks: 26,
      purchaseLeadWeeksConfigured: true,
    },
    {
      id: 1,
      ragicRecordId: '2401',
      erpPartNo: 'ERP-B',
      subtypeCode: null,
      purchaseLeadWeeks: 12,
      purchaseLeadWeeksConfigured: true,
    },
  ];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2402',
      expectedPurchaseLeadWeeks: 26,
      expectedConfigured: true,
      purchaseLeadWeeks: 12,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'RAGIC_SOURCE_AMBIGUOUS');
  assert.equal(body.sourceCount, 2);
  assert.equal(calls, 0);
});

test('W 線材前置期更新只以 WR/WD 主檔來源做快照核對', async () => {
  runDelegate.findUnique = async () => ({ versionCode: 'MRP-TEST' });
  inventoryDelegate.findMany = async () => [
    {
      id: 2,
      ragicRecordId: '2402',
      erpPartNo: 'ERP-B',
      subtypeCode: 'OTHER',
      purchaseLeadWeeks: 26,
      purchaseLeadWeeksConfigured: true,
    },
    {
      id: 1,
      ragicRecordId: '2401',
      erpPartNo: 'ERP-B',
      subtypeCode: 'MTRL-WR',
      purchaseLeadWeeks: 12,
      purchaseLeadWeeksConfigured: true,
    },
  ];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      2401: { '1005345': 'ERP-B', '1037338': '12' },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: 12,
    }, 'W'),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.updated, false);
  assert.equal(calls, 1);
});

test('PATCH 回應不明時只讀回核對，不重送寫入', async () => {
  stubSnapshot(12, true);
  let calls = 0;
  let patchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (String(init?.method ?? 'GET') === 'PATCH') {
      patchCalls += 1;
      return new Response('gateway timeout', { status: 504 });
    }
    return Response.json({
      2401: {
        '1005345': 'ERP-B',
        '1037338': calls === 1 ? '12' : '26',
      },
    });
  };

  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: 26,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(patchCalls, 1);
  assert.equal(body.reconciled, true);
  assert.equal(body.purchaseLeadWeeks, 26);
});

test('前置期只接受 null 或 0 到 260 的整數週數', async () => {
  const response = await PATCH(
    request({
      ragicRecordId: '2401',
      expectedPurchaseLeadWeeks: 12,
      expectedConfigured: true,
      purchaseLeadWeeks: 12.5,
    }),
    { params: Promise.resolve({ materialPartNo: 'ERP-B' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /整數/);
});
