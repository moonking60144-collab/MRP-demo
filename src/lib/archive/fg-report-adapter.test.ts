import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TraditionalView } from '../../components/fg-monthly-traditional';
import { FG_MONTHLY_TRADITIONAL_ALL_COLUMNS } from '../../components/data-table/column-defs/fg-monthly-columns';
import type { ColumnHeaderMenuController } from '../../components/data-table/ui/column-header-menu';
import { adaptArchiveFgReport } from './fg-report-adapter';
import type { ArchiveFgReport } from './fg-report-contract';
import { computeSelectionStats, buildSelectionClipboardText } from '../mrp/fg-monthly-selection';

const report: ArchiveFgReport = {
  run: { id: '00000000-0000-0000-0000-000000000134', sourceRunId: 134, versionCode: 'MRP-HISTORY', runDate: '2026-07-28', sourceStatus: 'completed', verifiedAt: '2026-09-07', generation: 'G1', seedFileName: 'G1.dump' },
  page: 1, pageSize: 50, total: 1, aggregated: false, warehouseAvailable: false, missingFields: [],
  rows: [{ id: '1', mrp_run_id: '134', part_version: '1.10', is_aggregated: 'false', current_stock_pc: '100', unit_weight_g: null, main_stock_pc: '0', aux_stock_pc: '20', shortage_start_period: null, shared_erp_count: '2' }],
  periods: [{ mrp_run_id: '134', part_version: '1.10', is_aggregated: 'false', period_index: '0', period_label: '07/28', planned_output: '100', remaining_no_plan: null },
    { mrp_run_id: '134', part_version: '1.10', is_aggregated: 'false', period_index: '2', period_label: '09/28', planned_output: null, remaining_no_plan: '-50' }],
};

test('archive adapter preserves identifiers, nullable metrics, missing month positions and warehouse availability', () => {
  const { items, snapshot } = adaptArchiveFgReport(report);
  assert.equal(items[0].partVersion, '1.10');
  assert.equal(items[0].unitWeightG, null);
  assert.equal(items[0].mainStockPc, null);
  assert.equal(items[0].auxStockPc, null);
  assert.equal(items[0].lastPeriodRemainingNoPlan, -50);
  assert.equal(snapshot.periods['1.10'][1].plannedOutput, null);
  assert.equal(snapshot.periods['1.10'][2].plannedOutput, null);
  assert.equal(adaptArchiveFgReport({ ...report, warehouseAvailable: true }).items[0].auxStockPc, 20);
  const args = { rects: [{ minR: 0, maxR: 0, minC: 0, maxC: 2 }], prePeriodCols: [], periodGroupKeys: ['plannedOutput'], displayMonths: 3, rowCount: 1,
    getPrePeriodValue: () => null, getPeriodValue: (_r: number, _key: string, month: number) => snapshot.periods['1.10'][month]?.plannedOutput ?? null };
  assert.deepEqual(computeSelectionStats(args), { sum: 100, count: 1, avg: 100 });
  assert.equal(buildSelectionClipboardText(args), '100\t\t');
});

test('封存首站來源與 ERP 保留文字，不轉成 NaN 或查詢今日 master', () => {
  const { items } = adaptArchiveFgReport({ ...report, rows: [{ ...report.rows[0],
    first_process: 'BU', first_process_erp_part_no: 'PART-01BU', first_process_source_type: '採購',
  }] });
  assert.equal(items[0].firstProcessSourceType, '採購');
  assert.equal(items[0].firstProcessErpPartNo, 'PART-01BU');
});

