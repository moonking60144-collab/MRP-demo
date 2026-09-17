/**
 * Unit tests for computePlanQty — runs via Node's built-in test runner:
 *
 *   npm test
 *
 * Fixtures mirror the patterns we verified live against Ragic on 2026-05-19
 * (see project_ragic_formula_drift_and_fallback.md), with extra edge cases
 * the live sample didn't naturally cover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlanQty } from './compute-plan-qty';
import { PLAN_QTY_EIDS as EID, PLAN_QTY_SUBTABLE_KEYS as SUB } from '../sync/plan-qty-eids';

interface SubRow {
  _ragicId: string;
  _header_Y: unknown;
  [eid: string]: unknown;
}

function woRow(id: string, headerY: unknown, ac11: string | number | null): SubRow {
  return {
    _ragicId: id,
    _header_Y: headerY,
    [EID.AC11_ACCUMULATED_QTY]: ac11 == null ? '' : String(ac11),
  };
}

function splitRow(id: string, planId: string, n17: number): SubRow {
  return {
    _ragicId: id,
    _header_Y: [17],
    [EID.B17_SPLIT_PLAN_ID]: planId,
    [EID.N17_SPLIT_QTY]: String(n17),
  };
}

test('基本 case：無 H4、無拆單、無工令 → 回 E4', () => {
  const rec = {
    [EID.E4_TARGET_QTY]: '40000',
    [EID.H4_QTY_OVERRIDE]: '',
  };
  assert.equal(computePlanQty(rec), 40000);
});

test('H4 修正：H4 set → 用 H4 不用 E4', () => {
  const rec = {
    [EID.E4_TARGET_QTY]: '40000',
    [EID.H4_QTY_OVERRIDE]: '50000',
  };
  assert.equal(computePlanQty(rec), 50000);
});

test('被工令扣到 0：MAX 取 0，不回負', () => {
  // record 4514 case: E4=40000, AC11(last)=40627, no H4, no split → MAX(40000-40627,0)=0
  const rec = {
    [EID.E4_TARGET_QTY]: '40000',
    [EID.H4_QTY_OVERRIDE]: '',
    [SUB.WORK_ORDERS]: {
      '24112': woRow('24112', [11], 41500),
      '24113': woRow('24113', [11], 37625),
      '24116': woRow('24116', [11], 40627),  // LAST by _ragicId asc
    },
  };
  assert.equal(computePlanQty(rec), 0);
});

test('部分扣減：base - LAST(AC11)', () => {
  // record PP202506-0312 case: H4=53000, AC11(last)=4232 → 53000-4232=48768
  const rec = {
    [EID.E4_TARGET_QTY]: '53000',
    [EID.H4_QTY_OVERRIDE]: '53000',
    [SUB.WORK_ORDERS]: {
      '1': woRow('1', [11], 4232),
    },
  };
  assert.equal(computePlanQty(rec), 48768);
});

test('有拆單：base - N17 - LAST(AC11)', () => {
  // record PP202507-0003 case: H4=11000, N17_sum=900, AC11(last)=8620 → 11000-900-8620=1480
  const rec = {
    [EID.E4_TARGET_QTY]: '11000',
    [EID.H4_QTY_OVERRIDE]: '11000',
    [SUB.SPLIT]: {
      '5001': splitRow('5001', 'PP202507-0003-1', 900),
    },
    [SUB.WORK_ORDERS]: {
      '1': woRow('1', [11], 8620),
    },
  };
  assert.equal(computePlanQty(rec), 1480);
});

test('關鍵 _header_Y filter：[31] row 不影響 LAST(AC11)', () => {
  // record 4131 case — bug we found in v1: extra [31] row at the end with null
  // AC11 made our LAST(AC11) read 0 instead of 24900.
  const rec = {
    [EID.E4_TARGET_QTY]: '',
    [EID.H4_QTY_OVERRIDE]: '24900',
    [SUB.WORK_ORDERS]: {
      '21870': woRow('21870', [11], 63878),
      '21871': woRow('21871', [11], 24900),   // last of [11]
      '25893': woRow('25893', [31], null),     // [31] row — must be ignored
    },
  };
  assert.equal(computePlanQty(rec), 0);  // H4 24900 - LAST([11])AC11 24900 = 0
});

test('空 record：所有 EID 缺漏 → 0', () => {
  assert.equal(computePlanQty({}), 0);
});

test('只有空白拆單子表：不算 has_split', () => {
  const rec = {
    [EID.E4_TARGET_QTY]: '100',
    [EID.H4_QTY_OVERRIDE]: '',
    [SUB.SPLIT]: {},  // present but empty
  };
  assert.equal(computePlanQty(rec), 100);
});

test('_header_Y string "[11]" 也算 row 11', () => {
  // Defensive: Ragic occasionally returns header as string instead of number array.
  const rec = {
    [EID.E4_TARGET_QTY]: '100',
    [EID.H4_QTY_OVERRIDE]: '',
    [SUB.WORK_ORDERS]: {
      '1': { _ragicId: '1', _header_Y: '[11]', [EID.AC11_ACCUMULATED_QTY]: '30' },
    },
  };
  assert.equal(computePlanQty(rec), 70);
});

test('多筆 [11] row：取 _ragicId 最大那筆', () => {
  // _ragicId order matters; LAST is Ragic insertion order, not value order.
  const rec = {
    [EID.E4_TARGET_QTY]: '1000',
    [EID.H4_QTY_OVERRIDE]: '',
    [SUB.WORK_ORDERS]: {
      '50': woRow('50', [11], 200),   // later id but smaller AC11
      '49': woRow('49', [11], 800),   // earlier id, larger AC11
    },
  };
  // LAST = id=50 → AC11=200, not max-value 800
  assert.equal(computePlanQty(rec), 800);  // 1000 - 200 = 800
});
