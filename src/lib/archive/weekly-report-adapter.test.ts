import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adaptArchiveWeeklyReport } from './weekly-report-adapter';
import type { ArchiveWeeklyReport } from './weekly-report-contract';
import { archiveSourceQueries } from './source-query';

const report: ArchiveWeeklyReport = {
  run: { id: '00000000-0000-0000-0000-000000000134', sourceRunId: 134, versionCode: 'MRP-HISTORY', runDate: '2026-07-28', sourceStatus: 'completed', verifiedAt: '2026-09-07', generation: 'G1', seedFileName: 'G1.dump' },
  kind: 'component', mrpType: 'B', page: 1, pageSize: 50, total: 1, warehouseAvailable: false, missingFields: ['purchaseAction'],
  rows: [{ id: '1', mrp_run_id: '134', mrp_type: 'B', material_part_no: '001.10', good_stock_pc: null, weeks_until_order: '-3', purchase_action: null }],
  periods: [{ mrp_run_id: '134', mrp_type: 'B', material_part_no: '001.10', week_index: '0', usage: '100', receipts: null, remaining_stock: null },
    { mrp_run_id: '134', mrp_type: 'B', material_part_no: '001.10', week_index: '2', usage: null, receipts: '0', remaining_stock: '-50' }],
};

test('weekly history preserves identifiers, nulls, original lead weeks and sparse week positions', () => {
  const { componentItems, snapshot } = adaptArchiveWeeklyReport(report);
  assert.equal(componentItems[0].materialPartNo, '001.10');
  assert.equal(componentItems[0].goodStockPc, null);
  assert.equal(componentItems[0].weeksUntilOrder, -3);
  assert.equal(componentItems[0].purchaseAction, null);
  const periods = Object.values(snapshot.periods)[0];
  assert.equal(periods[1].usage, null);
  assert.equal(periods[2].weekIndex, 2);
  assert.equal(periods[2].receipts, 0);
  assert.equal(periods[2].remainingStock, -50);
});

test('weekly history rejects crossed Run/type/part, duplicate and invalid weeks', () => {
  for (const patch of [{ mrp_run_id: '217' }, { mrp_type: 'W' }, { material_part_no: 'OTHER' }, { week_index: null }, { week_index: '-1' }, { week_index: '100' }] as Array<Record<string, string | null>>) {
    assert.throws(() => adaptArchiveWeeklyReport({ ...report, periods: [{ ...report.periods[0], ...patch }] }));
  }
  assert.throws(() => adaptArchiveWeeklyReport({ ...report, periods: [...report.periods, report.periods[0]] }), /重複/);
  assert.throws(() => adaptArchiveWeeklyReport({ ...report, rows: [report.rows[0], report.rows[0]] }), /重複/);
});

test('sales history retains stored part-version rows without current grouping and gates warehouse claims', () => {
  const sales: ArchiveWeeklyReport = { ...report, kind: 'sales', rows: [{ id: '1', mrp_run_id: '134', part_version: '001.10', customer_code: null, customer_part_no: '0001', wfg_stock_pc: '20', ye1_stock_pc: '0', fg_diff_0_4: '-20', fg_status_0_4: 'shortage' }], periods: [] };
  const { salesItems } = adaptArchiveWeeklyReport(sales);
  assert.equal(salesItems[0].customerPartNo, '0001');
  assert.equal(salesItems[0].customerCode, null);
  assert.equal(salesItems[0].fgDiff04, -20);
  assert.equal(salesItems[0].fgStatus04, 'shortage');
  assert.equal(salesItems[0].wfgStockPc, null);
  assert.equal(salesItems[0].ye1StockPc, null);
  assert.equal(salesItems[0].inventoryValidationAvailable, false);
  assert.deepEqual(salesItems[0].memberPartVersions, ['001.10']);
  assert.equal(adaptArchiveWeeklyReport({ ...sales, warehouseAvailable: true }).salesItems[0].wfgStockPc, 20);
});

test('shared weekly snapshot renderers bypass live periods and whole-live export', () => {
  for (const name of ['component-weekly', 'sales-meeting']) {
    const source = readFileSync(new URL(`../../components/${name}-traditional.tsx`, import.meta.url), 'utf8');
    if (name === 'component-weekly') {
      assert.match(source, /const periodsKey = snapshot \|\| preloadedPeriods \? null/);
      assert.match(source, /if \(snapshot \|\| preloadedPeriods\) return;/);
      assert.match(source, /snapshot\?\.periods \?\? preloadedPeriods \?\? livePeriodsMap/);
    } else {
      assert.match(source, /const periodsKey = snapshot \? null/);
      assert.match(source, /if \(snapshot\) return;/);
      assert.match(source, /snapshot\?\.periods \?\? livePeriodsMap/);
    }
    assert.match(source, /!snapshot && fetchAllForExport/);
  }
});

test('historical source search chooses compatible identities and leaves unknown BOM relation explicit', () => {
  const queries = archiveSourceQueries({ query: 'SA-0110206000', partVersion: 'SA-0110206000', erpPartNo: '0110206000-V01-02PA' });
  assert.equal(queries?.orders, 'SA-0110206000');
  assert.equal(queries?.inventory, '0110206000-V01-02PA');
  assert.equal(queries?.bom, '');
  assert.equal(archiveSourceQueries({ query: '90032', materialPartNo: '90032' })?.bom, '90032');
  assert.equal(archiveSourceQueries({ query: 'manual query' }), undefined);
});
