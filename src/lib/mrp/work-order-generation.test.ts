import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { RagicActionButtonError } from '@/lib/ragic-client';
import { FORM10_FIELDS } from '@/lib/sync/field-maps';
import { TransferReconciliationError } from '@/lib/mrp/transfer-reconciliation';
import { WORK_ORDER_STATUS, WorkOrderStateConflictError, type WorkOrderStatus } from '@/lib/work-order-state';
import {
  attachProductionPlanRecordId,
  enqueueWorkOrderGeneration,
  generateWorkOrders,
  inspectWorkOrderProgress,
} from './work-order-generation';

function form10Record(workOrderNumbers: string[] = [], summary = 'No') {
  return {
    [FORM10_FIELDS.hasWorkOrderNo]: summary,
    [`_subtable_${FORM10_FIELDS.processSubtable}`]: workOrderNumbers.map((workOrderNo, index) => ({
      [FORM10_FIELDS.workOrderNo]: workOrderNo,
      '1005988': `TEST-V01-${String(index + 1).padStart(2, '0')}PA`,
    })),
  };
}

function createMockClient(initialStatus: WorkOrderStatus = WORK_ORDER_STATUS.IDLE) {
  const transfer: Record<string, unknown> = {
    id: 9,
    mrpRunId: 21,
    mrpRun: { createdAt: new Date('2026-07-17T08:00:00.000Z') },
    mrpVersionCode: 'MRP-20260717-080000',
    partVersion: 'TEST-V01',
    planSequence: 1,
    suggestedQty: 1200,
    completionDate: new Date('2026-08-20T00:00:00.000Z'),
    ragicRecordId: '5637',
    ragicPlanNo: 'PP202605-0164',
    ragicUrl: 'https://fdtw.app/default/d4/10/5637',
    workOrderStatus: initialStatus,
    workOrderError: null,
    workOrderStartedAt: null,
    workOrderCompletedAt: null,
    workOrderResponse: null,
  };
  const updateManyCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  const client = {
    productionPlanTransfer: {
      findUnique: async () => ({ ...transfer }),
      updateMany: async (args: Record<string, unknown>) => {
        updateManyCalls.push(args);
        const where = args.where as Record<string, unknown>;
        const data = args.data as Record<string, unknown>;
        if (where.OR) return { count: 0 };
        if (where.workOrderStatus && typeof where.workOrderStatus === 'object') {
          const allowed = (where.workOrderStatus as { in?: string[] }).in ?? [];
          if (!allowed.includes(String(transfer.workOrderStatus))) return { count: 0 };
          Object.assign(transfer, data);
          return { count: 1 };
        }
        Object.assign(transfer, data);
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        updateCalls.push(args);
        Object.assign(transfer, args.data as Record<string, unknown>);
        return { ...transfer };
      },
    },
  } as unknown as PrismaClient;

  return { client, transfer, updateManyCalls, updateCalls };
}

test('加入背景佇列只更新本機狀態，不讀取或寫入 Ragic', async () => {
  const { client, transfer } = createMockClient();
  const queuedAt = new Date('2026-07-17T08:00:00.000Z');

  const first = await enqueueWorkOrderGeneration(9, 21, {
    client,
    now: () => queuedAt,
  });
  const second = await enqueueWorkOrderGeneration(9, 21, {
    client,
    now: () => new Date('2026-07-17T08:00:01.000Z'),
  });

  assert.equal(first.accepted, true);
  assert.equal(first.workOrderStatus, WORK_ORDER_STATUS.QUEUED);
  assert.equal(second.accepted, false);
  assert.equal(second.workOrderStatus, WORK_ORDER_STATUS.QUEUED);
  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.QUEUED);
  assert.equal(transfer.workOrderStartedAt, queuedAt);
});

test('背景工作啟動前讀不到 Ragic 時離開 queued 並允許修正後重試', async () => {
  const { client, transfer } = createMockClient(WORK_ORDER_STATUS.QUEUED);

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => { throw new Error('temporary read failure'); },
    }),
    (error) => error instanceof WorkOrderStateConflictError
      && error.workOrderStatus === WORK_ORDER_STATUS.FAILED,
  );

  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.FAILED);
  assert.match(String(transfer.workOrderError), /temporary read failure/);
});

