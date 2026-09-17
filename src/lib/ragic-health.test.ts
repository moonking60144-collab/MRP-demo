import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  checkRagicHealth,
  classifyRagicProbeError,
  getRagicHealthSnapshot,
  parseRagicHealthResult,
  probeRagicHealth,
  RagicPreflightError,
  requireRagicPreflight,
  type RagicHealthResult,
} from './ragic-health';

function result(overrides: Partial<RagicHealthResult> = {}): RagicHealthResult {
  return {
    ok: true,
    status: 'healthy',
    checkedAt: '2026-08-14T05:00:00.000Z',
    lastSuccessAt: '2026-08-14T05:00:00.000Z',
    statusCode: 200,
    timings: {
      dnsMs: 1,
      tcpMs: 2,
      tlsMs: 3,
      ttfbMs: 4,
      downloadMs: 1,
      totalMs: 11,
    },
    error: null,
    ...overrides,
  };
}

async function withServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Ragic health probe 以輕量 GET 驗證 API 並記錄網路分段耗時', async () => {
  await withServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    assert.equal(url.pathname, '/default/e6mrp/1');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('where'), '1006554,eq,使用中');
    assert.equal(request.headers.authorization, 'Basic test-key');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ 1: { 1006554: '使用中' } }));
  }, async (baseUrl) => {
    const health = await probeRagicHealth({ baseUrl, apiKey: 'test-key', timeoutMs: 1000 });
    assert.equal(health.ok, true);
    assert.equal(health.status, 'healthy');
    assert.equal(health.statusCode, 200);
    assert(health.timings.totalMs >= 0);
    assert(health.timings.tcpMs !== null);
    assert(health.timings.ttfbMs !== null);
  });
});

test('Ragic health probe 分開標示 HTTP、API 與無效 JSON', async () => {
  await withServer((_request, response) => {
    response.statusCode = 503;
    response.end('busy');
  }, async (baseUrl) => {
    const health = await probeRagicHealth({ baseUrl, apiKey: 'test-key', timeoutMs: 1000 });
    assert.equal(health.status, 'http_error');
    assert.equal(health.statusCode, 503);
  });

  await withServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ERROR', code: 106, msg: 'denied' }));
  }, async (baseUrl) => {
    const health = await probeRagicHealth({ baseUrl, apiKey: 'test-key', timeoutMs: 1000 });
    assert.equal(health.status, 'api_error');
    assert.match(health.error || '', /106.*denied/);
  });

  await withServer((_request, response) => {
    response.end('<html>login</html>');
  }, async (baseUrl) => {
    const health = await probeRagicHealth({ baseUrl, apiKey: 'test-key', timeoutMs: 1000 });
    assert.equal(health.status, 'invalid_response');
  });
});

test('Ragic health 錯誤分類區分 DNS、連線逾時、TLS 與一般網路錯誤', () => {
  assert.equal(classifyRagicProbeError(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })), 'dns_error');
  assert.equal(classifyRagicProbeError(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), 'connect_timeout');
  assert.equal(classifyRagicProbeError(Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' })), 'tls_error');
  assert.equal(classifyRagicProbeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'network_error');
});

test('Ragic preflight 只有 DNS/HTTPS/API 不可用時阻擋，不因單純延遲建立錯誤 Run', async () => {
  const slow = result({ status: 'slow', timings: { ...result().timings, totalMs: 4500 } });
  assert.deepEqual(await requireRagicPreflight(async () => slow), slow);

  const down = result({
    ok: false,
    status: 'dns_error',
    lastSuccessAt: '2026-08-14T04:00:00.000Z',
    statusCode: null,
    error: 'getaddrinfo ENOTFOUND fdtw.app',
  });
  await assert.rejects(
    () => requireRagicPreflight(async () => down),
    (error) => error instanceof RagicPreflightError && error.health === down,
  );
});

test('Ragic health 持久化資料拒絕未知欄位與矛盾狀態', () => {
  assert.deepEqual(parseRagicHealthResult(result()), result());
  assert.equal(parseRagicHealthResult({ ...result(), extra: true }), null);
  assert.equal(parseRagicHealthResult({ ...result(), ok: false }), null);
  assert.equal(parseRagicHealthResult({ ...result(), timings: { ...result().timings, totalMs: -1 } }), null);
});

test('Ragic health 探測失敗時保留前一次成功時間', async () => {
  let storedValue: unknown = null;
  const client = {
    appSetting: {
      findUnique: async () => storedValue === null ? null : { value: storedValue },
      upsert: async ({ create, update }: {
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        storedValue = storedValue === null ? create.value : update.value;
      },
    },
  } as unknown as PrismaClient;
  const successful = result({ checkedAt: '2026-08-14T05:00:00.000Z' });
  await checkRagicHealth({ force: true, client, probe: async () => successful });

  const failed = result({
    ok: false,
    status: 'dns_error',
    checkedAt: '2026-08-14T06:00:00.000Z',
    lastSuccessAt: null,
    statusCode: null,
    error: 'getaddrinfo ENOTFOUND fdtw.app',
  });
  const current = await checkRagicHealth({ force: true, client, probe: async () => failed });

  assert.equal(current.lastSuccessAt, successful.checkedAt);
  assert.deepEqual(parseRagicHealthResult(storedValue), current);
});

test('maintenance 立即讀取持久化狀態，Ragic 探測改在背景刷新', async () => {
  const persisted = result({ checkedAt: '2026-08-14T04:00:00.000Z' });
  const client = {
    appSetting: {
      findUnique: async () => ({ value: persisted }),
    },
  } as unknown as PrismaClient;
  let refreshStarted = false;
  let completeRefresh = () => {};
  const refreshPending = new Promise<void>((resolve) => {
    completeRefresh = resolve;
  });

  const snapshot = await getRagicHealthSnapshot({
    client,
    refresh: async () => {
      refreshStarted = true;
      await refreshPending;
      return result({ checkedAt: '2026-08-14T05:00:00.000Z' });
    },
  });

  assert.deepEqual(snapshot, persisted);
  assert.equal(refreshStarted, true);
  completeRefresh();
});
