import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateWorkOrderBomUsage,
  reconcileWorkOrderBomUsage,
  resolveWorkOrderBomDemand,
  type WorkOrderBomUsageResult,
} from './work-order-bom-usage';

function issueRow(
  qty: number,
  unit: 'pc' | 'kg',
  unitWeightG?: number,
  issued = 'Yes',
  selection: '整批All' | '部分Partial' = '部分Partial',
  batchPc?: number,
  batchKg?: number,
) {
  return {
    '1006339': issued,
    '1006285': selection,
    '1006286': String(qty),
    '1006288': unit,
    '1006302': unitWeightG == null ? '' : String(unitWeightG),
    '1010898': batchPc == null ? '' : String(batchPc),
    '1010899': batchKg == null ? '' : String(batchKg),
  };
}

function formUsage(overrides: Partial<WorkOrderBomUsageResult> = {}): WorkOrderBomUsageResult {
  return {
    issuedQty: 0,
    remainingUsage: 250,
    issuedQtyState: 'not_issued',
    issuedDetailCount: 0,
    issuedQtyError: null,
    ...overrides,
  };
}

function movement(overrides: Record<string, unknown> = {}) {
  return {
    basisType: '出-製令單耗用量',
    movementType: 'OUT出庫',
    inputUnit: 'kg',
    inputQtyPc: null,
    inputQtyKg: 951,
    movementQtyPc: null,
    movementQtyKg: -951,
    ...overrides,
  };
}

test('未領料工令保留全部需求', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'No',
    issueRows: [],
  });
  assert.deepEqual(result, {
    issuedQty: 0,
    remainingUsage: 600,
    issuedQtyState: 'not_issued',
    issuedDetailCount: 0,
    issuedQtyError: null,
  });
});

test('主表領料狀態空白但子表沒有已執行列時，依子表判定為未領料', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: '',
    issueRows: [],
  });
  assert.deepEqual(result, {
    issuedQty: 0,
    remainingUsage: 600,
    issuedQtyState: 'not_issued',
    issuedDetailCount: 0,
    issuedQtyError: null,
  });
});

test('主表非預期領料狀態不影響沒有已執行子表列的未領料判斷', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Pending',
    issueRows: [],
  });
  assert.equal(result.issuedQtyState, 'not_issued');
  assert.equal(result.remainingUsage, 600);
  assert.equal(result.issuedQtyError, null);
});

test('主表 No 但子表有已執行領料時仍依子表扣除，並保留非阻擋異常', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 2464,
    bomUnit: 'kg',
    alreadyPicked: 'No',
    issueRows: [
      issueRow(0, 'kg', undefined, 'Yes', '整批All', undefined, 1104),
      issueRow(0, 'kg', undefined, 'Yes', '整批All', undefined, 1101),
    ],
  });

  assert.deepEqual(result, {
    issuedQty: 2205,
    remainingUsage: 259,
    issuedQtyState: 'known',
    issuedDetailCount: 2,
    issuedQtyError: 'issue_state_mismatch',
  });
});

test('部分領料同單位：已領 600pc，需求 600pc，剩餘需求為 0', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(600, 'pc')],
  });
  assert.equal(result.issuedQty, 600);
  assert.equal(result.remainingUsage, 0);
  assert.equal(result.issuedQtyState, 'known');
});

test('已領 500，需求 600，只保留 100 需求', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(500, 'pc')],
  });
  assert.equal(result.issuedQty, 500);
  assert.equal(result.remainingUsage, 100);
});

test('超領 700，需求 600，不產生負需求', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(700, 'pc')],
  });
  assert.equal(result.remainingUsage, 0);
});

test('只加總已執行領料列', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(200, 'pc'), issueRow(300, 'pc', undefined, 'No')],
  });
  assert.equal(result.issuedQty, 200);
  assert.equal(result.remainingUsage, 400);
  assert.equal(result.issuedDetailCount, 1);
});

test('部分領料跨單位：kg 可依本批單位重換算成 pc', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(5, 'kg', 10)],
  });
  assert.equal(result.issuedQty, 500);
  assert.equal(result.remainingUsage, 100);
});

test('部分領料跨單位：pc 可依本批單位重換算成 kg', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 6,
    bomUnit: 'kg',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(500, 'pc', 10)],
  });
  assert.equal(result.issuedQty, 5);
  assert.equal(result.remainingUsage, 1);
});

