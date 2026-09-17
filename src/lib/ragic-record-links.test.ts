import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRagicRecordUrl } from './ragic-record-links';

test('來源明細使用正確的 Ragic 主表路徑', () => {
  assert.match(buildRagicRecordUrl('inventory-lot', '16') || '', /\/default\/forms4\/16\/16$/);
  assert.match(buildRagicRecordUrl('inventory-movement', '20') || '', /\/default\/forms4\/20\/20$/);
  assert.match(buildRagicRecordUrl('work-order-bom', '28') || '', /\/default\/forms8\/28\/28$/);
  assert.match(buildRagicRecordUrl('work-order', '92') || '', /\/default\/forms8\/92\/92$/);
  assert.match(buildRagicRecordUrl('purchase-order', '1') || '', /\/default\/p6mrp\/1\/1$/);
  assert.match(buildRagicRecordUrl('part-version', '10') || '', /\/default\/forms31\/10\/10$/);
  assert.match(buildRagicRecordUrl('inventory', '8') || '', /\/default\/forms12\/8\/8$/);
  assert.match(buildRagicRecordUrl('inventory-master', '24') || '', /\/default\/g6mrp\/1\/24$/);
  assert.match(buildRagicRecordUrl('order', '2') || '', /\/default\/forms31\/2\/2$/);
  assert.match(buildRagicRecordUrl('forecast', '6') || '', /\/default\/forms31\/6\/6$/);
  assert.match(buildRagicRecordUrl('production-plan', '10') || '', /\/default\/d4\/10\/10$/);
});

test('缺少 Ragic record id 時不產生錯誤連結', () => {
  assert.equal(buildRagicRecordUrl('work-order-bom', null), null);
  assert.equal(buildRagicRecordUrl('work-order-bom', '   '), null);
});
