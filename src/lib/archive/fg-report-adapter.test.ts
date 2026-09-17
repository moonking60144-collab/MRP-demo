import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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

test('archive adapter rejects crossed Run, aggregation, parts, invalid and duplicate period identities', () => {
  for (const patch of [{ mrp_run_id: '217' }, { is_aggregated: 'true' }, { part_version: 'OTHER' }, { period_index: null }, { period_index: '-1' }] as Array<Record<string, string | null>>) {
    assert.throws(() => adaptArchiveFgReport({ ...report, periods: [{ ...report.periods[0], ...patch }] }));
  }
  assert.throws(() => adaptArchiveFgReport({ ...report, periods: [report.periods[0], report.periods[0]] }), /重複/);
});

test('shared traditional snapshot entrypoint bypasses live period fetch/cache and preserves null selection callback', () => {
  const source = readFileSync(new URL('../../components/fg-monthly-traditional.tsx', import.meta.url), 'utf8');
  assert.match(source, /const periodsKey = snapshot \? null : fgMonthlyPeriodsCacheKey/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(snapshot\) return;\s*if \(items.length/);
  assert.match(source, /if \(snapshot\) return snapshot.missingFields.includes\(gKey\) \? null : p\?\.\[gKey as keyof PeriodDetail\] \?\? null;/, 'ARCHIVE_NULL_SELECTION');
  assert.match(source, /!snapshot && fetchAllForExport/);
});
