import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveWorkOrderMaterialLedgers,
  type WorkOrderIssueAllocation,
  type WorkOrderLedgerMovement,
} from './work-order-material-ledger';

function allocation(
  overrides: Partial<WorkOrderIssueAllocation> = {},
): WorkOrderIssueAllocation {
  return {
    bomRecordId: 'current-bom',
    workOrderNo: 'WO-CURRENT',
    bomItemKey: 'WO-CURRENT-1-1',
    componentNo: 'WIRE-01',
    inventoryLotNo: 'LOT-1',
    unit: 'kg',
    issuedAt: new Date('2026-07-25T00:00:00.000Z'),
    ...overrides,
  };
}

function movement(
  ragicRecordId: string,
  movementDate: string,
  basisType: string,
  movementType: string,
  movementQtyKg: number,
  overrides: Partial<WorkOrderLedgerMovement> = {},
): WorkOrderLedgerMovement {
  return {
    ragicRecordId,
    inventoryLotNo: 'LOT-1',
    componentNo: 'WIRE-01',
    movementDate: new Date(`${movementDate}T00:00:00.000Z`),
    basisType,
    movementType,
    inputUnit: 'kg',
    inputQtyPc: null,
    inputQtyKg: Math.abs(movementQtyKg),
    movementQtyPc: null,
    movementQtyKg,
    workOrderNo: null,
    bomItemKey: null,
    ...overrides,
  };
}

test('重複使用批號時，以本次領料 TRANS 前餘額 951kg 作為本次工令領用量', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [allocation()],
    movements: [
      movement('132389', '2026-03-26', '入-初始庫存', 'IN入庫', 1041),
      movement('143402', '2026-05-05', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('143404', '2026-05-05', '出-製令單耗用量', 'OUT出庫', -1041, {
        workOrderNo: 'WO-PREVIOUS',
      }),
      movement('151808', '2026-05-30', '入-製令單退料', 'IN入庫', 951),
      movement('168622', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
      movement('168623', '2026-07-25', '出-製令單耗用量', 'OUT出庫', -951, {
        workOrderNo: 'WO-CURRENT',
      }),
    ],
  });

  assert.deepEqual(result.summaries.get('current-bom'), {
    grossIssuedQty: 951,
    matchedIssueCount: 1,
    movementRecordIds: ['168622', '168623'],
    error: null,
  });
  assert.equal(result.attributedBomRecordIds.get('151808'), undefined);
  assert.equal(result.attributedBomRecordIds.get('168623'), 'current-bom');
});

