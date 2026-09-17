import assert from 'node:assert/strict';
import test from 'node:test';

import { ClientScopedAsyncCache } from './client-scoped-async-cache';

test('同一 client 與 key 合併併發載入，不跨 client 共用', async () => {
  const cache = new ClientScopedAsyncCache<number>();
  const firstClient = {};
  const secondClient = {};
  let loads = 0;
  const load = async () => ++loads;

  const [first, repeated] = await Promise.all([
    cache.get(firstClient, 'run:1:W', load, 100),
    cache.get(firstClient, 'run:1:W', load, 100),
  ]);
  const otherClient = await cache.get(secondClient, 'run:1:W', load, 100);

  assert.equal(first, 1);
  assert.equal(repeated, 1);
  assert.equal(otherClient, 2);
  assert.equal(loads, 2);
});

test('快取有 TTL 與 LRU 數量上限', async () => {
  const cache = new ClientScopedAsyncCache<number>(2, 50);
  const client = {};
  let loads = 0;
  const load = async () => ++loads;

  assert.equal(await cache.get(client, 'a', load, 100), 1);
  assert.equal(await cache.get(client, 'b', load, 100), 2);
  assert.equal(await cache.get(client, 'a', load, 120), 1);
  assert.equal(await cache.get(client, 'c', load, 120), 3);
  assert.equal(await cache.get(client, 'b', load, 120), 4);
  assert.equal(await cache.get(client, 'a', load, 151), 5);
});

test('失敗結果不留在快取', async () => {
  const cache = new ClientScopedAsyncCache<number>();
  const client = {};
  let loads = 0;

  await assert.rejects(cache.get(client, 'run:1:B', async () => {
    loads += 1;
    throw new Error('failed');
  }));
  assert.equal(await cache.get(client, 'run:1:B', async () => ++loads), 2);
});
