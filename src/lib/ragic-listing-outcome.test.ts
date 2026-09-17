import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchRagicListing, parseRagicResponseText } from './ragic-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Ragic response telemetry 以 UTF-8 bytes 計算並保留 JSON 資料', () => {
  const text = JSON.stringify({ 1: { 1006973: '料號-A' } });
  const parsed = parseRagicResponseText(text);

  assert.deepEqual(parsed.data, { 1: { 1006973: '料號-A' } });
  assert.equal(parsed.bytes, new TextEncoder().encode(text).byteLength);
  assert.ok(parsed.bytes > text.length);
  assert.ok(parsed.parseMs >= 0);
});

test('Ragic listing 收到 HTTP 200 + ERROR 時必須失敗，不得誤判為空資料', async () => {
  globalThis.fetch = async () => Response.json({
    status: 'ERROR',
    code: 106,
    msg: 'This sheet is access right protected.',
  });

  await assert.rejects(
    () => fetchRagicListing({ path: '/default/d11mrp/4', baseUrl: 'https://example.test' }),
    /Ragic API error 106: This sheet is access right protected\./,
  );
});

test('Ragic listing 的合法空物件仍回傳空陣列', async () => {
  globalThis.fetch = async () => Response.json({});

  const records = await fetchRagicListing({
    path: '/default/d11mrp/4',
    baseUrl: 'https://example.test',
  });

  assert.deepEqual(records, []);
});

test('Ragic listing 依自訂 page size 續抓下一頁', async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url.toString());
    const offset = Number(url.searchParams.get('offset') || 0);
    if (offset === 0) {
      return Response.json(Object.fromEntries(
        Array.from({ length: 2000 }, (_, index) => [
          String(index + 1),
          { 1006973: `PART-${index + 1}` },
        ]),
      ));
    }
    return Response.json({
      2001: { 1006973: 'PART-2001' },
    });
  };

  const records = await fetchRagicListing({
    path: '/default/e6mrp/3',
    baseUrl: 'https://example.test',
    limit: 2000,
  });

  assert.equal(records.length, 2001);
  assert.equal(requestedUrls.length, 2);
  assert.equal(new URL(requestedUrls[0]).searchParams.get('limit'), '2000');
  assert.equal(new URL(requestedUrls[0]).searchParams.get('offset'), null);
  assert.equal(new URL(requestedUrls[1]).searchParams.get('offset'), '2000');
});

test('Ragic full response 可指定欄位並排除子表 payload', async () => {
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({
      42: {
        1005345: 'TEST-V01',
        1028374: '120',
      },
    });
  };

  const records = await fetchRagicListing({
    path: '/default/g6mrp/1',
    baseUrl: 'https://example.test',
    listing: false,
    includeSubtables: false,
    fetchDomainIds: ['1005345', '1028374'],
  });

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('listing'), null);
  assert.equal(url.searchParams.get('subtables'), '0');
  assert.deepEqual(url.searchParams.getAll('fetchDomainIds'), ['1005345', '1028374']);
  assert.deepEqual(records, [{
    _ragic_id: '42',
    1005345: 'TEST-V01',
    1028374: '120',
  }]);
});
