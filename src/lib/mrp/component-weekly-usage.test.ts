import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentWeeklyUsageWhere,
  isComponentWeeklyDateInScope,
  matchesComponentWeeklyUsageType,
  parseComponentWeeklyUsageWeekIndex,
  resolveComponentWeeklyMovementSummaryState,
  resolveComponentWeeklySettlementState,
  summarizeComponentWeeklyUsage,
  type ComponentWeeklyUsageBomRow,
} from './component-weekly-usage';
import type { MrpWeek } from './period-utils';

const weeks: MrpWeek[] = [
  {
    index: 0,
    label: 'W01 07/13',
    start: new Date('2026-07-13T00:00:00.000Z'),
    end: new Date('2026-07-19T23:59:59.999Z'),
  },
  {
    index: 1,
    label: 'W02 07/20',
    start: new Date('2026-07-20T00:00:00.000Z'),
    end: new Date('2026-07-26T23:59:59.999Z'),
  },
];

function bomRow(overrides: Partial<ComponentWeeklyUsageBomRow> = {}): ComponentWeeklyUsageBomRow {
  return {
    sourceRecordId: '1',
    componentNo: 'WIRE-01',
    woNumber: 'WO-001',
    sourceType: '內製',
    processCode: '抽線',
    unit: 'kg',
    minUsage: 600,
    alreadyPicked: 'Yes',
    issuedQty: 100,
    remainingUsage: 500,
    issuedQtyState: 'known',
    issuedDetailCount: 1,
    issuedQtyError: null,
    startDate: new Date('2026-07-14T00:00:00.000Z'),
    ...overrides,
  };
}

test('工令用料明細 API 只接受 all 或非負整數週別', () => {
  assert.equal(parseComponentWeeklyUsageWeekIndex('all'), null);
  assert.equal(parseComponentWeeklyUsageWeekIndex('0'), 0);
  assert.equal(parseComponentWeeklyUsageWeekIndex(' 12 '), 12);
  assert.equal(parseComponentWeeklyUsageWeekIndex(null), undefined);
  assert.equal(parseComponentWeeklyUsageWeekIndex(''), undefined);
  assert.equal(parseComponentWeeklyUsageWeekIndex('  '), undefined);
  assert.equal(parseComponentWeeklyUsageWeekIndex('-1'), undefined);
  assert.equal(parseComponentWeeklyUsageWeekIndex('1.5'), undefined);
  assert.equal(parseComponentWeeklyUsageWeekIndex('W01'), undefined);
});

test('明細 movement 狀態能區分 movement snapshot、BOM snapshot 混合來源', () => {
  assert.equal(resolveComponentWeeklyMovementSummaryState([]), 'fallback');
  assert.equal(resolveComponentWeeklyMovementSummaryState(['fallback']), 'fallback');
  assert.equal(resolveComponentWeeklyMovementSummaryState(['known']), 'known');
  assert.equal(resolveComponentWeeklyMovementSummaryState(['known', 'fallback']), 'mixed');
  assert.equal(resolveComponentWeeklyMovementSummaryState(['known', 'unknown']), 'unknown');
});

test('未結案工令的 movement snapshot OUT 保持帳面出庫待結算，不宣稱為已確認實耗', () => {
  assert.equal(resolveComponentWeeklySettlementState({
    status: 'over_issued',
    movementState: 'known',
    workOrderStatus: '未結案',
    consumedQty: 951,
    returnedQty: 0,
    netIssuedQty: 951,
    reservedQty: 0,
  }), 'pending');
  assert.equal(resolveComponentWeeklySettlementState({
    status: 'not_issued',
    movementState: 'known',
    workOrderStatus: '未結案',
    consumedQty: 0,
    returnedQty: 600,
    netIssuedQty: 0,
    reservedQty: 0,
  }), 'returned');
  assert.equal(resolveComponentWeeklySettlementState({
    status: 'fully_issued',
    movementState: 'known',
    workOrderStatus: '未結案',
    consumedQty: 0,
    returnedQty: 600,
    netIssuedQty: 0,
    reservedQty: 0,
  }), 'returned');
  assert.equal(resolveComponentWeeklySettlementState({
    status: 'partial',
    movementState: 'known',
    workOrderStatus: '未結案',
    consumedQty: 0,
    returnedQty: 0,
    netIssuedQty: 454,
    reservedQty: 454,
  }), 'reserved');
  assert.equal(resolveComponentWeeklySettlementState({
    status: 'fully_issued',
    movementState: 'fallback',
    workOrderStatus: '未結案',
    consumedQty: null,
    returnedQty: 0,
    netIssuedQty: 600,
    reservedQty: null,
  }), 'pending');
});