test('混合來源提示符合操作能力：歷史切回按版本，即時聚合可展開，單一來源保留 ERP 追溯', () => {
  const previousReact = Reflect.get(globalThis, 'React');
  Reflect.set(globalThis, 'React', React);
  try {
    const adapted = adaptArchiveFgReport({ ...report, aggregated: true, periods: [], rows: [{
      ...report.rows[0], is_aggregated: 'true', first_process_source_type: '混合', first_process_erp_part_no: '混合',
    }] });
    const props = {
      items: adapted.items, aggregated: true, displayMonths: 1,
      columnVisibility: Object.fromEntries(FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.map(column =>
        [column.id, ['partVersion', 'firstProcessSourceType'].includes(column.id)])),
      columnHeaderColumns: FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
      columnHeaderController: { sortByColumnId: new Map(), filteredColumnIds: new Set(), open: false,
        activeColumn: null, openColumnMenu: () => {} } as unknown as ColumnHeaderMenuController,
    };
    const history = renderToStaticMarkup(React.createElement(TraditionalView, { ...props, snapshot: adapted.snapshot }));
    assert.match(history, /請切換按版本檢視各成員來源/, 'ARCHIVE_MIXED_HINT_MUST_MATCH_READ_ONLY_CAPABILITY');
    assert.doesNotMatch(history, /請展開查看/);
    assert.doesNotMatch(history, /▸/);
    const live = renderToStaticMarkup(React.createElement(TraditionalView, { ...props,
      items: [{ ...adapted.items[0], aggregatedMembers: ['1.10', '1.11'] }], fetchMembers: async () => [],
    }));
    assert.match(live, /請展開查看成員/);
    assert.match(live, /▸/);
    const uniform = renderToStaticMarkup(React.createElement(TraditionalView, { ...props, snapshot: adapted.snapshot,
      items: [{ ...adapted.items[0], firstProcessSourceType: '採購', firstProcessErpPartNo: 'PART-01BU' }],
    }));
    assert.match(uniform, /首站完工 ERP：PART-01BU/);
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Reflect.set(globalThis, 'React', previousReact);
  }
});

test('archive adapter rejects crossed Run, aggregation, parts, invalid and duplicate period identities', () => {
  for (const patch of [{ mrp_run_id: '217' }, { is_aggregated: 'true' }, { part_version: 'OTHER' }, { period_index: null }, { period_index: '-1' }] as Array<Record<string, string | null>>) {
    assert.throws(() => adaptArchiveFgReport({ ...report, periods: [{ ...report.periods[0], ...patch }] }));
  }
  assert.throws(() => adaptArchiveFgReport({ ...report, periods: [report.periods[0], report.periods[0]] }), /重複/);
});

test('首站欄固定窄寬，不因表頭文字或混合值被動態撐寬，保留排序篩選提示', () => {
  const previousReact = Reflect.get(globalThis, 'React');
  Reflect.set(globalThis, 'React', React);
  try {
    for (const [process, source] of [['HF', '內製'], ['BU', '委外'], ['BU', '採購'], ['混合', '混合']]) {
      const adapted = adaptArchiveFgReport({ ...report, rows: [{ ...report.rows[0],
        first_process: process, first_process_source_type: source,
      }] });
      const markup = renderToStaticMarkup(React.createElement(TraditionalView, {
        items: adapted.items, snapshot: adapted.snapshot, displayMonths: 1,
        columnVisibility: Object.fromEntries(FG_MONTHLY_TRADITIONAL_ALL_COLUMNS.map(column =>
          [column.id, ['firstProcess', 'firstProcessSourceType'].includes(column.id)])),
        columnHeaderColumns: FG_MONTHLY_TRADITIONAL_ALL_COLUMNS,
        columnHeaderController: {
          sortByColumnId: new Map([['firstProcess', { index: 0, field: { columnId: 'firstProcess', direction: 'asc' } }]]),
          filteredColumnIds: new Set(['firstProcess']), open: false, activeColumn: null, openColumnMenu: () => {},
        } as unknown as ColumnHeaderMenuController,
      }));
      assert.match(markup, /data-col="firstProcess"[^>]*style="[^"]*width:56px;min-width:56px;max-width:56px/);
      assert.match(markup, /data-col="firstProcessSourceType"[^>]*style="[^"]*width:72px;min-width:72px;max-width:72px/);
      assert.match(markup, /aria-label="已篩選"/);
      assert.match(markup, /aria-label="排序第 1 順位"/);
      assert.match(markup, /!min-w-0 flex-wrap/);
    }
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Reflect.set(globalThis, 'React', previousReact);
  }
});

test('shared traditional snapshot entrypoint bypasses live period fetch/cache and preserves null selection callback', () => {
  const source = readFileSync(new URL('../../components/fg-monthly-traditional.tsx', import.meta.url), 'utf8');
  assert.match(source, /const periodsKey = snapshot \? null : fgMonthlyPeriodsCacheKey/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(snapshot\) return;\s*if \(items.length/);
  assert.match(source, /if \(snapshot\) return snapshot.missingFields.includes\(gKey\) \? null : p\?\.\[gKey as keyof PeriodDetail\] \?\? null;/, 'ARCHIVE_NULL_SELECTION');
  assert.match(source, /!snapshot && fetchAllForExport/);
});
