import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentWeeklyPeriodsCacheKey,
  componentWeeklyRowKey,
  groupComponentWeeklyPeriodScopes,
  loadComponentWeeklyPeriods,
} from './component-weekly-periods';

test('元件週推列識別包含來源、run、類型與料號', () => {
  const base = { materialPartNo: 'MATERIAL-01', mrpRunId: 18, mrpType: 'W' };

  assert.notEqual(
    componentWeeklyRowKey({ ...base, dbSource: 'local' }),
    componentWeeklyRowKey({ ...base, dbSource: 'docker' }),
  );
  assert.notEqual(
    componentWeeklyRowKey({ ...base, dbSource: 'local' }),
    componentWeeklyRowKey({ ...base, mrpRunId: 21, dbSource: 'local' }),
  );
});

test('元件週推 periods 依來源、run 與類型分批且同料號去重', () => {
  const scopes = groupComponentWeeklyPeriodScopes([
    { materialPartNo: 'A', mrpRunId: 18, mrpType: 'W', dbSource: 'local' },
    { materialPartNo: 'A', mrpRunId: 18, mrpType: 'W', dbSource: 'local' },
    { materialPartNo: 'B', mrpRunId: 18, mrpType: 'W', dbSource: 'local' },
    { materialPartNo: 'A', mrpRunId: 21, mrpType: 'W', dbSource: 'docker' },
  ]);

  assert.deepEqual(scopes, [
    { dbSource: 'local', runId: 18, mrpType: 'W', materialPartNos: ['A', 'B'] },
    { dbSource: 'docker', runId: 21, mrpType: 'W', materialPartNos: ['A'] },
  ]);
});

test('元件週推 periods cache key 不會讓不同來源或 run 共用', () => {
  const local = [{ materialPartNo: 'A', mrpRunId: 18, mrpType: 'B', dbSource: 'local' }];
  const docker = [{ materialPartNo: 'A', mrpRunId: 18, mrpType: 'B', dbSource: 'docker' }];

  assert.notEqual(componentWeeklyPeriodsCacheKey(local), componentWeeklyPeriodsCacheKey(docker));
  assert.notEqual(
    componentWeeklyPeriodsCacheKey(local),
    componentWeeklyPeriodsCacheKey([{ ...local[0]!, mrpRunId: 21 }]),
  );
});

test('元件週推 periods 單一來源失敗時保留其他來源結果', async () => {
  const rows = [
    { materialPartNo: 'LOCAL-A', mrpRunId: 18, mrpType: 'W', dbSource: 'local' },
    { materialPartNo: 'DOCKER-A', mrpRunId: 21, mrpType: 'W', dbSource: 'docker' },
  ];
  const result = await loadComponentWeeklyPeriods(rows, async (_input, init) => {
    const scope = JSON.parse(String(init.body));
    if (scope.dbSource === 'docker') return new Response(null, { status: 503 });
    return Response.json({
      periods: {
        'LOCAL-A': [{ weekIndex: 1, weekLabel: 'W01', weekStart: null, remainingStock: 10, usage: 2, receipts: 0 }],
      },
      runId: scope.runId,
      dbSource: scope.dbSource,
    });
  });

  assert.deepEqual(result.periods[componentWeeklyRowKey(rows[0]!)], [
    { weekIndex: 1, weekLabel: 'W01', weekStart: null, remainingStock: 10, usage: 2, receipts: 0 },
  ]);
  assert.equal(result.periods[componentWeeklyRowKey(rows[1]!)], undefined);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0]!.rowKeys, [componentWeeklyRowKey(rows[1]!)]);
  assert.equal(result.failures[0]!.message, 'HTTP 503');
});

test('元件週推 periods 回應識別不符只標記該來源失敗', async () => {
  const row = { materialPartNo: 'A', mrpRunId: 18, mrpType: 'B', dbSource: 'local' };
  const result = await loadComponentWeeklyPeriods([row], async () => Response.json({
    periods: { A: [] },
    runId: 99,
    dbSource: 'local',
  }));

  assert.deepEqual(result.periods, {});
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.message, '回應來源或 Run 不符');
});

test('元件週推 periods 回應缺少單一料號時不把該列映射為零', async () => {
  const rows = [
    { materialPartNo: 'A', mrpRunId: 18, mrpType: 'D', dbSource: 'local' },
    { materialPartNo: 'B', mrpRunId: 18, mrpType: 'D', dbSource: 'local' },
  ];
  const result = await loadComponentWeeklyPeriods(rows, async () => Response.json({
    periods: {
      A: [{ weekIndex: 1, weekLabel: 'W01', weekStart: null, remainingStock: 8, usage: 2, receipts: 0 }],
    },
    runId: 18,
    dbSource: 'local',
  }));

  assert.equal(result.periods[componentWeeklyRowKey(rows[0]!)]?.[0]?.remainingStock, 8);
  assert.equal(result.periods[componentWeeklyRowKey(rows[1]!)], undefined);
  assert.deepEqual(result.failures[0]!.rowKeys, [componentWeeklyRowKey(rows[1]!)]);
  assert.equal(result.failures[0]!.message, '找不到週期資料');
});

test('元件週推 periods 將 Prisma Decimal JSON 字串正規化為可框選計算的數字', async () => {
  const row = { materialPartNo: 'A', mrpRunId: 21, mrpType: 'W' };
  const result = await loadComponentWeeklyPeriods([row], async () => Response.json({
    periods: {
      A: [{
        weekIndex: 1,
        weekLabel: 'W01',
        weekStart: '2026-07-13T00:00:00.000Z',
        remainingStock: '118.5',
        usage: '4.5',
        receipts: '100',
      }],
    },
    runId: 21,
    dbSource: null,
  }));

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.periods[componentWeeklyRowKey(row)]?.[0], {
    weekIndex: 1,
    weekLabel: 'W01',
    weekStart: '2026-07-13T00:00:00.000Z',
    remainingStock: 118.5,
    usage: 4.5,
    receipts: 100,
  });
});
