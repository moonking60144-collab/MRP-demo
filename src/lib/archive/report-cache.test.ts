import assert from 'node:assert/strict';
import test from 'node:test';
import { ArchiveReportCache, isArchiveReportUrl } from './report-cache';

const root = '/api/archive/runs/72340191-6c35-4737-b57d-b94be64f363f';

test('only immutable run reports are eligible, never version discovery or metadata', () => {
  for (const path of ['fg-report', 'weekly-report', 'fg-monthly', 'inventory']) assert.equal(isArchiveReportUrl(`${root}/${path}?page=1`), true);
  for (const path of ['/api/archive/runs?page=1', root, `${root}/unknown`, '/api/fg-monthly']) assert.equal(isArchiveReportUrl(path), false);
});

test('cache separates run, report, query, page and rejects expired entries', () => {
  const cache = new ArchiveReportCache(32, 10000, 50);
  const key = `${root}/fg-report?page=1&q=A`;
  cache.set(key, { value: 42 }, 100);
  assert.deepEqual(cache.get(key, 149), { value: 42 });
  for (const other of [key.replace('page=1', 'page=2'), key.replace('q=A', 'q=B'), key.replace('fg-report', 'weekly-report'), key.replace('72340191', '12340191')]) assert.equal(cache.get(other, 110), undefined);
  assert.equal(cache.get(key, 150), undefined);
});

test('LRU touches on consumption, not render peeks; caps both entries and payload', () => {
  const cache = new ArchiveReportCache(2, 1000);
  cache.set('a', 1); cache.set('b', 2); cache.peek('a'); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  cache.get('b'); cache.set('d', 4);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.get('b'), 2);
  const bytes = new ArchiveReportCache(32, 20);
  bytes.set('a', '1234'); bytes.set('b', '5678');
  assert.equal(bytes.get('a'), undefined);
  assert.equal(bytes.get('b'), '5678');
  bytes.set('large', 'x'.repeat(100));
  assert.equal(bytes.get('large'), undefined);
  assert.equal(bytes.get('b'), '5678');
  bytes.delete('b');
  assert.equal(bytes.get('b'), undefined);
});

test('replacing and deleting entries release their budget', () => {
  const cache = new ArchiveReportCache(2, 20);
  cache.set('a', '1234'); cache.set('a', 1); cache.set('b', '5678');
  assert.equal(cache.get('a'), 1);
  cache.delete('b'); cache.set('c', 'abcd');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 'abcd');
});