test('整批領料同單位：使用批號原始 pc，不使用部分領料指定量', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 525000,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(764, 'pc', 12.42, 'Yes', '整批All', 525000, 6520.5)],
  });
  assert.equal(result.issuedQty, 525000);
  assert.equal(result.remainingUsage, 0);
  assert.equal(result.issuedQtyState, 'known');
});

test('整批領料跨單位：BOM 為 kg 時使用同批原始 kg', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 7000,
    bomUnit: 'kg',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(525000, 'pc', 12.42, 'Yes', '整批All', 525000, 6520.5)],
  });
  assert.equal(result.issuedQty, 6520.5);
  assert.equal(result.remainingUsage, 479.5);
  assert.equal(result.issuedQtyState, 'known');
});

test('整批領料缺少 BOM 單位對應的批號原始量時標記 unknown', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 525000,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(764, 'pc', 12.42, 'Yes', '整批All', undefined, 6520.5)],
  });
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyError, 'missing_issued_quantity');
});

test('非預期領料方式不擅自套用指定量，改列 unknown', () => {
  const row = issueRow(100, 'pc') as Record<string, unknown>;
  row['1006285'] = '其他方式';
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [row],
  });
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.remainingUsage, null);
});

test('主表 Yes 但子表沒有已執行列時保留全部需求，並列主子表異常', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [],
  });
  assert.equal(result.issuedQtyState, 'not_issued');
  assert.equal(result.issuedQty, 0);
  assert.equal(result.remainingUsage, 600);
  assert.equal(result.issuedQtyError, 'issue_state_mismatch');
});

test('跨單位但缺單位重時標記 unknown', () => {
  const result = calculateWorkOrderBomUsage({
    plannedUsage: 600,
    bomUnit: 'pc',
    alreadyPicked: 'Yes',
    issueRows: [issueRow(5, 'kg')],
  });
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyError, 'missing_unit_weight');
});

test('engine 對新 run 使用剩餘需求', () => {
  assert.equal(resolveWorkOrderBomDemand({
    minUsage: 600,
    remainingUsage: 100,
    issuedQtyState: 'known',
  }), 100);
});

test('engine 排除 unknown，不把它誤當全額需求', () => {
  assert.equal(resolveWorkOrderBomDemand({
    minUsage: 600,
    remainingUsage: null,
    issuedQtyState: 'unknown',
  }), 0);
});

test('既有歷史 run 沒有 remainingUsage 時仍沿用 minUsage', () => {
  assert.equal(resolveWorkOrderBomDemand({
    minUsage: 600,
    remainingUsage: null,
    issuedQtyState: 'not_issued',
  }), 600);
});

test('重複使用批號本次領用 951kg 且全數耗用時，不虛構前一張工令的 90kg 退料', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'kg',
    ledgerIssuedQty: 951,
    formUsage: formUsage({
      issuedQty: 1041,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [movement()],
    movementSourceAvailable: true,
  });

  assert.deepEqual(result, {
    grossIssuedQty: 951,
    consumedQty: 951,
    returnedQty: 0,
    netIssuedQty: 951,
    reservedQty: 0,
    remainingUsage: 0,
    overIssuedQty: 701,
    issuedQtyState: 'known',
    movementState: 'known',
    movementDetailCount: 1,
    movementError: null,
  });
});

test('Form 20 耗用 1107kg 後正式退料 1104kg，只剩 3kg 淨領用', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 232.98,
    bomUnit: 'kg',
    ledgerIssuedQty: 1107,
    formUsage: formUsage({
      issuedQty: null,
      remainingUsage: null,
      issuedQtyState: 'unknown',
      issuedQtyError: 'missing_issue_details',
    }),
    movements: [
      movement({ inputQtyKg: 1107, movementQtyKg: -1107 }),
      movement({
        basisType: '入-製令單退料',
        movementType: 'IN入庫',
        inputQtyKg: 1104,
        movementQtyKg: 1104,
      }),
    ],
    movementSourceAvailable: true,
  });

  assert.equal(result.grossIssuedQty, 1107);
  assert.equal(result.consumedQty, 3);
  assert.equal(result.returnedQty, 1104);
  assert.equal(result.netIssuedQty, 3);
  assert.equal(result.reservedQty, 0);
  assert.equal(result.remainingUsage, 229.98);
  assert.equal(result.overIssuedQty, 0);
  assert.equal(result.issuedQtyState, 'known');
  assert.equal(result.movementState, 'known');
});

