/**
 * 框選加總（box-select aggregation）的純計算 —— 抽出來讓它可單元測試。
 *
 * 框選矩形涵蓋的格子分兩段：
 *  - pre-period 欄（c < prePeriodLen）：只加總 filterType === 'numeric' 的欄；
 *    文字 / 布林欄略過（同 Excel —— 框到文字欄不計入）。「備庫期數」「排序」
 *    這類雖然加總語意不強、但仍是數字欄，使用者框了就算（Excel 行為）。
 *  - 期推移格（c >= prePeriodLen）：一律加總。
 * count = 實際計入的格數；avg = sum / count。
 *
 * 多框選（Ctrl/Cmd+drag append）：rects 可帶多個矩形，重疊格子只算一次
 * （對齊 Excel —— 兩個 selection 重疊區塊不重複計入合計）。
 */

export interface BoxSelRect {
  minR: number;
  maxR: number;
  minC: number;
  maxC: number;
}

/** 框選計算需要知道的最小欄位資訊。 */
export interface BoxSelColumn {
  key: string;
  filterType: string;
}

export type BoxSelTimelineColumn =
  | { kind: 'item'; key: string }
  | { kind: 'period'; groupKey: string; monthIndex: number };

export interface SelectionStatsArgs {
  rects: BoxSelRect[];
  /** pre-period 欄（依顯示順序）；長度即 prePeriodLen */
  prePeriodCols: BoxSelColumn[];
  /** 期推移群組 key（依顯示順序，例如 plannedOutput / demandIntegrated …） */
  periodGroupKeys: string[];
  displayMonths: number;
  /** 有前期欄插入時間軸時，提供畫面上的實際欄序；未提供則沿用固定群組×月份推算。 */
  timelineCols?: BoxSelTimelineColumn[];
  /** 列數上限；r 超出 [0, rowCount) 的列略過（防呆陳舊選取） */
  rowCount: number;
  /** 取某列某 pre-period 欄的原始值；Decimal JSON 字串會在此計算邊界正規化。 */
  getPrePeriodValue: (r: number, colKey: string) => unknown;
  /** 取某列某期推移格的數值 */
  getPeriodValue: (r: number, groupKey: string, monthIndex: number) => unknown;
  /** 在已去重且可計算的格子上執行附加判斷，避免 caller 再掃一次相同選區。 */
  onVisitCell?: (r: number, c: number) => void;
}

export interface SelectionStats {
  sum: number;
  count: number;
  avg: number;
}

export function buildSelectionRangeCss(args: {
  rects: BoxSelRect[];
  tableSelector: string;
  firstSelectableChildIndex: number;
  columnIndices?: number[];
}): string {
  if (args.rects.length === 0) return '';

  const selectors = new Set<string>();
  for (const rect of args.rects) {
    if (args.columnIndices) {
      const columns = args.columnIndices.filter(column => column >= rect.minC && column <= rect.maxC);
      if (columns.length === 0) continue;
      const rows = Array.from({ length: rect.maxR - rect.minR + 1 }, (_, index) => `[data-selr="${rect.minR + index}"]`);
      selectors.add(`${args.tableSelector} td:is(${rows.join(',')}):is(${columns.map(column => `[data-selc="${column}"]`).join(',')})`);
      continue;
    }
    const firstChild = args.firstSelectableChildIndex + rect.minC;
    const lastChild = args.firstSelectableChildIndex + rect.maxC;
    for (let row = rect.minR; row <= rect.maxR; row++) {
      selectors.add(
        `${args.tableSelector} td[data-selr="${row}"][data-selc]`
        + `:nth-child(n+${firstChild}):nth-child(-n+${lastChild})`,
      );
    }
  }

  return selectors.size > 0 ? `${[...selectors].join(',')}{background-color:#bfdbfe !important}` : '';
}

export function isCellInSelection(
  rects: BoxSelRect[],
  row: number,
  column: number,
): boolean {
  return rects.some((rect) => (
    row >= rect.minR
    && row <= rect.maxR
    && column >= rect.minC
    && column <= rect.maxC
  ));
}

