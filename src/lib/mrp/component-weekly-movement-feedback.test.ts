import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComponentWeeklyMovementInventoryFeedback } from './component-weekly-movement-feedback';

const returnedMovement = {
  sourceRecordId: '167719',
  workOrderNo: 'DEMO-WO-101',
  inventoryLotNo: 'DEMO-LOT-001',
  basisType: '入-製令單退料',
  movementType: 'IN入庫',
};

test('正式退料批號仍有本 Run 在庫量時回饋目前在庫', () => {
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returnedMovement,
    movementIndex: 0,
    movements: [returnedMovement],
    inventoryLots: [{
      sourceRecordId: '57568',
      lotNo: 'DEMO-LOT-001',
      warehouseCode: 'WWR',
      qualityStatus: '正常',
      stockStatus: '在庫',
      stockPc: 0,
      stockKg: 1122,
    }],
    unit: 'kg',
  });

  assert.equal(result.state, 'in_stock');
  assert.equal(result.currentQty, 1122);
  assert.equal(result.inventoryLots[0]?.sourceRecordId, '57568');
  assert.deepEqual(result.subsequentIssueWorkOrderNos, []);
});

test('正式退料批號只有不可用庫存時不計入可用量', () => {
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returnedMovement,
    movementIndex: 0,
    movements: [returnedMovement],
    inventoryLots: [{
      sourceRecordId: '57569',
      lotNo: 'DEMO-LOT-001',
      warehouseCode: 'WWR',
      qualityStatus: '不良',
      stockStatus: '在庫',
      stockPc: 0,
      stockKg: 90,
    }],
    unit: 'kg',
  });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.currentQty, 90);
  assert.equal(result.availableQty, 0);
  assert.equal(result.inventoryLots[0]?.sourceRecordId, '57569');
});

test('正式退料批號已由後續工令重新領用時回饋退料後再領用', () => {
  const subsequentIssue = {
    sourceRecordId: '171702',
    workOrderNo: 'DEMO-WO-102',
    inventoryLotNo: 'DEMO-LOT-002',
    basisType: '調-製令單領料',
    movementType: 'TRANS調撥',
  };
  const returned = {
    ...returnedMovement,
    sourceRecordId: '171686',
    inventoryLotNo: 'DEMO-LOT-002',
  };
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returned,
    movementIndex: 0,
    movements: [returned, subsequentIssue],
    inventoryLots: [],
    unit: 'kg',
  });

  assert.equal(result.state, 'reissued');
  assert.equal(result.currentQty, 0);
  assert.deepEqual(result.subsequentIssueWorkOrderNos, ['DEMO-WO-102']);
});

test('正式退料批號仍有在庫量時同時回饋所有後續領用工令並去重', () => {
  const issueToSecondWorkOrder = {
    sourceRecordId: '171702',
    workOrderNo: 'DEMO-WO-103',
    inventoryLotNo: 'DEMO-LOT-003',
    basisType: '調-製令單領料',
    movementType: 'TRANS調撥',
  };
  const issueToThirdWorkOrder = {
    ...issueToSecondWorkOrder,
    sourceRecordId: '171703',
    workOrderNo: 'DEMO-WO-104',
  };
  const returned = {
    ...returnedMovement,
    sourceRecordId: '164620',
    inventoryLotNo: 'DEMO-LOT-003',
  };
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returned,
    movementIndex: 0,
    movements: [
      returned,
      issueToSecondWorkOrder,
      { ...issueToSecondWorkOrder, sourceRecordId: '171704' },
      issueToThirdWorkOrder,
    ],
    inventoryLots: [{
      sourceRecordId: '11160',
      lotNo: 'DEMO-LOT-003',
      warehouseCode: 'WWR',
      qualityStatus: '正常',
      stockStatus: '在庫',
      stockPc: 0,
      stockKg: 696,
    }],
    unit: 'kg',
  });

  assert.equal(result.state, 'in_stock');
  assert.equal(result.availableQty, 696);
  assert.deepEqual(result.subsequentIssueWorkOrderNos, ['DEMO-WO-103', 'DEMO-WO-104']);
});

test('沒有批號的 movement 不推測庫存狀態', () => {
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: { ...returnedMovement, inventoryLotNo: null },
    movementIndex: 0,
    movements: [],
    inventoryLots: [],
    unit: 'kg',
  });

  assert.equal(result.state, 'unknown');
  assert.equal(result.currentQty, 0);
  assert.deepEqual(result.subsequentIssueWorkOrderNos, []);
});
