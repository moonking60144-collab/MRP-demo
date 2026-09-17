import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveRunListCache, archiveRunListUrl, isArchiveRunListUrl, prefetchArchiveRunPage, validateArchiveRunPage } from './run-list-cache';

const body = (page: number) => ({ page, pageSize: 50, total: 100, runs: [] });

test('list cache separates search and page, expires after 30 seconds, and caps entries', () => {
  const url = archiveRunListUrl('A&B', 2);
  assert.equal(isArchiveRunListUrl(url), true);
  assert.equal(isArchiveRunListUrl('/api/archive/runs/id'), false);
  archiveRunListCache.set(url, body(2), 100);
  assert.deepEqual(archiveRunListCache.get(url, 30099), body(2));
  assert.equal(archiveRunListCache.get(archiveRunListUrl('A&B', 1), 100), undefined);
  assert.equal(archiveRunListCache.get(archiveRunListUrl('B', 2), 100), undefined);
  assert.equal(archiveRunListCache.get(url, 30100), undefined);
  for (let page = 1; page <= 21; page++) archiveRunListCache.set(archiveRunListUrl('bounded', page), body(page), 100);
  assert.equal(archiveRunListCache.get(archiveRunListUrl('bounded', 1), 100), undefined);
});

test('prefetch caches only matching successful pages and skips a fresh page', async t => {
  const url = archiveRunListUrl('prefetch', 2);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(body(2)));
  await prefetchArchiveRunPage(url, new AbortController().signal);
  assert.deepEqual(archiveRunListCache.get(url), body(2));
  await prefetchArchiveRunPage(url, new AbortController().signal);
  assert.equal(fetchMock.mock.callCount(), 1);
  archiveRunListCache.delete(url);
  fetchMock.mock.mockImplementation(async () => Response.json(body(1)));
  await prefetchArchiveRunPage(url, new AbortController().signal);
  assert.equal(archiveRunListCache.get(url), undefined);
  fetchMock.mock.mockImplementation(async () => Response.json({ error: 'offline' }, { status: 503 }));
  await prefetchArchiveRunPage(url, new AbortController().signal);
  assert.equal(archiveRunListCache.get(url), undefined);
  fetchMock.mock.mockImplementation(async () => Response.json(body(2)));
  const controller = new AbortController(); controller.abort();
  await prefetchArchiveRunPage(url, controller.signal);
  assert.equal(archiveRunListCache.get(url), undefined);
});

test('invalid page responses fail closed', () => {
  const url = archiveRunListUrl('', 2);
  assert.doesNotThrow(() => validateArchiveRunPage(body(2), url));
  for (const value of [body(1), { ...body(2), total: -1 }, { ...body(2), pageSize: 100 }]) {
    assert.throws(() => validateArchiveRunPage(value, url));
  }
});
