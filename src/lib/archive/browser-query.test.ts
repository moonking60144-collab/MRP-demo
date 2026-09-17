import assert from 'node:assert/strict';
import test from 'node:test';
import definitions from './schema-generations.json';
import { ARCHIVE_VIEWS, archiveCell, archiveColumns, type ArchiveView } from './browser-contract';
import { parseArchiveIdentity, parseArchiveQuery } from './browser-query';
import { archiveResponse } from './browser-response';

test('archive view identifiers and projections are fixed to existing snapshot columns', () => {
  for (const [name, view] of Object.entries(ARCHIVE_VIEWS)) {
    const available = new Set(definitions.G4[view.table as keyof typeof definitions.G4]!.map(column => column.name));
    for (const column of [...archiveColumns(name as ArchiveView).map(column => column.key), ...view.search]) {
      assert.ok(available.has(column), `${name}.${column}`);
    }
  }
});

test('query rejects injection, inherited object keys, invalid paging and excessive search', () => {
  for (const value of ['0', '-1', '1.2', '1e2', 'Infinity', '100000']) {
    assert.throws(() => parseArchiveQuery(new URLSearchParams({ page: value })), /查詢條件/);
  }
  assert.throws(() => parseArchiveQuery(new URLSearchParams({ q: 'a'.repeat(101) })));
  const id = '00000000-0000-0000-0000-000000000001';
  for (const view of ['__proto__', 'constructor', 'fg-monthly;DROP TABLE x']) assert.throws(() => parseArchiveIdentity(id, view));
  assert.throws(() => parseArchiveIdentity("x' OR true", 'fg-monthly'));
  assert.equal(parseArchiveIdentity(id, 'fg-monthly'), 'fg-monthly');
});

test('historical missing values remain distinct from zero without decimal precision loss', () => {
  assert.equal(archiveCell(null), '—');
  assert.equal(archiveCell('0.00000', 'numeric'), '0');
  assert.equal(archiveCell('9007199254740993.123456789012345678901234567890', 'numeric'), '9007199254740993.12345678901234567890123456789');
  assert.equal(archiveCell('90032-HCK-0000'), '90032-HCK-0000');
  assert.equal(archiveCell('1.10'), '1.10');
  assert.equal(archiveCell('false'), 'false');
  assert.equal(archiveCell('true', 'boolean', 'is_aggregated'), '同 ERP 整合');
  assert.equal(archiveCell('false', 'boolean', 'is_aggregated'), '按版本');
});

test('unexpected DB errors expose neither connection URLs nor credentials', async () => {
  const response = await archiveResponse(async () => { throw new Error('postgresql://secret:password@server/db'); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /secret|password|postgresql/);
});
