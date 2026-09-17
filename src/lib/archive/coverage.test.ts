import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_RUN_TABLES, hasCompleteTableEvidence, type ArchiveTableEvidence } from './coverage';
import { archiveConnectionUrl } from './connection';

const tables = (): ArchiveTableEvidence[] => ARCHIVE_RUN_TABLES.map(tableName => ({
  tableName, status: 'verified', sourcePresent: true, sourceRows: BigInt(0), archiveRows: BigInt(0),
  sourceDigest: 'a'.repeat(64), archiveDigest: 'a'.repeat(64), verifiedAt: new Date(),
}));

test('逐表驗證要求完整 table inventory、筆數與 digest 一致', () => {
  assert.equal(hasCompleteTableEvidence('G4', tables()), true);
  assert.equal(hasCompleteTableEvidence('G4', tables().slice(1)), false);
  const duplicate = tables();
  duplicate[0] = duplicate[1];
  assert.equal(hasCompleteTableEvidence('G4', duplicate), false);
  for (const difference of [
    { sourceRows: BigInt(1) }, { archiveDigest: 'b'.repeat(64) }, { verifiedAt: null }, { status: 'pending' },
  ]) {
    const input = tables();
    input[0] = { ...input[0], ...difference };
    assert.equal(hasCompleteTableEvidence('G4', input), false, 'TABLE_EVIDENCE_MUST_MATCH');
  }
});

test('G1 缺工令 movement 表要明示 not-in-source，不能把任意缺表當 0', () => {
  const input = tables();
  const movement = input.find(table => table.tableName === 'staging.work_order_material_movements')!;
  Object.assign(movement, { status: 'not-in-source', sourcePresent: false, sourceRows: null, sourceDigest: null, archiveDigest: null });
  assert.equal(hasCompleteTableEvidence('G1', input), true);
  assert.equal(hasCompleteTableEvidence('G4', input), false);
  input[0] = { ...movement, tableName: 'public.mrp_run' };
  assert.equal(hasCompleteTableEvidence('G1', input), false);
});

test('Archive connection 不 fallback 到正式 DB，禁止錯誤 database/role', () => {
  assert.throws(() => archiveConnectionUrl('reader', { DATABASE_URL: 'postgresql://mrp@localhost/funda_mrp' }));
  for (const url of [
    'postgresql://archive_reader@localhost/funda_mrp',
    'postgresql://archive_loader@localhost/funda_mrp_archive',
    'postgresql://postgres@localhost/funda_mrp_archive',
  ]) assert.throws(() => archiveConnectionUrl('reader', { ARCHIVE_DATABASE_URL: url }));
  assert.equal(archiveConnectionUrl('reader', {
    ARCHIVE_DATABASE_URL: 'postgresql://archive_reader@localhost/funda_mrp_archive',
  }), 'postgresql://archive_reader@localhost/funda_mrp_archive');
});
