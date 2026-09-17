import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { TRANSFER_STATUS } from '../transfer-state';
import {
  InventoryAnomalyConfirmationRequiredError,
  transferPlanToRagic,
} from './plan-transfer-helpers';

test('Ragic 明示 SUCCESS 但沒有 Record ID 時仍寫入成功紀錄並解除 pending', async () => {
  const now = new Date('2026-07-13T08:00:00.000Z');
  const completionDate = new Date('2026-08-20T00:00:00.000Z');
  const updateManyCalls: Array<Record<string, unknown>> = [];
  const suggestionUpdates: Array<Record<string, unknown>> = [];
  const transferCreates: Array<Record<string, unknown>> = [];
  let transactionCalls = 0;
  let lookupCalls = 0;
  let sentRagicData: Record<string, string | number> | null = null;

  const client = {
    fgPlanSuggestion: {
      updateMany: async (args: Record<string, unknown>) => {
        updateManyCalls.push(args);
        const where = args.where as Record<string, unknown>;
        return { count: where.transferStatus === TRANSFER_STATUS.PENDING ? 0 : 1 };
      },
      findUnique: async () => ({
        mrpRunId: 18,
        partVersion: 'TEST-V01',
        planSequence: 1,
        suggestedQty: 1200,
        completionDate,
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.PENDING,
      }),
      update: async (args: Record<string, unknown>) => {
        suggestionUpdates.push(args);
        return {};
      },
    },
    fgMonthly: {
      findFirst: async () => ({ customerCode: 'C001' }),
    },
    productionPlanTransfer: {
      create: async (args: Record<string, unknown>) => {
        transferCreates.push(args);
        return {};
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => {
      transactionCalls += 1;
      return Promise.all(operations);
    },
  } as unknown as PrismaClient;

  const result = await transferPlanToRagic(
    18,
    'MRP-20260713-080000',
    'TEST-V01',
    1,
    {
      client,
      createRecord: async (_path, data) => {
        sentRagicData = data;
        return {
          id: null,
          rawResponse: { status: 'SUCCESS' },
        };
      },
      fetchListing: async () => {
        lookupCalls += 1;
        return [];
      },
      now: () => now,
    },
  );

  assert.deepEqual(result, {
    ragicRecordId: null,
    ragicPlanNo: null,
    ragicUrl: null,
  });
  assert.equal(lookupCalls, 0);
  assert.equal(transactionCalls, 1);
  assert.equal(transferCreates.length, 1);
  assert.equal((transferCreates[0].data as Record<string, unknown>).ragicRecordId, null);
  assert.equal(sentRagicData?.['1039437'], 'No');
  assert.deepEqual(
    suggestionUpdates.map((call) => call.data),
    [{
      isTransferred: true,
      transferredAt: now,
      transferStatus: TRANSFER_STATUS.SUCCEEDED,
      transferError: null,
      transferStartedAt: null,
    }],
  );
  assert.equal(updateManyCalls.length, 2);
});

test('非正數生產計畫量在 POST Ragic 前明確失敗並解除 pending', async () => {
  const suggestionUpdates: Array<Record<string, unknown>> = [];
  let createCalls = 0;
  const client = {
    fgPlanSuggestion: {
      updateMany: async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown>;
        return { count: where.transferStatus === TRANSFER_STATUS.PENDING ? 0 : 1 };
      },
      findUnique: async () => ({
        mrpRunId: 18,
        partVersion: 'TEST-V01',
        planSequence: 1,
        suggestedQty: -100,
        completionDate: new Date('2026-08-20T00:00:00.000Z'),
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.PENDING,
      }),
      update: async (args: Record<string, unknown>) => {
        suggestionUpdates.push(args);
        return {};
      },
    },
    fgMonthly: {
      findFirst: async () => ({ customerCode: 'C001' }),
    },
    productionPlanTransfer: {
      create: async () => ({}),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  } as unknown as PrismaClient;

  await assert.rejects(
    transferPlanToRagic(18, 'MRP-20260713-080000', 'TEST-V01', 1, {
      client,
      createRecord: async () => {
        createCalls += 1;
        return { id: null, rawResponse: { status: 'SUCCESS' } };
      },
    }),
    /生產計畫量必須為大於 0 的數字/,
  );

  assert.equal(createCalls, 0);
  assert.deepEqual(
    suggestionUpdates.map((call) => call.data),
    [{
      transferStatus: TRANSFER_STATUS.FAILED,
      transferError: '生產計畫量必須為大於 0 的數字。',
      transferStartedAt: null,
      isTransferred: false,
      transferredAt: null,
    }],
  );
});

test('Ragic POST 成功後先落本機成功，再唯讀補查生產計畫編號', async () => {
  const now = new Date('2026-07-13T08:00:00.000Z');
  const suggestionUpdates: Array<Record<string, unknown>> = [];
  const transferEnrichments: Array<Record<string, unknown>> = [];
  let transactionCalls = 0;

  const client = {
    fgPlanSuggestion: {
      updateMany: async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown>;
        return { count: where.transferStatus === TRANSFER_STATUS.PENDING ? 0 : 1 };
      },
      findUnique: async () => ({
        mrpRunId: 18,
        partVersion: 'TEST-V01',
        planSequence: 1,
        suggestedQty: 1200,
        completionDate: new Date('2026-08-20T00:00:00.000Z'),
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.PENDING,
      }),
      update: async (args: Record<string, unknown>) => {
        suggestionUpdates.push(args);
        return {};
      },
    },
    fgMonthly: {
      findFirst: async () => ({ customerCode: 'C001' }),
    },
    productionPlanTransfer: {
      create: async () => ({}),
      updateMany: async (args: Record<string, unknown>) => {
        transferEnrichments.push(args);
        return { count: 1 };
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => {
      transactionCalls += 1;
      return Promise.all(operations);
    },
  } as unknown as PrismaClient;

  const result = await transferPlanToRagic(18, 'MRP-20260713-080000', 'TEST-V01', 1, {
    client,
    createRecord: async () => ({ id: '5188', rawResponse: { status: 'SUCCESS' } }),
    fetchListing: async () => {
      assert.equal(transactionCalls, 1);
      assert.equal(
        (suggestionUpdates[0].data as Record<string, unknown>).transferStatus,
        TRANSFER_STATUS.SUCCEEDED,
      );
      return [{ _ragic_id: '5188', '1006542': 'PP-202607-001' }];
    },
    now: () => now,
  });

  assert.deepEqual(result, {
    ragicRecordId: '5188',
    ragicPlanNo: 'PP-202607-001',
    ragicUrl: 'https://fdtw.app/default/d4/10/5188',
  });
  assert.equal(transferEnrichments.length, 1);
  assert.deepEqual(transferEnrichments[0].data, { ragicPlanNo: 'PP-202607-001' });
});

test('庫存批號異常未確認時在 atomic claim 與 Ragic POST 前阻擋', async () => {
  let claimCalls = 0;
  let createCalls = 0;
  const client = {
    fgMonthly: {
      findFirst: async () => ({
        customerCode: 'C001',
        erpPartNo: 'TEST-ERP-V01',
        aggregatedMembers: [],
      }),
    },
    stagingInventoryLot: {
      findMany: async () => [{
        ragicRecordId: '43838',
        lotNo: 'PL20250807-005',
        erpPartNo: 'TEST-ERP-V01',
        warehouseCode: 'HD1',
        qualityStatus: '正常',
        stockStatus: '在庫',
        stockPc: 15501,
        stockKg: 171.64427,
        unitWeightG: 11.69,
        expectedStockPc: 14683,
        stockPcDiff: 818,
        stockPcDiffPct: 0.05277,
        sourceWorkOrderNo: 'WO-TEST',
      }],
    },
    fgPlanSuggestion: {
      updateMany: async () => {
        claimCalls += 1;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    transferPlanToRagic(18, 'MRP-20260713-080000', 'TEST-V01', 1, {
      client,
      createRecord: async () => {
        createCalls += 1;
        return { id: '5188', rawResponse: { status: 'SUCCESS' } };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof InventoryAnomalyConfirmationRequiredError);
      assert.equal(error.warning.count, 1);
      assert.equal(error.warning.absoluteDiffPc, 818);
      return true;
    },
  );

  assert.equal(claimCalls, 0);
  assert.equal(createCalls, 0);
});


test('轉單庫存 guard 明確讀取非聚合成品列，不誤展開同名聚合成員', async () => {
  let memberLookupCalls = 0;
  let findFirstWhere: Record<string, unknown> | null = null;
  const client = {
    fgMonthly: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        findFirstWhere = args.where;
        return args.where.isAggregated === false
          ? { customerCode: 'C001', erpPartNo: 'ERP-NORMAL', aggregatedMembers: [] }
          : { customerCode: 'C001', erpPartNo: null, aggregatedMembers: ['MEMBER-A'] };
      },
    },
    stagingPartVersion: {
      findMany: async () => {
        memberLookupCalls += 1;
        return [{ erpPartNo: 'ERP-MEMBER' }];
      },
    },
    stagingInventoryLot: {
      findMany: async (args: { where: { erpPartNo: { in: string[] } } }) => {
        assert.deepEqual(args.where.erpPartNo.in, ['ERP-NORMAL']);
        return [{
          ragicRecordId: '43838',
          lotNo: 'PL20250807-005',
          erpPartNo: 'ERP-NORMAL',
          warehouseCode: 'HD1',
          qualityStatus: '正常',
          stockStatus: '在庫',
          stockPc: 15501,
          stockKg: 171.64427,
          unitWeightG: 11.69,
          expectedStockPc: 14683,
          stockPcDiff: 818,
          stockPcDiffPct: 0.05277,
          sourceWorkOrderNo: 'WO-TEST',
        }];
      },
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    transferPlanToRagic(18, 'MRP-20260713-080000', 'SHARED-PV', 1, { client }),
    InventoryAnomalyConfirmationRequiredError,
  );

  assert.deepEqual(findFirstWhere, {
    mrpRunId: 18,
    partVersion: 'SHARED-PV',
    isAggregated: false,
  });
  assert.equal(memberLookupCalls, 0);
});

test('確認庫存批號異常後才允許轉單並保存 warning 快照', async () => {
  const transferCreates: Array<Record<string, unknown>> = [];
  const client = {
    fgMonthly: {
      findFirst: async () => ({
        customerCode: 'C001',
        erpPartNo: 'TEST-ERP-V01',
        aggregatedMembers: [],
      }),
    },
    stagingInventoryLot: {
      findMany: async () => [{
        ragicRecordId: '43838',
        lotNo: 'PL20250807-005',
        erpPartNo: 'TEST-ERP-V01',
        warehouseCode: 'HD1',
        qualityStatus: '正常',
        stockStatus: '在庫',
        stockPc: 15501,
        stockKg: 171.64427,
        unitWeightG: 11.69,
        expectedStockPc: 14683,
        stockPcDiff: 818,
        stockPcDiffPct: 0.05277,
        sourceWorkOrderNo: 'WO-TEST',
      }],
    },
    fgPlanSuggestion: {
      updateMany: async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown>;
        return { count: where.transferStatus === TRANSFER_STATUS.PENDING ? 0 : 1 };
      },
      findUnique: async () => ({
        mrpRunId: 18,
        partVersion: 'TEST-V01',
        planSequence: 1,
        suggestedQty: 1200,
        completionDate: new Date('2026-08-20T00:00:00.000Z'),
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.PENDING,
      }),
      update: async () => ({}),
    },
    productionPlanTransfer: {
      create: async (args: Record<string, unknown>) => {
        transferCreates.push(args);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  } as unknown as PrismaClient;

  await transferPlanToRagic(18, 'MRP-20260713-080000', 'TEST-V01', 1, {
    client,
    inventoryAnomalyAcknowledged: true,
    createRecord: async () => ({
      id: '5188',
      rawResponse: { status: 'SUCCESS', '1006542': 'PP-202607-001' },
    }),
  });

  const createData = transferCreates[0].data as Record<string, unknown>;
  const warning = createData.inventoryWarning as Record<string, unknown>;
  assert.equal(warning.count, 1);
  assert.equal(warning.absoluteDiffPc, 818);
  assert.deepEqual(warning.erpPartNos, ['TEST-ERP-V01']);
  assert.equal((warning.lots as Array<Record<string, unknown>>)[0].lotNo, 'PL20250807-005');
});
