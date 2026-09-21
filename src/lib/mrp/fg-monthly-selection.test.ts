/**
 * computeSelectionStats 單元測試 —— 透過 npm test 跑。
 *
 * 對應業務規則：傳統 view 的框選加總，把選取矩形內的「數字欄」加總、
 * 「文字欄」略過，期推移格一律加總。涵蓋使用者回報的
 * 「框選備庫期數欄（numeric pre-period 欄）卻顯示合計 0」迴歸。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionRangeCss,
  buildSelectionClipboardText,
  computeSelectionStats,
  isCellInSelection,
} from './fg-monthly-selection';

test('寬表框選以每列範圍 selector 呈現，不隨選取格數膨脹', () => {
  const css = buildSelectionRangeCss({
    rects: [{ minR: 0, maxR: 49, minC: 0, maxC: 99 }],
    tableSelector: '.mrp-trad-table',
    firstSelectableChildIndex: 3,
  });

  assert.equal((css.match(/data-selr=/g) || []).length, 50);
  assert.match(css, /data-selr="0".*nth-child\(n\+3\).*nth-child\(-n\+102\)/);
  assert.match(css, /data-selr="49".*nth-child\(n\+3\).*nth-child\(-n\+102\)/);
  assert.doesNotMatch(css, /data-selc="99"/);
});

test('重複框選同一列範圍只輸出一個 selector', () => {
  const rect = { minR: 2, maxR: 2, minC: 4, maxC: 8 };
  const css = buildSelectionRangeCss({
    rects: [rect, rect],
    tableSelector: '.sales-meeting-trad-table',
    firstSelectableChildIndex: 1,
  });

  assert.equal((css.match(/data-selr=/g) || []).length, 1);
  assert.match(css, /nth-child\(n\+5\).*nth-child\(-n\+9\)/);
});

test('水平虛擬化用 canonical data-selc，不以含 colSpan 的 DOM 子格位置判斷選取', () => {
  const css = buildSelectionRangeCss({ rects: [{ minR: 0, maxR: 2, minC: 1, maxC: 40 }],
    tableSelector: '.fg-monthly-trad-table', firstSelectableChildIndex: 4, columnIndices: [0, 1, 2, 39, 40, 41],
  });
  assert.match(css, /data-selr="0"/);
  assert.match(css, /data-selr="2"/);
  for (const column of [1, 2, 39, 40]) assert.match(css, new RegExp(`data-selc="${column}"`));
  for (const column of [0, 3, 41]) assert.doesNotMatch(css, new RegExp(`data-selc="${column}"`));
  assert.doesNotMatch(css, /nth-child/);
  assert.equal(buildSelectionRangeCss({ rects: [{ minR: 0, maxR: 0, minC: 10, maxC: 20 }],
    tableSelector: '.table', firstSelectableChildIndex: 1, columnIndices: [0, 30],
  }), '');
});

test('框選 numeric pre-period 欄（如備庫期數）要加總，不該是 0', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 2, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'stockPeriods', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 3,
    getPrePeriodValue: () => 8,
    getPeriodValue: () => 0,
  });
  assert.equal(stats.sum, 24);
  assert.equal(stats.count, 3);
  assert.equal(stats.avg, 8);
});

test('框選文字欄要略過、不計入加總與格數', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 1, minC: 0, maxC: 1 }],
    prePeriodCols: [
      { key: 'stockPeriods', filterType: 'numeric' },
      { key: 'customerCode', filterType: 'text' },
    ],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 2,
    getPrePeriodValue: (_r, key) => (key === 'stockPeriods' ? 5 : 999),
    getPeriodValue: () => 0,
  });
  assert.equal(stats.sum, 10);
  assert.equal(stats.count, 2);
});

test('框選期推移格一律加總', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 2 }],
    prePeriodCols: [],
    periodGroupKeys: ['demandIntegrated'],
    displayMonths: 12,
    rowCount: 1,
    getPrePeriodValue: () => 0,
    getPeriodValue: (_r, _g, mi) => (mi + 1) * 100,
  });
  assert.equal(stats.sum, 600);
  assert.equal(stats.count, 3);
});

test('前期未結插入時間軸後，框選依實際欄序加總', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 2 }],
    prePeriodCols: [],
    periodGroupKeys: ['plannedOutput'],
    displayMonths: 2,
    timelineCols: [
      { kind: 'item', key: 'priorPlanQty' },
      { kind: 'period', groupKey: 'plannedOutput', monthIndex: 0 },
      { kind: 'period', groupKey: 'plannedOutput', monthIndex: 1 },
    ],
    rowCount: 1,
    getPrePeriodValue: (_r, key) => (key === 'priorPlanQty' ? 300 : 0),
    getPeriodValue: (_r, _g, mi) => (mi + 1) * 100,
  });
  assert.equal(stats.sum, 600);
  assert.equal(stats.count, 3);
});

test('框選矩形跨數字欄 + 文字欄 + 期推移格', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 2 }],
    prePeriodCols: [
      { key: 'stockPeriods', filterType: 'numeric' },
      { key: 'customerCode', filterType: 'text' },
    ],
    periodGroupKeys: ['demandIntegrated'],
    displayMonths: 12,
    rowCount: 1,
    getPrePeriodValue: (_r, key) => (key === 'stockPeriods' ? 8 : 0),
    getPeriodValue: () => 50,
  });
  assert.equal(stats.sum, 58);
  assert.equal(stats.count, 2);
});

test('陳舊選取：超出列數範圍的列略過', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 5, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'stockPeriods', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 2,
    getPrePeriodValue: () => 10,
    getPeriodValue: () => 0,
  });
  assert.equal(stats.count, 2);
  assert.equal(stats.sum, 20);
});

test('多框選：兩個獨立矩形分別加總', () => {
  const stats = computeSelectionStats({
    rects: [
      { minR: 0, maxR: 0, minC: 0, maxC: 0 },
      { minR: 2, maxR: 2, minC: 0, maxC: 0 },
    ],
    prePeriodCols: [{ key: 'stockPeriods', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 3,
    getPrePeriodValue: (r) => (r === 0 ? 10 : r === 2 ? 30 : 0),
    getPeriodValue: () => 0,
  });
  assert.equal(stats.count, 2);
  assert.equal(stats.sum, 40);
});

test('多框選重疊：重疊格只算一次（對齊 Excel）', () => {
  const visitedCells: string[] = [];
  const stats = computeSelectionStats({
    rects: [
      { minR: 0, maxR: 1, minC: 0, maxC: 0 },
      { minR: 1, maxR: 2, minC: 0, maxC: 0 }, // (1,0) 跟前一個重疊
    ],
    prePeriodCols: [{ key: 'stockPeriods', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 3,
    getPrePeriodValue: () => 5,
    getPeriodValue: () => 0,
    onVisitCell: (row, column) => visitedCells.push(`${row}:${column}`),
  });
  // (0,0) (1,0) (2,0) 各 5 → 15，重疊的 (1,0) 不重算
  assert.equal(stats.count, 3);
  assert.equal(stats.sum, 15);
  assert.deepEqual(visitedCells, ['0:0', '1:0', '2:0']);
});

test('多框選空陣列：count/sum/avg 皆 0', () => {
  const stats = computeSelectionStats({
    rects: [],
    prePeriodCols: [{ key: 'stockPeriods', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 3,
    getPrePeriodValue: () => 100,
    getPeriodValue: () => 0,
  });
  assert.equal(stats.count, 0);
  assert.equal(stats.sum, 0);
  assert.equal(stats.avg, 0);
});

test('沒框任何格時 avg 為 0、不除以零', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'customerCode', filterType: 'text' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 1,
    getPrePeriodValue: () => 0,
    getPeriodValue: () => 0,
  });
  assert.equal(stats.count, 0);
  assert.equal(stats.sum, 0);
  assert.equal(stats.avg, 0);
});

test('沒有倉別快照的空值不應被框選統計誤算成零庫存', () => {
  const stats = computeSelectionStats({
    rects: [{ minR: 0, maxR: 1, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'mainStockPc', filterType: 'numeric' }],
    periodGroupKeys: [],
    displayMonths: 12,
    rowCount: 2,
    getPrePeriodValue: (row) => row === 0 ? null : 0,
    getPeriodValue: () => 0,
  });

  assert.equal(stats.count, 1);
  assert.equal(stats.sum, 0);
});

test('框選複製依畫面列欄輸出 TSV，保留文字、數字與空值', () => {
  const text = buildSelectionClipboardText({
    rects: [{ minR: 0, maxR: 1, minC: 0, maxC: 2 }],
    prePeriodCols: [
      { key: 'partVersion', filterType: 'text' },
      { key: 'stockPeriods', filterType: 'numeric' },
    ],
    periodGroupKeys: ['plannedOutput'],
    displayMonths: 1,
    rowCount: 2,
    getPrePeriodValue: (row, key) => (
      key === 'partVersion' ? `PV-${row + 1}` : row === 0 ? 8 : 0
    ),
    getPeriodValue: (row) => row === 0 ? 1200 : null,
  });

  assert.equal(text, 'PV-1\t8\t1200\nPV-2\t0\t');
});

test('不連續多框選複製保留相對位置，未選格輸出空白', () => {
  const rects = [
    { minR: 0, maxR: 0, minC: 0, maxC: 0 },
    { minR: 1, maxR: 1, minC: 1, maxC: 1 },
  ];
  const text = buildSelectionClipboardText({
    rects,
    prePeriodCols: [
      { key: 'left', filterType: 'text' },
      { key: 'right', filterType: 'text' },
    ],
    periodGroupKeys: [],
    displayMonths: 0,
    rowCount: 2,
    getPrePeriodValue: (row, key) => `${key}-${row}`,
    getPeriodValue: () => null,
  });

  assert.equal(text, 'left-0\t\n\tright-1');
  assert.equal(isCellInSelection(rects, 0, 0), true);
  assert.equal(isCellInSelection(rects, 0, 1), false);
});

test('框選複製會清掉值內的 tab 與換行，避免破壞 TSV 結構', () => {
  const text = buildSelectionClipboardText({
    rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 0 }],
    prePeriodCols: [{ key: 'partVersion', filterType: 'text' }],
    periodGroupKeys: [],
    displayMonths: 0,
    rowCount: 1,
    getPrePeriodValue: () => 'A\tB\nC',
    getPeriodValue: () => null,
  });

  assert.equal(text, 'A B C');
});