test('同批全領分兩次耗用時，以 TRANS 前完整餘額 525000pc 作為領用量', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [allocation({ unit: 'pc' })],
    movements: [
      movement('19930', '2024-12-06', '入-初始庫存', 'IN入庫', 6520.5, {
        movementQtyPc: 525000,
      }),
      movement('22603', '2025-01-21', '調-製令單領料', 'TRANS調撥', 0, {
        movementQtyPc: 0,
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
      movement('22605', '2025-01-21', '出-製令單耗用量', 'OUT出庫', -6511.01112, {
        movementQtyPc: -524236,
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
      movement('22606', '2025-01-21', '出-製令單耗用量', 'OUT出庫', -9.48888, {
        movementQtyPc: -764,
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, 525000);
  assert.deepEqual(
    result.summaries.get('current-bom')?.movementRecordIds,
    ['22603', '22605', '22606'],
  );
});

test('空白工令正式退料只歸屬到當時批號 owner，不會跨到下一張工令', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [
      allocation({
        bomRecordId: 'previous-bom',
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
        issuedAt: new Date('2026-05-05T00:00:00.000Z'),
      }),
      allocation(),
    ],
    movements: [
      movement('1', '2026-03-26', '入-初始庫存', 'IN入庫', 1041),
      movement('2', '2026-05-05', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('3', '2026-05-05', '出-製令單耗用量', 'OUT出庫', -1041, {
        workOrderNo: 'WO-PREVIOUS',
      }),
      movement('4', '2026-05-30', '入-製令單退料', 'IN入庫', 600),
      movement('5', '2026-05-30', '入-製令單退料', 'IN入庫', 351),
      movement('6', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.attributedBomRecordIds.get('4'), 'previous-bom');
  assert.equal(result.attributedBomRecordIds.get('5'), 'previous-bom');
  assert.equal(result.attributedBomRecordIds.get('6'), 'current-bom');
  assert.equal(
    result.summaries.get('current-bom')?.movementRecordIds.includes('4'),
    false,
  );
});

test('同一 BOM 的重複領料子表列不視為跨 BOM 歧義', () => {
  const repeated = allocation();
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [repeated, { ...repeated }],
    movements: [
      movement('1', '2026-07-24', '入-初始庫存', 'IN入庫', 500),
      movement('2', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, 500);
  assert.equal(result.summaries.get('current-bom')?.error, null);
});

test('同一領料識別對應多筆 BOM 時標記 ambiguous，不猜測領用量', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [
      allocation({ bomRecordId: 'bom-a', bomItemKey: null }),
      allocation({ bomRecordId: 'bom-b', bomItemKey: null }),
    ],
    movements: [
      movement('1', '2026-07-24', '入-初始庫存', 'IN入庫', 500),
      movement('2', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
      }),
    ],
  });

  assert.equal(result.summaries.get('bom-a')?.grossIssuedQty, null);
  assert.equal(result.summaries.get('bom-a')?.error, 'ledger_attribution_ambiguous');
  assert.equal(result.summaries.get('bom-b')?.error, 'ledger_attribution_ambiguous');
});

test('批號仍有正餘額且前工令未正式退料時，阻擋跨工令交接', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [
      allocation({
        bomRecordId: 'previous-bom',
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
        issuedAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
      allocation(),
    ],
    movements: [
      movement('1', '2026-07-19', '入-初始庫存', 'IN入庫', 1000),
      movement('2', '2026-07-20', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('3', '2026-07-21', '出-製令單耗用量', 'OUT出庫', -250, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('4', '2026-07-22', '入-製令單退料', 'IN入庫', 0),
      movement('5', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('previous-bom')?.grossIssuedQty, null);
  assert.equal(result.summaries.get('previous-bom')?.error, 'ledger_handoff_incomplete');
  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, null);
  assert.equal(result.summaries.get('current-bom')?.error, 'ledger_handoff_incomplete');
  assert.equal(result.attributedBomRecordIds.get('5'), 'current-bom');
});

test('前工令耗用到零並正式退料後，允許批號交接到下一工令', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [
      allocation({
        bomRecordId: 'previous-bom',
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
        issuedAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
      allocation(),
    ],
    movements: [
      movement('1', '2026-07-19', '入-初始庫存', 'IN入庫', 1000),
      movement('2', '2026-07-20', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('3', '2026-07-21', '出-製令單耗用量', 'OUT出庫', -1000, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('4', '2026-07-22', '入-製令單退料', 'IN入庫', 600),
      movement('5', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('previous-bom')?.grossIssuedQty, 1000);
  assert.equal(result.summaries.get('previous-bom')?.error, null);
  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, 600);
  assert.equal(result.summaries.get('current-bom')?.error, null);
});

test('同工令重複領料不視為跨工令交接', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [allocation()],
    movements: [
      movement('1', '2026-07-24', '入-初始庫存', 'IN入庫', 500),
      movement('2', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
      movement('3', '2026-07-26', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, 1000);
  assert.equal(result.summaries.get('current-bom')?.error, null);
});

test('前工令已耗用到零時不會形成雙重保留', () => {
  const result = resolveWorkOrderMaterialLedgers({
    allocations: [
      allocation({
        bomRecordId: 'previous-bom',
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
        issuedAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
      allocation(),
    ],
    movements: [
      movement('1', '2026-07-19', '入-初始庫存', 'IN入庫', 500),
      movement('2', '2026-07-20', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('3', '2026-07-21', '出-製令單耗用量', 'OUT出庫', -500, {
        workOrderNo: 'WO-PREVIOUS',
        bomItemKey: 'WO-PREVIOUS-1-1',
      }),
      movement('4', '2026-07-25', '調-製令單領料', 'TRANS調撥', 0, {
        workOrderNo: 'WO-CURRENT',
        bomItemKey: 'WO-CURRENT-1-1',
      }),
    ],
  });

  assert.equal(result.summaries.get('previous-bom')?.error, null);
  assert.equal(result.summaries.get('current-bom')?.grossIssuedQty, 0);
  assert.equal(result.summaries.get('current-bom')?.error, null);
});
