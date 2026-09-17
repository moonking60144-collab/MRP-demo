import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSelectionStats } from './fg-monthly-selection';

test('元件週推框選依畫面順序跨庫存、狀態與週期欄加總', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 4 }],
    prePeriodCols: [
      { key: 'materialPartNo', filterType: 'text' },
      { key: 'goodStockPc', filterType: 'numeric' },
      { key: 'shortageStartWeek', filterType: 'numeric' },
    ],
    periodGroupKeys: ['remainingStock'],
    displayMonths: 2,
    timelineCols: [
      { kind: 'period', groupKey: 'remainingStock', monthIndex: 0 },
      { kind: 'period', groupKey: 'remainingStock', monthIndex: 1 },
    ],
    rowCount: 1,
    getPrePeriodValue: (_row, key) => key === 'goodStockPc' ? 100 : key === 'shortageStartWeek' ? 3 : 0,
    getPeriodValue: (_row, _group, week) => week === 0 ? null : 75,
  });

  assert.equal(stats.count, 3);
  assert.equal(stats.sum, 178);
  assert.equal(stats.avg, 178 / 3);
});

test('元件週推框選不計空白與狀態文字但保留真實零值', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 3 }],
    prePeriodCols: [
      { key: 'goodStockPc', filterType: 'numeric' },
      { key: 'shortageStartWeek', filterType: 'numeric' },
      { key: 'weeksUntilOrder', filterType: 'numeric' },
    ],
    periodGroupKeys: ['remainingStock'],
    displayMonths: 1,
    timelineCols: [{ kind: 'period', groupKey: 'remainingStock', monthIndex: 0 }],
    rowCount: 1,
    getPrePeriodValue: (_row, key) => key === 'goodStockPc' ? 0 : null,
    getPeriodValue: () => null,
  });

  assert.deepEqual(stats, { sum: 0, count: 1, avg: 0 });
});

test('元件週推框選會計算 Prisma Decimal JSON 數值字串', () => {
  const rows = [
    { goodStockKg: '79', avgWeeklyUsage: '11' },
    { goodStockKg: '52.5', avgWeeklyUsage: '6.8' },
    { goodStockKg: '0', avgWeeklyUsage: '' },
  ];
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 2, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'goodStockKg', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 0,
    rowCount: rows.length,
    getPrePeriodValue: (row, key) => rows[row][key as keyof typeof rows[number]],
    getPeriodValue: () => null,
  });

  assert.deepEqual(stats, { sum: 131.5, count: 3, avg: 131.5 / 3 });
});