function selectionCellValue(
  args: SelectionStatsArgs,
  row: number,
  column: number,
): unknown {
  const prePeriodLen = args.prePeriodCols.length;
  if (column < prePeriodLen) {
    const col = args.prePeriodCols[column];
    return col ? args.getPrePeriodValue(row, col.key) : null;
  }

  if (args.timelineCols) {
    const timelineCol = args.timelineCols[column - prePeriodLen];
    if (!timelineCol) return null;
    return timelineCol.kind === 'item'
      ? args.getPrePeriodValue(row, timelineCol.key)
      : args.getPeriodValue(row, timelineCol.groupKey, timelineCol.monthIndex);
  }

  if (args.displayMonths <= 0) return null;
  const timelineColumn = column - prePeriodLen;
  const groupIndex = Math.floor(timelineColumn / args.displayMonths);
  const groupKey = args.periodGroupKeys[groupIndex];
  if (!groupKey) return null;
  return args.getPeriodValue(
    row,
    groupKey,
    timelineColumn % args.displayMonths,
  );
}

function clipboardValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

export function buildSelectionClipboardText(args: SelectionStatsArgs): string {
  if (args.rects.length === 0 || args.rowCount <= 0) return '';

  const columnCount = args.prePeriodCols.length + (
    args.timelineCols?.length
    ?? args.periodGroupKeys.length * Math.max(0, args.displayMonths)
  );
  if (columnCount <= 0) return '';

  const minRow = Math.max(0, Math.min(...args.rects.map((rect) => rect.minR)));
  const maxRow = Math.min(
    args.rowCount - 1,
    Math.max(...args.rects.map((rect) => rect.maxR)),
  );
  const minColumn = Math.max(0, Math.min(...args.rects.map((rect) => rect.minC)));
  const maxColumn = Math.min(
    columnCount - 1,
    Math.max(...args.rects.map((rect) => rect.maxC)),
  );
  if (minRow > maxRow || minColumn > maxColumn) return '';

  const lines: string[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    const values: string[] = [];
    for (let column = minColumn; column <= maxColumn; column++) {
      values.push(
        isCellInSelection(args.rects, row, column)
          ? clipboardValue(selectionCellValue(args, row, column))
          : '',
      );
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

export function computeSelectionStats(args: SelectionStatsArgs): SelectionStats {
  const { rects, prePeriodCols, periodGroupKeys, displayMonths, rowCount } = args;
  const prePeriodLen = prePeriodCols.length;
  let sum = 0;
  let count = 0;
  const seen = new Set<number>();
  const addValue = (value: unknown) => {
    if (value == null || (typeof value === 'string' && value.trim() === '')) return;
    const numericValue = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numericValue)) return;
    sum += numericValue;
    count++;
  };

  for (const rect of rects) {
    for (let r = rect.minR; r <= rect.maxR; r++) {
      if (r < 0 || r >= rowCount) continue;
      for (let c = rect.minC; c <= rect.maxC; c++) {
        // (r,c) 編碼成單一數字 —— r * 1e6 + c 在實務 r/c 範圍內不會碰撞，比 string 快。
        const key = r * 1_000_000 + c;
        if (seen.has(key)) continue;
        if (c < prePeriodLen) {
          const col = prePeriodCols[c];
          if (!col || col.filterType !== 'numeric') continue;
          seen.add(key);
          args.onVisitCell?.(r, c);
          addValue(args.getPrePeriodValue(r, col.key));
        } else {
          if (args.timelineCols) {
            const timelineCol = args.timelineCols[c - prePeriodLen];
            if (!timelineCol) continue;
            seen.add(key);
            args.onVisitCell?.(r, c);
            addValue(timelineCol.kind === 'item'
              ? args.getPrePeriodValue(r, timelineCol.key)
              : args.getPeriodValue(r, timelineCol.groupKey, timelineCol.monthIndex));
            continue;
          }
          const gi = Math.floor((c - prePeriodLen) / displayMonths);
          const groupKey = periodGroupKeys[gi];
          if (!groupKey) continue;
          const mi = (c - prePeriodLen) % displayMonths;
          seen.add(key);
          args.onVisitCell?.(r, c);
          addValue(args.getPeriodValue(r, groupKey, mi));
        }
      }
    }
  }

  return { sum, count, avg: count > 0 ? sum / count : 0 };
}
