import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { FORM10_FIELDS } from '../sync/field-maps';
import { TRANSFER_STATUS } from '../transfer-state';
import {
  inspectUnknownTransfer,
  reconcileUnknownTransfer,
  TRANSFER_RECONCILIATION_ACTION,
  TransferReconciliationError,
} from './transfer-reconciliation';

const NOW = new Date('2026-07-13T08:00:00.000Z');
const COMPLETION_DATE = new Date('2026-08-20T00:00:00.000Z');

function buildClient(options: {
  updateCount?: number;
  existingTransfer?: { id: number; ragicRecordId: string | null } | null;
} = {}) {
  const calls = {
    transactions: 0,
    updates: [] as Array<Record<string, unknown>>,
    creates: [] as Array<Record<string, unknown>>,
    transferUpdates: [] as Array<Record<string, unknown>>,
  };
  const transactionClient = {
    fgPlanSuggestion: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.updates.push(args);
        return { count: options.updateCount ?? 1 };
      },
    },
    productionPlanTransfer: {
      findFirst: async () => options.existingTransfer ?? null,
      create: async (args: Record<string, unknown>) => {
        calls.creates.push(args);
        return { id: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        calls.transferUpdates.push(args);
        return { id: options.existingTransfer?.id ?? 1 };
      },
    },
  };
  const client = {
    fgPlanSuggestion: {
      findUnique: async () => ({
        mrpRunId: 15,
        partVersion: 'TEST-V01',
        planSequence: 2,
        suggestedQty: 1200,
        completionDate: COMPLETION_DATE,
        isTransferred: false,
        transferStatus: TRANSFER_STATUS.UNKNOWN,
      }),
    },
    fgMonthly: {
      findFirst: async () => ({ customerCode: 'C001' }),
    },
    $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      calls.transactions += 1;
      return callback(transactionClient);
    },
  } as unknown as PrismaClient;
  return { client, calls };
}

function matchingRagicRecord() {
  return {
    [FORM10_FIELDS.planNo]: 'PP202607-0001',
    [FORM10_FIELDS.createdAt]: '2026/07/13 16:01:00',
    [FORM10_FIELDS.partVersion]: 'TEST-V01',
    [FORM10_FIELDS.mrpSourceCode]: 'MRP-20260713-080000',
    [FORM10_FIELDS.targetQty]: '1,200',
    [FORM10_FIELDS.targetDate]: '2026/08/20',
  };
}

const baseInput = {
  runId: 15,
  runCreatedAt: NOW,
  versionCode: 'MRP-20260713-080000',
  partVersion: 'TEST-V01',
  planSequence: 2,
};

test('確認已建單會唯讀核對四個欄位，再原子標記成功並補轉單紀錄', async () => {
  const { client, calls } = buildClient();

  const result = await reconcileUnknownTransfer(
    {
      ...baseInput,
      action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
      ragicRecordId: '5188',
    },
    {
      client,
      fetchRecord: async () => matchingRagicRecord(),
      now: () => NOW,
    },
  );

  assert.equal(result.transferStatus, TRANSFER_STATUS.SUCCEEDED);
  assert.equal(result.ragicRecordId, '5188');
  assert.equal(result.ragicPlanNo, 'PP202607-0001');
  assert.equal(calls.transactions, 1);
  assert.equal(calls.updates.length, 1);
  assert.deepEqual(calls.updates[0].where, {
    mrpRunId: 15,
    partVersion: 'TEST-V01',
    planSequence: 2,
    isTransferred: false,
    transferStatus: TRANSFER_STATUS.UNKNOWN,
  });
  assert.equal(calls.creates.length, 1);
  assert.equal((calls.creates[0].data as Record<string, unknown>).ragicRecordId, '5188');
});

test('Ragic 唯讀來源欄為空時仍可用 Record ID、客料版本、數量與日期完成對帳', async () => {
  const { client } = buildClient();
  const record = matchingRagicRecord();
  record[FORM10_FIELDS.mrpSourceCode] = '';

  const result = await reconcileUnknownTransfer(
    {
      ...baseInput,
      action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
      ragicRecordId: '5188',
    },
    { client, fetchRecord: async () => record },
  );

  assert.equal(result.transferStatus, TRANSFER_STATUS.SUCCEEDED);
  assert.equal(result.ragicRecordId, '5188');
});

test('Ragic 來源欄有值但屬於其他 MRP Run 時拒絕對帳', async () => {
  const { client, calls } = buildClient();
  const record = matchingRagicRecord();
  record[FORM10_FIELDS.mrpSourceCode] = 'MRP-OTHER-RUN';

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
        ragicRecordId: '5188',
      },
      { client, fetchRecord: async () => record },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 422,
  );
  assert.equal(calls.transactions, 0);
});

test('手動 Record ID 的來源欄空白且早於本 Run 時拒絕對帳', async () => {
  const { client, calls } = buildClient();
  const record = matchingRagicRecord();
  record[FORM10_FIELDS.mrpSourceCode] = '';
  record[FORM10_FIELDS.createdAt] = '2026/07/13 15:59:59';

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
        ragicRecordId: '5000',
      },
      { client, fetchRecord: async () => record },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 422,
  );
  assert.equal(calls.transactions, 0);
});

