import assert from 'node:assert/strict';
import test from 'node:test';
import { readPurchaseLeadTimeResponse } from './component-weekly-lead-time-response';

test('前置期收到代理 HTML 或不完整成功回應時保留結果未知，不顯示 JSON 解析錯誤', async () => {
  for (const response of [
    new Response('<!DOCTYPE html><title>Timeout</title>', { status: 524, headers: { 'Content-Type': 'text/html' } }),
    new Response('<!DOCTYPE html><title>Login</title>', { status: 200 }),
    Response.json({}),
    Response.json(null),
  ]) {
    await assert.rejects(() => readPurchaseLeadTimeResponse(response), (error: Error) => {
      assert.match(error.message, /結果無法確認/);
      assert.match(error.message, /不要重送/);
      assert.doesNotMatch(error.message, /Unexpected token|DOCTYPE/);
      return true;
    });
  }
});

test('前置期保留有效成功與 Source 衝突的新值', async () => {
  const success = { updated: true, purchaseLeadWeeks: 0, purchaseLeadWeeksConfigured: true };
  assert.deepEqual(await readPurchaseLeadTimeResponse(Response.json(success)), success);
  await assert.rejects(() => readPurchaseLeadTimeResponse(Response.json({
    error: 'Source 前置期已被其他人修改', currentPurchaseLeadWeeks: 26, currentConfigured: true,
  }, { status: 409 })), /Source 目前為「26 週」/);
});
