import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyWorkOrderMaterialAnomaly,
  classifyWorkOrderMaterialUsageWarning,
  workOrderMaterialUsageWarningWhere,
} from './work-order-material-anomaly';

const normalRow = {
  issuedQtyState: 'known',
  issuedQtyError: null,
  movementState: 'known',
  movementError: null,
  overIssuedQty: 0,
};

test('工令領退料 unknown 或 error 會列為阻擋異常', () => {
  assert.deepEqual(classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    movementState: 'unknown',
    movementError: 'movement_bom_mapping_ambiguous',
  }), {
    level: 'blocking',
    reason: '同工令與料號對應多筆 BOM，無法唯一歸屬',
  });
});

test('已領料但缺少 Form 20 快照會列為來源追溯', () => {
  const anomaly = classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    movementState: 'fallback',
    movementError: 'movement_source_unavailable',
  });
  assert.equal(anomaly.level, 'source');
  assert.match(anomaly.reason, /沿用 Form 28/);
});

test('未領料列的 fallback 是正常狀態，不列為異常', () => {
  assert.deepEqual(classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    issuedQtyState: 'not_issued',
    movementState: 'fallback',
    movementError: 'movement_source_unavailable',
  }), {
    level: 'none',
    reason: '正常',
  });
});

test('超領列為待確認且優先級低於 unknown', () => {
  const anomaly = classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    overIssuedQty: '791',
  });
  assert.equal(anomaly.level, 'review');
  assert.equal(anomaly.reason, '淨領用超過 BOM 791');
  assert.equal(classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    issuedQtyState: 'unknown',
    overIssuedQty: 791,
  }).level, 'blocking');
});

test('主表與子表領料狀態不一致時列為待確認，但不阻擋已知用量', () => {
  assert.deepEqual(classifyWorkOrderMaterialAnomaly({
    ...normalRow,
    issuedQtyError: 'issue_state_mismatch',
  }), {
    level: 'review',
    reason: 'BOM 主表與領料子表狀態不一致',
  });
});

test('主要週推警示同時涵蓋阻擋異常與主子表待確認異常', () => {
  assert.deepEqual(workOrderMaterialUsageWarningWhere(53), {
    mrpRunId: 53,
    OR: [
      { issuedQtyState: 'unknown' },
      { movementState: 'unknown' },
      { issuedQtyError: 'issue_state_mismatch' },
    ],
  });

  assert.deepEqual(classifyWorkOrderMaterialUsageWarning({
    issuedQtyState: 'unknown',
    issuedQtyError: 'missing_issue_details',
    movementState: 'fallback',
    movementError: 'movement_source_unavailable',
  }), {
    level: 'blocking',
    reason: 'movement_source_unavailable',
  });
  assert.deepEqual(classifyWorkOrderMaterialUsageWarning({
    issuedQtyState: 'known',
    issuedQtyError: 'issue_state_mismatch',
    movementState: 'known',
    movementError: null,
  }), {
    level: 'review',
    reason: 'issue_state_mismatch',
  });
  assert.equal(classifyWorkOrderMaterialUsageWarning({
    issuedQtyState: 'known',
    issuedQtyError: null,
    movementState: 'known',
    movementError: null,
  }), null);
});