test('唯讀檢查只回傳客料版本、數量、完成日相符且來源未衝突的候選', async () => {
  const { client } = buildClient();
  const records = [
    {
      _ragic_id: '5188',
      ...matchingRagicRecord(),
      [FORM10_FIELDS.mrpSourceCode]: '',
      [FORM10_FIELDS.createdAt]: '2026/07/13 16:01:00',
    },
    {
      _ragic_id: '5189',
      ...matchingRagicRecord(),
      [FORM10_FIELDS.targetQty]: '999',
    },
    {
      _ragic_id: '5190',
      ...matchingRagicRecord(),
      [FORM10_FIELDS.mrpSourceCode]: 'MRP-OTHER-RUN',
    },
  ];

  const result = await inspectUnknownTransfer(baseInput, {
    client,
    fetchListing: async () => records,
  });

  assert.equal(result.matchStatus, 'single_match');
  assert.deepEqual(result.candidates, [{
    ragicRecordId: '5188',
    ragicPlanNo: 'PP202607-0001',
    suggestedQty: 1200,
    completionDate: '2026/08/20',
    createdAt: '2026/07/13 16:01:00',
    mrpSourceCode: null,
    ragicUrl: 'https://fdtw.app/default/d4/10/5188',
  }]);
});

test('唯讀檢查會區分找不到與多筆候選', async () => {
  const { client } = buildClient();
  const notFound = await inspectUnknownTransfer(baseInput, {
    client,
    fetchListing: async () => [],
  });
  assert.equal(notFound.matchStatus, 'not_found');

  const multiple = await inspectUnknownTransfer(baseInput, {
    client,
    fetchListing: async () => [
      { _ragic_id: '5188', ...matchingRagicRecord() },
      { _ragic_id: '5189', ...matchingRagicRecord() },
    ],
  });
  assert.equal(multiple.matchStatus, 'multiple_matches');
  assert.deepEqual(multiple.candidates.map((candidate) => candidate.ragicRecordId), ['5189', '5188']);
});

test('來源欄空白的舊單不會成為本 Run 候選', async () => {
  const { client } = buildClient();
  const result = await inspectUnknownTransfer(baseInput, {
    client,
    fetchListing: async () => [{
      _ragic_id: '5000',
      ...matchingRagicRecord(),
      [FORM10_FIELDS.mrpSourceCode]: '',
      [FORM10_FIELDS.createdAt]: '2026/07/13 15:59:59',
    }],
  });

  assert.equal(result.matchStatus, 'not_found');
  assert.deepEqual(result.candidates, []);
});

test('Record ID 的客料版本不符時拒絕對帳且不進交易', async () => {
  const { client, calls } = buildClient();
  const record = matchingRagicRecord();
  record[FORM10_FIELDS.partVersion] = 'OTHER-V01';

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
        ragicRecordId: '5188',
      },
      { client, fetchRecord: async () => record },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 422,
  );
  assert.equal(calls.transactions, 0);
  assert.equal(calls.creates.length, 0);
});

test('確認未建單會先重新查 Ragic，確認沒有候選才把 unknown 轉成 failed', async () => {
  const { client, calls } = buildClient();
  let fetched = false;

  const result = await reconcileUnknownTransfer(
    {
      ...baseInput,
      action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_NOT_CREATED,
    },
    {
      client,
      fetchListing: async () => {
        fetched = true;
        return [];
      },
    },
  );

  assert.equal(fetched, true);
  assert.equal(result.transferStatus, TRANSFER_STATUS.FAILED);
  assert.deepEqual(calls.updates[0].data, {
    isTransferred: false,
    transferredAt: null,
    transferStatus: TRANSFER_STATUS.FAILED,
    transferError: '已人工確認 Ragic 未建立單據，可重新轉單。',
    transferStartedAt: null,
  });
});

test('Ragic 已有相符候選時不得標記為未建單', async () => {
  const { client, calls } = buildClient();

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_NOT_CREATED,
      },
      {
        client,
        fetchListing: async () => [{ _ragic_id: '5188', ...matchingRagicRecord() }],
      },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 409,
  );
  assert.equal(calls.transactions, 0);
});

test('對帳期間狀態已被另一位使用者更新時回傳 conflict', async () => {
  const { client, calls } = buildClient({ updateCount: 0 });

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
        ragicRecordId: '5188',
      },
      { client, fetchRecord: async () => matchingRagicRecord() },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 409,
  );
  assert.equal(calls.creates.length, 0);
});

test('本機已有不同 Record ID 時拒絕覆寫轉單紀錄', async () => {
  const { client, calls } = buildClient({
    existingTransfer: { id: 9, ragicRecordId: '4999' },
  });

  await assert.rejects(
    reconcileUnknownTransfer(
      {
        ...baseInput,
        action: TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED,
        ragicRecordId: '5188',
      },
      { client, fetchRecord: async () => matchingRagicRecord() },
    ),
    (error) => error instanceof TransferReconciliationError && error.status === 409,
  );
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.transferUpdates.length, 0);
});
