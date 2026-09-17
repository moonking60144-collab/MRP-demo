import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFulfillToPeriod, parsePositivePlanQty } from './fg-plan-input';

test('滿足期保留 0.5 期，不截斷成整數', () => {
  assert.equal(parseFulfillToPeriod(1.5), 1.5);
  assert.equal(parseFulfillToPeriod('3.5'), 3.5);
});

test('滿足期只接受 0.5 的倍數與畫面支援範圍', () => {
  assert.equal(parseFulfillToPeriod(1.2), null);
  assert.equal(parseFulfillToPeriod(-0.5), null);
  assert.equal(parseFulfillToPeriod(12.5), null);
  assert.equal(parseFulfillToPeriod(''), null);
});

test('生產計畫量只接受大於零的有限數字', () => {
  assert.equal(parsePositivePlanQty(100), 100);
  assert.equal(parsePositivePlanQty('25.5'), 25.5);
  assert.equal(parsePositivePlanQty(0), null);
  assert.equal(parsePositivePlanQty(-1), null);
  assert.equal(parsePositivePlanQty(Number.POSITIVE_INFINITY), null);
  assert.equal(parsePositivePlanQty('not-a-number'), null);
});
