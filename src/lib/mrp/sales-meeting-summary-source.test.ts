import assert from 'node:assert/strict';
import test from 'node:test';
import { salesMeetingSummarySource } from './sales-meeting-summary-source';
import type { SalesMeetingItem, SalesMeetingSummaryKey } from './sales-meeting-types';
import { SALES_MEETING_COLUMNS } from '../../components/data-table/column-defs/sales-meeting-columns';

test('四個摘要入口固定 Run、DB、成員版本與近期／全部範圍', () => {
  const item = { mrpRunId: 42, dbSource: 'remote', partVersion: 'PV-A', memberPartVersions: ['PV-A', 'PV-A-V01'] } as SalesMeetingItem;
  const expected = {
    outstanding04: ['orders', 'recent'], fgDiff04: ['balance', 'recent'],
    totalOrderDemand: ['orders', 'all'], totalFgDiff: ['balance', 'all'],
  };
  for (const [key, [type, scope]] of Object.entries(expected)) {
    const target = salesMeetingSummarySource(item, key as SalesMeetingSummaryKey);
    assert.equal(target.item, item);
    assert.equal(target.type, type);
    assert.equal(target.scope, scope, `${key}: SUMMARY_SCOPE_MUST_MATCH_REQUEST`);
  }
});

test('產銷業務名稱保留 Source 對照碼與範圍／計畫語意於 description', () => {
  const column = (id: string) => SALES_MEETING_COLUMNS.find(row => row.id === id)!;
  assert.equal(column('stockWeeks').header, '庫存可支應週數');
  assert.equal(column('totalOrderDemand').header, '未出貨訂單總量');
  assert.match(column('outstanding04').description!, /A14.*前期＋前4週/);
  assert.match(column('totalOrderDemand').description!, /U99.*12週以外/);
  for (const id of ['fgDiff04', 'totalFgDiff']) assert.match(column(id).description!, /不含生產計畫/);
});
