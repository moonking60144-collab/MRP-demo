import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateSharedErpPool,
  suggestSharedErpPoolSupply,
  type SharedPoolMember,
} from './shared-erp-pool';

function member(
  key: string,
  customerCode: string,
  partVersion: string,
  demands: number[],
  dates: Array<string | null> = [],
  priorDemand = 0,
): SharedPoolMember {
  return {
    key,
    customerCode,
    partVersion,
    priorDemand: { quantity: priorDemand, priorityAt: null },
    periodDemands: demands.map((quantity, index) => ({
      quantity,
      priorityAt: dates[index] ? new Date(dates[index]!) : null,
    })),
  };
}

test('同 ERP 的後一客料版本接續使用前一版本扣用後的庫存', () => {
  const result = allocateSharedErpPool({
    initialStock: 600,
    periodSupply: [0],
    members: [
      member('A', 'A', 'A-V01', [100]),
      member('B', 'B', 'B-V01', [600]),
    ],
  });

  assert.equal(result.members.get('A')?.remainingStock[0], 500);
  assert.equal(result.members.get('B')?.remainingStock[0], -100);
  assert.equal(result.endingStock, -100);
  assert.equal(result.demandEvents.reduce((sum, event) => sum + event.quantity, 0), 700);
});

test('同一期先依需求日期，再依客戶代碼與客料版本排序', () => {
  const result = allocateSharedErpPool({
    initialStock: 100,
    periodSupply: [0],
    members: [
      member('C', 'C', 'C-V01', [30], ['2026-07-03']),
      member('B', 'B', 'B-V02', [30], ['2026-07-02']),
      member('A2', 'A', 'A-V02', [30], ['2026-07-02']),
      member('A1', 'A', 'A-V01', [30], ['2026-07-02']),
    ],
  });

  assert.deepEqual(result.demandEvents.map((event) => event.memberKey), ['A1', 'A2', 'B', 'C']);
  assert.deepEqual(result.demandEvents.map((event) => event.remainingStock), [70, 40, 10, -20]);
});

test('共享生產計畫每期只加入一次，無計畫餘額不加入供給', () => {
  const result = allocateSharedErpPool({
    initialStock: 100,
    priorSupply: 20,
    periodSupply: [200, 50],
    members: [
      member('A', 'A', 'A-V01', [150, 50], [], 50),
      member('B', 'B', 'B-V01', [100, 100]),
    ],
  });

  assert.equal(result.endingStock, -80);
  assert.equal(result.endingNoPlan, -350);
  assert.equal(result.members.get('A')?.remainingStock[0], 120);
  assert.equal(result.members.get('B')?.remainingStock[0], 20);
  assert.equal(result.members.get('B')?.remainingNoPlan[0], -200);
});

test('沒有需求的版本顯示該期期末共享餘額但不取得缺料期', () => {
  const result = allocateSharedErpPool({
    initialStock: 50,
    periodSupply: [0],
    members: [
      member('idle', 'A', 'A-V01', [0]),
      member('demand', 'B', 'B-V01', [80]),
    ],
  });

  assert.equal(result.members.get('idle')?.remainingStock[0], -30);
  assert.equal(result.members.get('idle')?.shortageStartPeriod, null);
  assert.equal(result.members.get('demand')?.shortageStartPeriod, 0);
});

test('輸入順序打亂不影響結果', () => {
  const members = [
    member('B', 'B', 'B-V01', [60]),
    member('A', 'A', 'A-V01', [60]),
  ];
  const first = allocateSharedErpPool({ initialStock: 100, periodSupply: [0], members });
  const second = allocateSharedErpPool({ initialStock: 100, periodSupply: [0], members: [...members].reverse() });

  assert.deepEqual(
    first.demandEvents.map(({ memberKey, remainingStock }) => ({ memberKey, remainingStock })),
    second.demandEvents.map(({ memberKey, remainingStock }) => ({ memberKey, remainingStock })),
  );
});

test('共享池只替實際觸發缺口的版本產生一次建議', () => {
  const members = [
    { ...member('A', 'A', 'A-V01', [100, 0]), targetPeriods: 2 },
    { ...member('B', 'B', 'B-V01', [600, 0]), targetPeriods: 2 },
  ];
  const suggestions = suggestSharedErpPoolSupply({
    initialStock: 600,
    periodSupply: [0, 0],
    members,
    bufferPct: 0.1,
  });

  assert.deepEqual(suggestions, [{
    memberKey: 'B',
    sequence: 1,
    targetStartPeriod: 0,
    fulfillToPeriod: 1.5,
    suggestedQty: 170,
  }]);
});

test('既有共享生產計畫已補足時不再產生建議', () => {
  const suggestions = suggestSharedErpPoolSupply({
    initialStock: 100,
    periodSupply: [500],
    members: [
      { ...member('A', 'A', 'A-V01', [300]), targetPeriods: 2 },
      { ...member('B', 'B', 'B-V01', [200]), targetPeriods: 2 },
    ],
    bufferPct: 0.1,
  });

  assert.deepEqual(suggestions, []);
});
