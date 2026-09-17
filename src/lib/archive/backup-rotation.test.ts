import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryContains } from './backup-rotation';

test('rotation requires same schema and every complete row group including provenance', () => {
  const old = { schemaSha256: 'schema', groups: { 'data/run1': 'full-rows', 'meta/source1': 'identity' } };
  assert.equal(recoveryContains({ ...old, groups: { ...old.groups, 'data/run2': 'new' } }, old), true);
  for (const keeper of [
    { schemaSha256: 'different', groups: old.groups },
    { schemaSha256: 'schema', groups: { 'data/run1': 'full-rows' } },
    { schemaSha256: 'schema', groups: { ...old.groups, 'data/run1': 'changed' } },
    { schemaSha256: 'schema' },
  ]) assert.equal(recoveryContains(keeper, old), false, 'UNRECOVERABLE_BACKUP_MUST_STAY');
  assert.equal(recoveryContains(old, { schemaSha256: 'schema', groups: {} }), false);
});