test('Form 20 權限不足時沿用 Form 28 快照並標示 fallback', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'kg',
    formUsage: formUsage({
      issuedQty: 1041,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [],
    movementSourceAvailable: false,
  });

  assert.equal(result.grossIssuedQty, 1041);
  assert.equal(result.consumedQty, null);
  assert.equal(result.returnedQty, 0);
  assert.equal(result.netIssuedQty, 1041);
  assert.equal(result.reservedQty, null);
  assert.equal(result.remainingUsage, 0);
  assert.equal(result.movementState, 'fallback');
  assert.equal(result.movementError, 'movement_source_unavailable');
});

test('已領到工令但尚未全部耗用的 300kg 留存在工令，不會再形成需求', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 300,
    bomUnit: 'kg',
    ledgerIssuedQty: 500,
    formUsage: formUsage({
      issuedQty: 500,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [
      movement({ inputQtyKg: 200, movementQtyKg: -200 }),
    ],
    movementSourceAvailable: true,
  });

  assert.equal(result.grossIssuedQty, 500);
  assert.equal(result.consumedQty, 200);
  assert.equal(result.returnedQty, 0);
  assert.equal(result.netIssuedQty, 500);
  assert.equal(result.reservedQty, 300);
  assert.equal(result.remainingUsage, 0);
  assert.equal(result.overIssuedQty, 200);
});

test('已領料但尚無耗用出庫時，全數列為工令保留而不是待領需求', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 500,
    bomUnit: 'kg',
    ledgerIssuedQty: 500,
    formUsage: formUsage({
      issuedQty: 500,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [],
    movementSourceAvailable: true,
  });

  assert.equal(result.grossIssuedQty, 500);
  assert.equal(result.consumedQty, 0);
  assert.equal(result.returnedQty, 0);
  assert.equal(result.netIssuedQty, 500);
  assert.equal(result.reservedQty, 500);
  assert.equal(result.remainingUsage, 0);
  assert.equal(result.movementState, 'known');
});

test('找不到對應領料 TRANS 時列為 unknown，不沿用 Form 28 推定值', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'kg',
    ledgerIssuedQty: null,
    formUsage: formUsage({
      issuedQty: 1041,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [],
    movementSourceAvailable: true,
    movementSourceError: 'movement_issue_not_found',
  });

  assert.equal(result.grossIssuedQty, null);
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.movementState, 'unknown');
  assert.equal(result.movementError, 'movement_issue_not_found');
});

test('批號未結清跨工令交接時列為 unknown，不產生已知保留量', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'kg',
    ledgerIssuedQty: null,
    formUsage: formUsage({
      issuedQty: 951,
      remainingUsage: 0,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
    }),
    movements: [],
    movementSourceAvailable: true,
    movementSourceError: 'movement_lot_handoff_incomplete',
  });

  assert.equal(result.grossIssuedQty, null);
  assert.equal(result.reservedQty, null);
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.movementState, 'unknown');
  assert.equal(result.movementError, 'movement_lot_handoff_incomplete');
});

test('耗用出庫大於本次帳本領用量時列為 unknown，不自動放大領用量', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 500,
    bomUnit: 'kg',
    ledgerIssuedQty: 500,
    formUsage: formUsage(),
    movements: [movement({ inputQtyKg: 600, movementQtyKg: -600 })],
    movementSourceAvailable: true,
  });

  assert.equal(result.grossIssuedQty, 500);
  assert.equal(result.netIssuedQty, null);
  assert.equal(result.remainingUsage, null);
  assert.equal(result.movementState, 'unknown');
  assert.equal(result.movementError, 'movement_consumption_exceeds_issue');
});

test('BOM 單位為 pc 但 Form 20 只有 kg 且沒有 pc 數量時列為 unknown', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'pc',
    formUsage: formUsage(),
    movements: [movement()],
    movementSourceAvailable: true,
  });

  assert.equal(result.netIssuedQty, null);
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.movementState, 'unknown');
  assert.equal(result.movementError, 'movement_quantity_missing');
});

test('正式退料量大於耗用出庫量時不產生負淨用量', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 250,
    bomUnit: 'kg',
    formUsage: formUsage(),
    movements: [
      movement({ inputQtyKg: 100, movementQtyKg: -100 }),
      movement({
        basisType: '入-託工單退料',
        movementType: 'IN入庫',
        inputQtyKg: 120,
        movementQtyKg: 120,
      }),
    ],
    movementSourceAvailable: true,
  });

  assert.equal(result.netIssuedQty, null);
  assert.equal(result.remainingUsage, null);
  assert.equal(result.issuedQtyState, 'unknown');
  assert.equal(result.movementState, 'unknown');
  assert.equal(result.movementError, 'movement_return_exceeds_consumption');
});