test('Ragic 已有工令單時只同步成功狀態，不執行 Button 92', async () => {
  const { client, updateCalls } = createMockClient();
  let buttonCalls = 0;

  const result = await generateWorkOrders(9, 21, {
    client,
    fetchRecord: async () => form10Record(['WO-1', 'WO-2'], 'Yes'),
    fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
    executeButton: async () => {
      buttonCalls += 1;
      return { status: 'SUCCESS' };
    },
    now: () => new Date('2026-07-17T08:00:00.000Z'),
  });

  assert.equal(result.workOrderStatus, WORK_ORDER_STATUS.SUCCEEDED);
  assert.equal(result.alreadyGenerated, true);
  assert.equal(buttonCalls, 0);
  assert.equal(updateCalls.length, 1);
});

test('Button 92 明示成功且 Ragic 出現工令單號後才標記完成', async () => {
  const { client, transfer } = createMockClient();
  let reads = 0;
  let buttonCalls = 0;

  const result = await generateWorkOrders(9, 21, {
    client,
    fetchRecord: async () => reads++ === 0
      ? form10Record()
      : form10Record(['WO-1', 'WO-2'], 'Yes'),
    fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
    executeButton: async (path, recordId, buttonId) => {
      buttonCalls += 1;
      assert.equal(path, '/default/d4/10');
      assert.equal(recordId, '5637');
      assert.equal(buttonId, '92');
      return { status: 'SUCCESS', msg: 'Action completed.' };
    },
    now: () => new Date('2026-07-17T08:00:00.000Z'),
  });

  assert.equal(result.workOrderStatus, WORK_ORDER_STATUS.SUCCEEDED);
  assert.equal(result.alreadyGenerated, false);
  assert.equal(buttonCalls, 1);
  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.SUCCEEDED);
});

test('API metadata 沒有 Button 92 時拒絕執行且不搶 pending', async () => {
  const { client, transfer, updateManyCalls } = createMockClient();
  let buttonCalls = 0;

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => form10Record(),
      fetchButtons: async () => [{ id: '18', name: '重新整理' }],
      executeButton: async () => {
        buttonCalls += 1;
        return { status: 'SUCCESS' };
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.statusCode === 503
      && /Button 92/.test(err.message),
  );

  assert.equal(buttonCalls, 0);
  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.IDLE);
  assert.equal(updateManyCalls.length, 1);
});

test('Button 92 回應中斷時標記 unknown 並鎖定重跑', async () => {
  const { client, transfer } = createMockClient();
  let buttonCalls = 0;

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => form10Record(),
      fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
      executeButton: async () => {
        buttonCalls += 1;
        throw new Error('socket hang up');
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN,
  );

  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.UNKNOWN);
  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => form10Record(),
      fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
      executeButton: async () => {
        buttonCalls += 1;
        return { status: 'SUCCESS' };
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN,
  );
  assert.equal(buttonCalls, 1);
});

test('Button 92 明確拒絕時標記 failed，修正後可重新 claim', async () => {
  const { client, transfer } = createMockClient();

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => form10Record(),
      fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
      executeButton: async () => {
        throw new RagicActionButtonError('No access right', 'definite_failure', 403, 106);
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.FAILED,
  );
  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.FAILED);

  let reads = 0;
  const result = await generateWorkOrders(9, 21, {
    client,
    fetchRecord: async () => reads++ === 0
      ? form10Record()
      : form10Record(['WO-1'], 'Yes'),
    fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
    executeButton: async () => ({ status: 'SUCCESS' }),
  });
  assert.equal(result.workOrderStatus, WORK_ORDER_STATUS.SUCCEEDED);
});

test('同時兩個請求只有一個能 claim 並執行 Button 92', async () => {
  const { client } = createMockClient();
  let buttonCalls = 0;
  let actionCompleted = false;
  let releaseAction!: () => void;
  let announceStarted!: () => void;
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
  const actionStarted = new Promise<void>((resolve) => { announceStarted = resolve; });
  const deps = {
    client,
    fetchRecord: async () => actionCompleted
      ? form10Record(['WO-1', 'WO-2'], 'Yes')
      : form10Record(),
    fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
    executeButton: async () => {
      buttonCalls += 1;
      announceStarted();
      await actionGate;
      actionCompleted = true;
      return { status: 'SUCCESS' };
    },
  };

  const first = generateWorkOrders(9, 21, deps);
  await actionStarted;
  await assert.rejects(
    () => generateWorkOrders(9, 21, deps),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.PENDING,
  );
  releaseAction();
  const result = await first;

  assert.equal(result.workOrderStatus, WORK_ORDER_STATUS.SUCCEEDED);
  assert.equal(buttonCalls, 1);
});