test('相同 movement snapshot OUT 依工令狀態區分未結案待結算與已結案已結算', () => {
  const quantities = {
    status: 'over_issued' as const,
    movementState: 'known',
    consumedQty: 951,
    returnedQty: 0,
    netIssuedQty: 951,
    reservedQty: 0,
  };

  assert.equal(resolveComponentWeeklySettlementState({
    ...quantities,
    workOrderStatus: '未結案',
  }), 'pending');
  assert.equal(resolveComponentWeeklySettlementState({
    ...quantities,
    workOrderStatus: '已結案',
  }), 'settled');
});

test('供給明細依目前週別或全部推移期間篩選', () => {
  const prior = new Date('2026-07-10T00:00:00.000Z');
  const weekOne = new Date('2026-07-14T00:00:00.000Z');
  const future = new Date('2026-08-10T00:00:00.000Z');

  assert.equal(isComponentWeeklyDateInScope(prior, weeks, 0), true);
  assert.equal(isComponentWeeklyDateInScope(weekOne, weeks, 1), true);
  assert.equal(isComponentWeeklyDateInScope(weekOne, weeks, 2), false);
  assert.equal(isComponentWeeklyDateInScope(weekOne, weeks, null), true);
  assert.equal(isComponentWeeklyDateInScope(future, weeks, null), false);
});

test('工令用料明細只加總同料號同週且剩餘量大於零的工令', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 1100,
    bomRows: [
      bomRow(),
      bomRow({ sourceRecordId: '2', woNumber: 'WO-002', alreadyPicked: 'No', issuedQty: 0, remainingUsage: 600, issuedQtyState: 'not_issued' }),
      bomRow({ sourceRecordId: '3', woNumber: 'WO-003', issuedQty: 600, remainingUsage: 0 }),
      bomRow({ sourceRecordId: '4', woNumber: 'WO-004', issuedQty: null, remainingUsage: null, issuedQtyState: 'unknown', issuedQtyError: 'missing_issue_details' }),
      bomRow({ sourceRecordId: '5', woNumber: 'WO-005', startDate: new Date('2026-07-22T00:00:00.000Z') }),
      bomRow({ sourceRecordId: '6', componentNo: 'WIRE-02' }),
    ],
    workOrders: [
      { sourceRecordId: 'wo-1', woNumber: 'WO-001', erpPartNo: 'FG-01-V01', status: '未結案' },
      { sourceRecordId: 'wo-2', woNumber: 'WO-002', erpPartNo: 'FG-02-V01', status: '未結案' },
    ],
  });

  assert.equal(result.included.length, 2);
  assert.equal(result.excluded.length, 2);
  assert.equal(result.includedTotal, 1100);
  assert.equal(result.difference, 0);
  assert.equal(result.reconciled, true);
  assert.equal(result.included[0]?.finishedErpPartNo, 'FG-01-V01');
  assert.equal(result.included[0]?.workOrderSourceRecordId, 'wo-1');
  assert.equal(result.included.find((row) => row.woNumber === 'WO-001')?.status, 'partial');
  assert.equal(result.included.find((row) => row.woNumber === 'WO-002')?.status, 'not_issued');
  assert.equal(result.excluded.find((row) => row.woNumber === 'WO-003')?.status, 'fully_issued');
  assert.equal(result.excluded.find((row) => row.woNumber === 'WO-004')?.reason, 'missing_issue_details');
});

test('工令用料明細與週推移共用 schedule snapshot 指定開始日，並揭露 BOM snapshot 日期差異', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 2,
    weeks,
    expectedUsage: 500,
    bomRows: [bomRow({
      woNumber: 'WO-001',
      startDate: new Date('2026-07-14T00:00:00.000Z'),
    })],
    workOrders: [{
      sourceRecordId: 'wo-1',
      woNumber: 'WO-001',
      erpPartNo: 'FG-01-V01',
      status: '未結案',
      startDate: new Date('2026-07-21T00:00:00.000Z'),
    }],
  });

  assert.equal(result.included.length, 1);
  assert.equal(result.included[0]?.startDate, '2026-07-21');
  assert.equal(result.included[0]?.scheduleStartDate, '2026-07-21');
  assert.equal(result.included[0]?.bomStartDate, '2026-07-14');
  assert.equal(result.included[0]?.dateSource, 'work_order');
  assert.equal(result.included[0]?.dateMismatch, true);
});

test('已知用量的主子表領料異常保留在來源明細，不阻擋需求計算', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 500,
    bomRows: [bomRow({ issuedQtyError: 'issue_state_mismatch' })],
    workOrders: [],
  });

  assert.equal(result.included.length, 1);
  assert.equal(result.included[0]?.remainingUsage, 500);
  assert.equal(result.included[0]?.sourceAnomaly, 'issue_state_mismatch');
  assert.equal(result.reconciled, true);
});

