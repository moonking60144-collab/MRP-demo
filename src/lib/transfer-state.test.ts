import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSFER_STATUS, isTransferBlocked } from './transfer-state';

test('只有處理中與結果不確定的轉單狀態會阻擋再次送出', () => {
  assert.equal(isTransferBlocked(TRANSFER_STATUS.PENDING), true);
  assert.equal(isTransferBlocked(TRANSFER_STATUS.UNKNOWN), true);
  assert.equal(isTransferBlocked(TRANSFER_STATUS.IDLE), false);
  assert.equal(isTransferBlocked(TRANSFER_STATUS.FAILED), false);
  assert.equal(isTransferBlocked(TRANSFER_STATUS.SUCCEEDED), false);
});
