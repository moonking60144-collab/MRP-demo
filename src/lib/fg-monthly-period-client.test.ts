import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  fetchFgMonthlyMembersByIdentity,
  fetchFgMonthlyPeriodsByIdentity,
  fetchFgMonthlySourcesByIdentity,
} from './mrp/fg-monthly-period-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('月推 period loader 依 Run 與 DB source 分組並驗證回應 identity', async () => {
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      partVersions: string[];
      runId: number;
      dbSource?: string;
      aggregated: boolean;
    };
    requests.push(body);
    return new Response(JSON.stringify({
      periods: Object.fromEntries(body.partVersions.map((partVersion) => [
        partVersion,
        [{ periodIndex: 0, plannedOutput: body.runId }],
      ])),
      runId: body.runId,
      dbSource: body.dbSource ?? null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const periods = await fetchFgMonthlyPeriodsByIdentity<{ periodIndex: number; plannedOutput: number }>([
    { partVersion: 'PV-A', mrpRunId: 45 },
    { partVersion: 'PV-B', mrpRunId: 45 },
    { partVersion: 'PV-C', mrpRunId: 7, dbSource: 'remote' },
  ], false);

  assert.deepEqual(requests, [
    {
      partVersions: ['PV-A', 'PV-B'],
      runId: 45,
      aggregated: false,
    },
    {
      partVersions: ['PV-C'],
      runId: 7,
      dbSource: 'remote',
      aggregated: false,
    },
  ]);
  assert.equal(periods['PV-A']?.[0]?.plannedOutput, 45);
  assert.equal(periods['PV-C']?.[0]?.plannedOutput, 7);
});

test('月推 period loader 拒絕與 request 不同的 Run 回應', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    periods: {},
    runId: 50,
    dbSource: null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    fetchFgMonthlyPeriodsByIdentity([
      { partVersion: 'PV-A', mrpRunId: 45 },
    ], false),
    /MRP Run／資料庫來源不一致/,
  );
});

test('月推 period loader 將 AbortSignal 傳給每一個 batch request', async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    signals.push(init?.signal);
    return new Response(JSON.stringify({
      periods: {},
      runId: 45,
      dbSource: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fetchFgMonthlyPeriodsByIdentity([
    { partVersion: 'PV-A', mrpRunId: 45 },
  ], false, { signal: controller.signal });

  assert.deepEqual(signals, [controller.signal]);
});

test('月推聚合成員固定使用父列 Run 與 DB source，不走 merge 最新資料', async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.toString());
    return new Response(JSON.stringify({
      items: [
        { partVersion: 'PV-A', mrpRunId: 45, dbSource: 'remote' },
      ],
      runId: 45,
      dbSource: 'remote',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const members = await fetchFgMonthlyMembersByIdentity<{
    partVersion: string;
    mrpRunId: number;
    dbSource?: string;
  }>({
    partVersion: 'PV-GROUP',
    mrpRunId: 45,
    dbSource: 'remote',
    aggregatedMembers: ['PV-A', 'PV-B'],
  }, {
    sortFields: 'customerCode:asc',
    excludeTest: true,
  });

  const request = new URL(requests[0]);
  assert.equal(request.pathname, '/api/fg-monthly');
  assert.equal(request.searchParams.get('partVersionsIn'), 'PV-A,PV-B');
  assert.equal(request.searchParams.get('runId'), '45');
  assert.equal(request.searchParams.get('dbSource'), 'remote');
  assert.equal(request.searchParams.get('merge'), null);
  assert.equal(request.searchParams.get('filter_dbSource'), null);
  assert.equal(request.searchParams.get('sortFields'), 'customerCode:asc');
  assert.equal(request.searchParams.get('excludeTest'), 'true');
  assert.equal(members[0]?.mrpRunId, 45);
  assert.equal(members[0]?.dbSource, 'remote');
});

test('月推聚合成員拒絕與父列不同的 Run 回應', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [],
    runId: 50,
    dbSource: 'remote',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    fetchFgMonthlyMembersByIdentity({
      partVersion: 'PV-GROUP',
      mrpRunId: 45,
      dbSource: 'remote',
      aggregatedMembers: ['PV-A'],
    }),
    /MRP Run／資料庫來源不一致/,
  );
});

test('月推來源總覽固定使用料件的 Run 與 DB source，並傳遞 AbortSignal', async () => {
  const controller = new AbortController();
  const requests: Array<{ url: URL; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ url, signal: init?.signal });
    return new Response(JSON.stringify({
      partVersion: 'PV-A',
      runId: 45,
      dbSource: 'remote',
      sourcePartVersions: ['PV-1', 'PV-2'],
      partVersions: [],
      inventory: [],
      orders: [],
      forecasts: [],
      workOrders: [],
      workOrderBoms: [],
      productionPlans: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await fetchFgMonthlySourcesByIdentity({
    partVersion: 'PV-A',
    mrpRunId: 45,
    dbSource: 'remote',
    aggregatedMembers: ['PV-1', 'PV-2'],
  }, { signal: controller.signal });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.pathname, '/api/fg-monthly/PV-A/sources');
  assert.equal(requests[0]?.url.searchParams.get('runId'), '45');
  assert.equal(requests[0]?.url.searchParams.get('dbSource'), 'remote');
  assert.deepEqual(requests[0]?.url.searchParams.getAll('partVersion'), ['PV-1', 'PV-2']);
  assert.equal(requests[0]?.signal, controller.signal);
  assert.equal(result.partVersion, 'PV-A');
  assert.equal(result.runId, 45);
  assert.equal(result.dbSource, 'remote');
});

test('月推來源總覽拒絕與選取料件、Run 或 DB source 不同的回應', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    partVersion: 'PV-B',
    runId: 50,
    dbSource: 'local',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    fetchFgMonthlySourcesByIdentity({
      partVersion: 'PV-A',
      mrpRunId: 45,
      dbSource: 'remote',
    }),
    /料號／MRP Run／資料庫來源不一致/,
  );
});

test('月推來源總覽拒絕與選取列不同的聚合成員 scope', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    partVersion: 'PV-GROUP',
    runId: 45,
    dbSource: null,
    sourcePartVersions: ['PV-A'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    fetchFgMonthlySourcesByIdentity({
      partVersion: 'PV-GROUP',
      mrpRunId: 45,
      aggregatedMembers: ['PV-A', 'PV-B'],
    }),
    /聚合成員不一致/,
  );
});