test('歷史資料 remainingUsage 空白時沿用 engine 的 minUsage fallback', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 0,
    weeks,
    expectedUsage: 250,
    bomRows: [bomRow({ startDate: null, minUsage: 250, remainingUsage: null, issuedQtyState: 'known' })],
    workOrders: [],
  });

  assert.equal(result.includedTotal, 250);
  assert.equal(result.reconciled, true);
});

test('明細合計與週推移格值不同時明確回傳差異', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 499,
    bomRows: [bomRow()],
    workOrders: [],
  });

  assert.equal(result.includedTotal, 500);
  assert.equal(result.difference, 1);
  assert.equal(result.reconciled, false);
});

test('W 工令明細排除與 canonical unit 不同的 BOM，並明確回傳單位異常', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 500,
    expectedUnit: 'kg',
    enforceUnitConsistency: true,
    bomRows: [
      bomRow({ sourceRecordId: 'kg-row', unit: 'kg', remainingUsage: 500 }),
      bomRow({ sourceRecordId: 'pc-row', woNumber: 'WO-PC', unit: 'pc', remainingUsage: 537 }),
    ],
    workOrders: [],
  });

  assert.equal(result.included.length, 1);
  assert.equal(result.included[0]?.sourceRecordId, 'kg-row');
  assert.equal(result.includedTotal, 500);
  assert.equal(result.unitMismatchCount, 1);
  assert.equal(result.excluded.find((row) => row.sourceRecordId === 'pc-row')?.status, 'unknown');
  assert.equal(result.excluded.find((row) => row.sourceRecordId === 'pc-row')?.reason, 'unit_mismatch');
  assert.equal(result.reconciled, true);
});

test('全部週期明細保留已領足與超領工令，但不納入週需求合計', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: null,
    weeks,
    expectedUsage: 0,
    bomRows: [
      bomRow({
        minUsage: 250,
        issuedQty: 1041,
        remainingUsage: 0,
      }),
      bomRow({
        sourceRecordId: '2',
        woNumber: 'WO-002',
        startDate: new Date('2026-07-22T00:00:00.000Z'),
        minUsage: 600,
        issuedQty: 600,
        remainingUsage: 0,
      }),
      bomRow({
        sourceRecordId: '3',
        woNumber: 'WO-FUTURE',
        startDate: new Date('2026-08-03T00:00:00.000Z'),
        minUsage: 100,
        issuedQty: 100,
        remainingUsage: 0,
      }),
    ],
    workOrders: [],
  });

  assert.equal(result.included.length, 0);
  assert.equal(result.excluded.length, 2);
  assert.equal(result.includedTotal, 0);
  assert.equal(result.reconciled, true);
  assert.equal(result.excluded.find((row) => row.woNumber === 'WO-001')?.status, 'over_issued');
  assert.equal(result.excluded.find((row) => row.woNumber === 'WO-001')?.overIssuedQty, 791);
  assert.equal(result.excluded.find((row) => row.woNumber === 'WO-002')?.status, 'fully_issued');
  assert.equal(result.excluded.some((row) => row.woNumber === 'WO-FUTURE'), false);
});

test('重複使用批號的 movement snapshot 快照不虛構退料，未結案 OUT 標示為待結算帳面出庫', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 0,
    bomRows: [
      bomRow({
        minUsage: 250,
        issuedQty: 1041,
        grossIssuedQty: 951,
        consumedQty: 951,
        returnedQty: 0,
        netIssuedQty: 951,
        reservedQty: 0,
        remainingUsage: 0,
        overIssuedQty: 701,
        movementState: 'known',
        movementDetailCount: 1,
      }),
    ],
    workOrders: [
      { sourceRecordId: 'wo-1', woNumber: 'WO-001', erpPartNo: 'FG-01-V01', status: '未結案' },
    ],
  });

  assert.equal(result.included.length, 0);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]?.grossIssuedQty, 951);
  assert.equal(result.excluded[0]?.consumedQty, 951);
  assert.equal(result.excluded[0]?.returnedQty, 0);
  assert.equal(result.excluded[0]?.netIssuedQty, 951);
  assert.equal(result.excluded[0]?.reservedQty, 0);
  assert.equal(result.excluded[0]?.overIssuedQty, 701);
  assert.equal(result.excluded[0]?.settlementState, 'pending');
  assert.equal(result.excluded[0]?.status, 'over_issued');
  assert.equal(result.reconciled, true);
});

