import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupSalesMeetingPeriodScopes,
  loadSalesMeetingPeriods,
} from './sales-meeting-period-client';

test('產銷週期依 DB source 與 Run 分批並保留客戶料號成員', () => {
  const scopes = groupSalesMeetingPeriodScopes([
    {
      partVersion: 'PV-A',
      memberPartVersions: ['PV-A', 'PV-A-V01'],
      mrpRunId: 55,
      dbSource: 'local',
    },
    {
      partVersion: 'PV-B',
      memberPartVersions: ['PV-B'],
      mrpRunId: 72,
      dbSource: 'remote',
    },
  ]);

  assert.deepEqual(scopes, [
    {
      runId: 55,
      dbSource: 'local',
      groups: [{ partVersion: 'PV-A', memberPartVersions: ['PV-A', 'PV-A-V01'] }],
    },
    {
      runId: 72,
      dbSource: 'remote',
      groups: [{ partVersion: 'PV-B', memberPartVersions: ['PV-B'] }],
    },
  ]);
});

test('產銷週期 loader 對每個來源分開讀取並驗證回應 identity', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const periods = await loadSalesMeetingPeriods<{ weekIndex: number }>([
    { partVersion: 'PV-A', mrpRunId: 55, dbSource: 'local' },
    { partVersion: 'PV-B', mrpRunId: 72, dbSource: 'remote' },
  ], {
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init.body)) as {
        runId: number;
        dbSource?: string;
        groups: Array<{ partVersion: string }>;
      };
      requests.push(body);
      const partVersion = body.groups[0]!.partVersion;
      return Response.json({
        periods: { [partVersion]: [{ weekIndex: 1 }] },
        runId: body.runId,
        dbSource: body.dbSource ?? null,
      });
    },
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => [request.runId, request.dbSource]), [
    [55, 'local'],
    [72, 'remote'],
  ]);
  assert.deepEqual(periods, {
    'PV-A': [{ weekIndex: 1 }],
    'PV-B': [{ weekIndex: 1 }],
  });
});

test('產銷週期 loader 遇到 HTTP 錯誤或來源 identity 不符時拒絕輸出不完整資料', async () => {
  const rows = [{ partVersion: 'PV-A', mrpRunId: 55, dbSource: 'local' }];
  await assert.rejects(
    loadSalesMeetingPeriods(rows, {
      fetcher: async () => Response.json({ error: 'boom' }, { status: 503 }),
    }),
    /boom/,
  );
  await assert.rejects(
    loadSalesMeetingPeriods(rows, {
      fetcher: async () => Response.json({ periods: {}, runId: 55, dbSource: 'remote' }),
    }),
    /MRP Run／資料庫來源不一致/,
  );
});

test('產銷週期 loader 將超過單批上限的全量匯出切成多個 request', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    partVersion: `PV-${index}`,
    mrpRunId: 55,
  }));
  const batchSizes: number[] = [];
  await loadSalesMeetingPeriods(rows, {
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init.body)) as {
        runId: number;
        groups: Array<{ partVersion: string }>;
      };
      batchSizes.push(body.groups.length);
      return Response.json({ periods: {}, runId: body.runId, dbSource: null });
    },
  });

  assert.deepEqual(batchSizes.sort((left, right) => right - left), [1000, 1]);
});