test('逐列判斷工令進度，不以只看首列的摘要公式當成完整成功', () => {
  assert.deepEqual(inspectWorkOrderProgress(form10Record()), {
    state: 'none', totalRows: 0, generatedRows: 0,
  });
  assert.deepEqual(inspectWorkOrderProgress(form10Record(['WO-1', ''], 'Yes')), {
    state: 'partial', totalRows: 2, generatedRows: 1,
  });
  assert.deepEqual(inspectWorkOrderProgress(form10Record(['WO-1', 'WO-2'], 'Yes')), {
    state: 'complete', totalRows: 2, generatedRows: 2,
  });
  assert.equal(inspectWorkOrderProgress(form10Record([], 'Yes')).state, 'partial');
});

test('執行前發現部分工令時轉成 unknown，且絕不重跑 Button 92', async () => {
  const { client, transfer } = createMockClient();
  let buttonCalls = 0;

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => form10Record(['WO-1', ''], 'Yes'),
      fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
      executeButton: async () => {
        buttonCalls += 1;
        return { status: 'SUCCESS' };
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN
      && /1\/2/.test(err.message),
  );

  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.UNKNOWN);
  assert.equal(buttonCalls, 0);
});

test('Button 92 成功後只產生部分工令時鎖定 unknown，不誤標 succeeded', async () => {
  const { client, transfer } = createMockClient();
  let reads = 0;
  let buttonCalls = 0;

  await assert.rejects(
    () => generateWorkOrders(9, 21, {
      client,
      fetchRecord: async () => reads++ === 0
        ? form10Record()
        : form10Record(['WO-1', ''], 'Yes'),
      fetchButtons: async () => [{ id: '92', name: '載入製程並推估時間' }],
      executeButton: async () => {
        buttonCalls += 1;
        return { status: 'SUCCESS' };
      },
    }),
    (err) => err instanceof WorkOrderStateConflictError
      && err.workOrderStatus === WORK_ORDER_STATUS.UNKNOWN
      && /1\/2/.test(err.message),
  );

  assert.equal(buttonCalls, 1);
  assert.equal(transfer.workOrderStatus, WORK_ORDER_STATUS.UNKNOWN);
});

test('已成功轉單但缺 Record ID 時，只做唯讀四欄核對並補上本機連結', async () => {
  const { client, transfer, updateManyCalls } = createMockClient();
  transfer.ragicRecordId = null;
  transfer.ragicPlanNo = null;
  transfer.ragicUrl = null;

  const result = await attachProductionPlanRecordId(9, 21, ' 5188 ', {
    client,
    fetchRecord: async () => ({
      [FORM10_FIELDS.planNo]: 'PP202607-0001',
      [FORM10_FIELDS.createdAt]: '2026/07/17 16:01:00',
      [FORM10_FIELDS.partVersion]: 'TEST-V01',
      [FORM10_FIELDS.mrpSourceCode]: 'MRP-20260717-080000',
      [FORM10_FIELDS.targetQty]: '1,200',
      [FORM10_FIELDS.targetDate]: '2026/08/20',
    }),
  });

  assert.equal(result.ragicRecordId, '5188');
  assert.equal(result.ragicPlanNo, 'PP202607-0001');
  assert.equal(transfer.ragicRecordId, '5188');
  assert.equal(updateManyCalls.length, 1);
  assert.deepEqual(updateManyCalls[0].where, {
    id: 9,
    mrpRunId: 21,
    ragicRecordId: null,
  });
});

test('補 Record ID 時四欄任一不符都拒絕，且不更新本機 transfer', async () => {
  const { client, transfer, updateManyCalls } = createMockClient();
  transfer.ragicRecordId = null;

  await assert.rejects(
    () => attachProductionPlanRecordId(9, 21, '5188', {
      client,
      fetchRecord: async () => ({
        [FORM10_FIELDS.planNo]: 'PP202607-0001',
        [FORM10_FIELDS.partVersion]: 'OTHER-V01',
        [FORM10_FIELDS.mrpSourceCode]: 'MRP-20260717-080000',
        [FORM10_FIELDS.targetQty]: '1,200',
        [FORM10_FIELDS.targetDate]: '2026/08/20',
      }),
    }),
    (error) => error instanceof TransferReconciliationError && error.status === 422,
  );

  assert.equal(transfer.ragicRecordId, null);
  assert.equal(updateManyCalls.length, 0);
});
