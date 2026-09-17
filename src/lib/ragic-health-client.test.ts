import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRagicPreflightError } from './ragic-health-client';

test('Ragic preflight 錯誤向使用者顯示中文分類、最近成功與技術原因', () => {
  const message = formatRagicPreflightError({
    error: 'Ragic 目前無法連線（dns_error），未建立 MRP Run',
    ragicHealth: {
      status: 'dns_error',
      lastSuccessAt: '2026-08-14T05:52:20.000Z',
      statusCode: null,
      error: 'getaddrinfo ENOTFOUND fdtw.app',
    },
  }, '執行失敗');

  assert.match(message, /Ragic DNS 解析失敗/);
  assert.match(message, /最近成功：2026\/08\/14/);
  assert.match(message, /getaddrinfo ENOTFOUND fdtw\.app/);
});

test('Ragic health payload 不存在時保留原 API 錯誤', () => {
  assert.equal(
    formatRagicPreflightError({ error: 'Another MRP run is already in progress' }, '執行失敗'),
    'Another MRP run is already in progress',
  );
  assert.equal(formatRagicPreflightError(null, '執行失敗'), '執行失敗');
});

test('資料庫 preflight 錯誤顯示缺少欄位與 migration 操作', () => {
  const message = formatRagicPreflightError({
    error: '資料庫結構不完整',
    dbHealth: {
      ok: false,
      missing: [
        'public.mrp_run.order_demand_contract_version',
        'staging.orders.shipped_qty',
      ],
    },
  }, '執行失敗');

  assert.match(message, /資料庫結構尚未更新，MRP 未開始執行/);
  assert.match(message, /public\.mrp_run\.order_demand_contract_version/);
  assert.match(message, /prisma\/init\.sql migration/);
});
