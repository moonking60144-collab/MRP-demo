import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComponentWeeklyMovementInventoryFeedback } from './component-weekly-movement-feedback';

const returnedMovement = {
  ragicRecordId: '167719',
  workOrderNo: 'WO-26040455',
  inventoryLotNo: 'PL20260324-037',
  basisType: '入-製令單退料',
  movementType: 'IN入庫',
};

test('正式退料批號仍有本 Run 在庫量時回饋目前在庫', () => {
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returnedMovement,
    movementIndex: 0,
    movements: [returnedMovement],
    inventoryLots: [{
      ragicRecordId: '57568',
      lotNo: 'PL20260324-037',
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
  assert.equal(result.inventoryLots[0]?.ragicRecordId, '57568');
  assert.deepEqual(result.subsequentIssueWorkOrderNos, []);
});

test('正式退料批號只有不可用庫存時不計入可用量', () => {
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returnedMovement,
    movementIndex: 0,
    movements: [returnedMovement],
    inventoryLots: [{
      ragicRecordId: '57569',
      lotNo: 'PL20260324-037',
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
  assert.equal(result.inventoryLots[0]?.ragicRecordId, '57569');
});

test('正式退料批號已由後續工令重新領用時回饋退料後再領用', () => {
  const subsequentIssue = {
    ragicRecordId: '171702',
    workOrderNo: 'WO-26060240',
    inventoryLotNo: 'PL20260730-037',
    basisType: '調-製令單領料',
    movementType: 'TRANS調撥',
  };
  const returned = {
    ...returnedMovement,
    ragicRecordId: '171686',
    inventoryLotNo: 'PL20260730-037',
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
  assert.deepEqual(result.subsequentIssueWorkOrderNos, ['WO-26060240']);
});

test('正式退料批號仍有在庫量時同時回饋所有後續領用工令並去重', () => {
  const issueToSecondWorkOrder = {
    ragicRecordId: '171702',
    workOrderNo: 'WO-26060506',
    inventoryLotNo: 'PL20230914-078',
    basisType: '調-製令單領料',
    movementType: 'TRANS調撥',
  };
  const issueToThirdWorkOrder = {
    ...issueToSecondWorkOrder,
    ragicRecordId: '171703',
    workOrderNo: 'WO-26060513',
  };
  const returned = {
    ...returnedMovement,
    ragicRecordId: '164620',
    inventoryLotNo: 'PL20230914-078',
  };
  const result = resolveComponentWeeklyMovementInventoryFeedback({
    movement: returned,
    movementIndex: 0,
    movements: [
      returned,
      issueToSecondWorkOrder,
      { ...issueToSecondWorkOrder, ragicRecordId: '171704' },
      issueToThirdWorkOrder,
    ],
    inventoryLots: [{
      ragicRecordId: '11160',
      lotNo: 'PL20230914-078',
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
  assert.deepEqual(result.subsequentIssueWorkOrderNos, ['WO-26060506', 'WO-26060513']);
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
