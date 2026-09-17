import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadOpenPlanQtyRecords,
  verifyPlanQtyCandidate,
} from './verify-plan-qty';

test('抽樣生產計畫只用一次 filtered full-listing 預載並依 Ragic ID 建索引', async () => {
  const calls: unknown[] = [];
  const records = await loadOpenPlanQtyRecords(
    ['PP-001', 'PP-002'],
    async (options) => {
      calls.push(options);
      return [
        { _ragic_id: '5188', '1006542': 'PP-001' },
        { _ragic_id: '5189', '1006542': 'PP-002' },
      ];
    },
  );

  assert.deepEqual(calls, [{
    path: '/default/d4/10',
    listing: false,
    limit: 1000,
    where: [
      { fieldId: '1015482', operator: 'eq', value: '未結案' },
      { fieldId: '1006542', operator: 'eq', value: 'PP-001' },
      { fieldId: '1006542', operator: 'eq', value: 'PP-002' },
    ],
  }]);
  assert.equal(records.size, 2);
  assert.equal(records.get('5189')?.['1006542'], 'PP-002');
});

test('全量驗證未指定 planNo 時保留完整未結案 preload', async () => {
  const calls: unknown[] = [];
  await loadOpenPlanQtyRecords(undefined, async (options) => {
    calls.push(options);
    return [];
  });

  assert.deepEqual(calls, [{
    path: '/default/d4/10',
    listing: false,
    limit: 1000,
    where: [{ fieldId: '1015482', operator: 'eq', value: '未結案' }],
  }]);
});

test('抽樣資料沒有可用 planNo 時不下載完整未結案清單', async () => {
  let calls = 0;
  const records = await loadOpenPlanQtyRecords([], async () => {
    calls++;
    return [];
  });

  assert.equal(calls, 0);
  assert.equal(records.size, 0);
});

test('預載命中時直接本機驗算，不再發送單筆 Ragic GET', async () => {
  let fallbackCalls = 0;
  const result = await verifyPlanQtyCandidate(
    { ragicRecordId: '5188', ragicPlanQty: 0 },
    1,
    async () => {
      fallbackCalls++;
      throw new Error('不應呼叫單筆 fallback');
    },
    { '1006542': 'PP-001', '1006546': 'PART-V01' },
  );

  assert.equal(result.kind, 'matched');
  assert.equal(fallbackCalls, 0);
});

test('Ragic 讀取失敗分類為驗證不可用，不混入公式不一致', async () => {
  const result = await verifyPlanQtyCandidate(
    { ragicRecordId: '5188', ragicPlanQty: 100 },
    1,
    async () => { throw new Error('network timeout'); },
  );

  assert.equal(result.kind, 'fetch_failed');
  if (result.kind !== 'fetch_failed') return;
  assert.equal(result.failure.recordId, '5188');
  assert.equal(result.failure.message, 'network timeout');
});

test('只有成功讀取且計算差異超過容許值才分類為公式不一致', async () => {
  const matched = await verifyPlanQtyCandidate(
    { ragicRecordId: '5188', ragicPlanQty: 0 },
    1,
    async () => ({}),
  );
  const mismatched = await verifyPlanQtyCandidate(
    { ragicRecordId: '5189', ragicPlanQty: 100 },
    1,
    async () => ({ '1006542': 'PP-001', '1006546': 'PART-V01' }),
  );

  assert.equal(matched.kind, 'matched');
  assert.equal(mismatched.kind, 'mismatch');
  if (mismatched.kind !== 'mismatch') return;
  assert.equal(mismatched.divergence.reason, 'mismatch');
  assert.equal(mismatched.divergence.diff, -100);
});