test('正式退料降低淨領用後重新形成剩餘需求', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 230,
    bomRows: [
      bomRow({
        minUsage: 233,
        issuedQty: 1107,
        grossIssuedQty: 1107,
        consumedQty: 3,
        returnedQty: 1104,
        netIssuedQty: 3,
        reservedQty: 0,
        remainingUsage: 230,
        overIssuedQty: 0,
        movementState: 'known',
        movementDetailCount: 2,
      }),
    ],
    workOrders: [],
  });

  assert.equal(result.included.length, 1);
  assert.equal(result.included[0]?.status, 'partial');
  assert.equal(result.included[0]?.consumedQty, 3);
  assert.equal(result.included[0]?.reservedQty, 0);
  assert.equal(result.included[0]?.remainingUsage, 230);
  assert.equal(result.included[0]?.movementDetailCount, 2);
  assert.equal(result.reconciled, true);
});

test('耗用與退料無法唯一歸屬時保留工令但排除需求', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 0,
    bomRows: [
      bomRow({
        grossIssuedQty: 100,
        consumedQty: null,
        returnedQty: null,
        netIssuedQty: null,
        reservedQty: null,
        remainingUsage: null,
        issuedQtyState: 'unknown',
        movementState: 'unknown',
        movementDetailCount: 3,
        movementError: 'movement_bom_mapping_ambiguous',
      }),
    ],
    workOrders: [],
  });

  assert.equal(result.included.length, 0);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]?.status, 'unknown');
  assert.equal(result.excluded[0]?.grossIssuedQty, 100);
  assert.equal(result.excluded[0]?.returnedQty, null);
  assert.equal(result.excluded[0]?.netIssuedQty, null);
  assert.equal(result.excluded[0]?.remainingUsage, null);
  assert.equal(result.excluded[0]?.reason, 'movement_bom_mapping_ambiguous');
  assert.equal(result.excluded[0]?.movementDetailCount, 3);
  assert.equal(result.reconciled, true);
});

test('movement snapshot 未確認時不以 BOM snapshot 舊領用量偽造淨領用與正式退料', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 0,
    bomRows: [
      bomRow({
        minUsage: 2220,
        issuedQty: 4493,
        grossIssuedQty: 2226,
        consumedQty: null,
        returnedQty: null,
        netIssuedQty: null,
        reservedQty: null,
        remainingUsage: null,
        issuedQtyState: 'unknown',
        movementState: 'unknown',
        movementDetailCount: 6,
        movementError: 'movement_consumption_exceeds_issue',
      }),
    ],
    workOrders: [],
  });

  assert.equal(result.excluded[0]?.grossIssuedQty, 2226);
  assert.equal(result.excluded[0]?.returnedQty, null);
  assert.equal(result.excluded[0]?.netIssuedQty, null);
  assert.equal(result.excluded[0]?.remainingUsage, null);
  assert.equal(result.excluded[0]?.reason, 'movement_consumption_exceeds_issue');
});

test('工令已領未耗用量保留在工令，不會重複列入需求', () => {
  const result = summarizeComponentWeeklyUsage({
    materialPartNo: 'WIRE-01',
    weekIndex: 1,
    weeks,
    expectedUsage: 0,
    bomRows: [
      bomRow({
        minUsage: 300,
        grossIssuedQty: 500,
        consumedQty: 200,
        returnedQty: 0,
        netIssuedQty: 500,
        reservedQty: 300,
        remainingUsage: 0,
        overIssuedQty: 200,
        movementState: 'known',
        movementDetailCount: 1,
      }),
    ],
    workOrders: [],
  });

  assert.equal(result.included.length, 0);
  assert.equal(result.excluded[0]?.consumedQty, 200);
  assert.equal(result.excluded[0]?.reservedQty, 300);
  assert.equal(result.excluded[0]?.remainingUsage, 0);
  assert.equal(result.excluded[0]?.status, 'over_issued');
});

test('B 與 D 週推移共用相同的工令 BOM 篩選規則', () => {
  assert.deepEqual(componentWeeklyUsageWhere('W'), {});
  assert.deepEqual(componentWeeklyUsageWhere('B'), { sourceType: { in: ['採購', '外購'] } });
  assert.deepEqual(componentWeeklyUsageWhere('D'), { sourceType: '內製', processCode: '組合' });
});

test('共用計算快照與 Prisma where 使用相同的元件類型規則', () => {
  assert.equal(matchesComponentWeeklyUsageType(bomRow({ sourceType: '外購' }), 'B'), true);
  assert.equal(matchesComponentWeeklyUsageType(bomRow({ sourceType: '採購' }), 'B'), true);
  assert.equal(matchesComponentWeeklyUsageType(bomRow({ sourceType: '內製' }), 'B'), false);
  assert.equal(matchesComponentWeeklyUsageType(bomRow({ sourceType: '內製', processCode: '組合' }), 'D'), true);
  assert.equal(matchesComponentWeeklyUsageType(bomRow({ sourceType: '內製', processCode: '抽線' }), 'D'), false);
  assert.equal(matchesComponentWeeklyUsageType(bomRow(), 'W'), true);
});
