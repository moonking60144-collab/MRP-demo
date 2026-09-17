import assert from 'node:assert/strict';
import test from 'node:test';
import { computeOutsourcePriceChanges, type RagicRecord } from './outsource-price-change';

function priceRecord(price: string, effectiveDate: string): RagicRecord {
  return {
    核價種類: '委外',
    ERP料號: 'PART-01HF',
    單價: price,
    生效日期: effectiveDate,
  };
}

test('核價單價含千分位時仍以完整數值計算漲跌幅', () => {
  const result = computeOutsourcePriceChanges(
    [priceRecord('1,000', '2026/06/01'), priceRecord('1,100', '2026/07/01')],
    [],
    2026,
    7,
  );

  assert.equal(result.stats.changed, 1);
  assert.equal(result.changes[0].changePct, '+10.0');
});

test('格式不同但數值相同的核價不列為價格變動', () => {
  const result = computeOutsourcePriceChanges(
    [priceRecord('1,000', '2026/06/01'), priceRecord('1000.00', '2026/07/01')],
    [],
    2026,
    7,
  );

  assert.equal(result.stats.changed, 0);
  assert.equal(result.stats.excludedSame, 1);
});
