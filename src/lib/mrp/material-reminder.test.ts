import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialWeeklyHref, summarizeMaterialReminder, type MaterialReminderRow } from './material-reminder';
import { readMaterialReminders } from './material-reminder-query';

const row: MaterialReminderRow = { partVersion: 'SY-A', woNumber: 'WO-A', materialPartNo: 'A-V01-01BU', mrpType: 'B', unit: 'pc', demandDate: '2026-09-01', remainingUsage: '46890', issuedQtyState: 'known', movementState: 'known', shortageStartWeek: 0, shortageStartDate: null };

test('材料缺口只是提醒，不分配成品欠產；重複材料僅計一次', () => {
  const result = summarizeMaterialReminder([row, { ...row, woNumber: 'WO-B' }]);
  assert.equal(result.state, 'risk');
  assert.equal(result.riskCount, 1);
  assert.equal(result.rows.length, 2);
  assert.equal('shortageQty' in result, false);
});

test('空關聯、未知領料、缺少日期／週推不能顯示正常', () => {
  assert.equal(summarizeMaterialReminder([]).state, 'unknown');
  assert.equal(summarizeMaterialReminder([{ ...row, mrpType: 'W', shortageStartWeek: null, reportUnit: 'kg' }]).state, 'unknown', '線材單位不符不可顯示正常');
  for (const patch of [{ issuedQtyState: 'unknown' }, { remainingUsage: null }, { demandDate: null }, { mrpType: null }, { woNumber: null }, { movementState: 'unknown' }]) {
    assert.equal(summarizeMaterialReminder([{ ...row, shortageStartWeek: null, ...patch }]).state, 'unknown');
  }
  const partial = summarizeMaterialReminder([row, { ...row, mrpType: null, shortageStartWeek: null }]);
  assert.equal(partial.state, 'risk');
  assert.equal(partial.incomplete, true);
});

test('已領足的材料不因材料池其他需求缺料而警示；缺口與無需求分開', () => {
  assert.equal(summarizeMaterialReminder([{ ...row, remainingUsage: '0' }]).state, 'none');
  assert.equal(summarizeMaterialReminder([{ ...row, shortageStartWeek: null }]).state, 'clear');
  assert.equal(summarizeMaterialReminder([{ ...row, remainingUsage: '0' }], false).state, 'unknown');
});

test('已知零餘量即使缺日期或週推關聯也不得計入缺料項數', () => {
  for (const patch of [{ demandDate: null }, { mrpType: null }, { mrpType: 'W', reportUnit: 'kg' }]) {
    const result = summarizeMaterialReminder([{ ...row, remainingUsage: '0', ...patch }]);
    assert.equal(result.riskCount, 0, 'KNOWN_ZERO_MUST_NOT_ALERT');
    assert.equal(result.state, 'unknown');
    assert.equal(result.incomplete, true);
    assert.equal(result.rows.length, 0);
  }
  assert.equal(summarizeMaterialReminder([{ ...row, remainingUsage: '0', issuedQtyState: 'unknown' }]).state, 'risk', 'Unknown quantity must not be treated as known zero');
});

test('連結保留完整料號、類別、Run、來源與 Archive UUID', () => {
  const url = new URL(materialWeeklyHref({ runId: 265, dbSource: 'remote' }, 'A+B/中文', 'B'), 'http://local');
  assert.equal(url.searchParams.get('material'), 'A+B/中文');
  assert.equal(url.searchParams.get('runId'), '265');
  assert.equal(url.searchParams.get('dbSource'), 'remote');
  assert.equal(url.searchParams.get('mrpType'), 'B');
  const archive = new URL(materialWeeklyHref({ runId: 1, archiveId: 'uuid' }, 'A', 'W'), 'http://local');
  assert.equal(archive.searchParams.get('archiveId'), 'uuid');
  assert.equal(archive.searchParams.has('dbSource'), false);
});

test('同一批次依 exact 客料版本／聚合成員讀取，SQL 只用參數與同一 scope', async () => {
  for (const archive of [false, true]) {
    const scope = archive ? 'id-archive' : 265;
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const client = { async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      calls.push({ query, values });
      assert.match(query, /^\s*SELECT/);
      assert.equal(values[0], scope);
      return (calls.length === 1 ? [
        { partVersion: 'AGG', aggregated: true, members: ['SY-A', 'SY-B'] },
        { partVersion: 'SY-A', aggregated: false, members: [] },
      ] : [row]) as T;
    } };
    const result = await readMaterialReminders(client, scope, [
      { partVersion: 'AGG', aggregated: true }, { partVersion: 'SY-A', aggregated: false }, { partVersion: 'MISSING', aggregated: false },
    ], archive);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].values[1], ['SY-A', 'SY-B']);
    assert.match(calls[1].query, /b\.wo_number = w\.wo_number/);
    assert.match(calls[1].query, /c\.material_part_no = btrim\(b\.component_no\)/);
    assert.match(calls[1].query, archive ? /archive_run_id/ : /mrp_run_id/);
    assert.equal(result[0].reminder.incomplete, true, '聚合缺少一個成員必須保留未知');
    assert.equal(result[1].reminder.state, 'risk');
    assert.equal(result[2].reminder.state, 'unknown');
  }
});
