import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidatedSharedResource } from './shared-reader';

interface Resource {
  id: number;
  key: string;
}

function pool(validate: (resource: Resource) => Promise<void> = async () => undefined) {
  let creates = 0;
  let validations = 0;
  const disposed: number[] = [];
  const resource = new ValidatedSharedResource<Resource>(
    (key) => ({ id: ++creates, key }),
    async (value) => {
      validations += 1;
      await validate(value);
    },
    async (value) => { disposed.push(value.id); },
  );
  return {
    resource,
    counts: () => ({ creates, validations, disposed: [...disposed] }),
  };
}

test('同一連線設定重用 resource，但每次借用都先驗證', async () => {
  const { resource, counts } = pool();
  assert.equal(await resource.use('reader-a', async value => value.id), 1);
  assert.equal(await resource.use('reader-a', async value => value.id), 1);
  assert.deepEqual(counts(), { creates: 1, validations: 2, disposed: [] });
});

test('同時借用共用同一 resource 與同一輪驗證', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { resource, counts } = pool(async () => gate);
  const first = resource.use('reader-a', async value => value.id);
  const second = resource.use('reader-a', async value => value.id);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.deepEqual(counts(), { creates: 1, validations: 1, disposed: [] });
});

test('連線設定改變會建立新 resource，舊 resource 於閒置後關閉', async () => {
  const { resource, counts } = pool();
  assert.equal(await resource.use('reader-a', async value => value.id), 1);
  assert.equal(await resource.use('reader-b', async value => value.id), 2);
  assert.deepEqual(counts(), { creates: 2, validations: 2, disposed: [1] });
});

test('連線設定切換不會中斷仍在執行的舊查詢，完成後才關閉舊 resource', async () => {
  let release!: () => void;
  let started!: () => void;
  const queryDone = new Promise<void>((resolve) => { release = resolve; });
  const queryStarted = new Promise<void>((resolve) => { started = resolve; });
  const { resource, counts } = pool();
  const first = resource.use('reader-a', async value => {
    started();
    await queryDone;
    return value.id;
  });
  await queryStarted;

  assert.equal(await resource.use('reader-b', async value => value.id), 2);
  assert.deepEqual(counts(), { creates: 2, validations: 2, disposed: [] });
  release();
  assert.equal(await first, 1);
  assert.deepEqual(counts(), { creates: 2, validations: 2, disposed: [1] });
});

test('驗證失敗會淘汰 resource，下一次借用必須重建', async () => {
  const { resource, counts } = pool(async value => {
    if (value.id === 1) throw new Error('unsafe reader');
  });
  await assert.rejects(resource.use('reader-a', async value => value.id), /unsafe reader/);
  assert.equal(await resource.use('reader-a', async value => value.id), 2);
  assert.deepEqual(counts(), { creates: 2, validations: 2, disposed: [1] });
});

test('查詢 callback 失敗不會誤判連線權限失效', async () => {
  const { resource, counts } = pool();
  await assert.rejects(
    resource.use('reader-a', async () => { throw new Error('invalid query'); }),
    /invalid query/,
  );
  assert.equal(await resource.use('reader-a', async value => value.id), 1);
  assert.deepEqual(counts(), { creates: 1, validations: 2, disposed: [] });
});
