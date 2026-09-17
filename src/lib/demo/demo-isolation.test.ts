import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { GET as getSettings } from '@/app/api/settings/route';
import { GET as getPeriods } from '@/app/api/fg-monthly/[partVersion]/periods/route';
import { getDbUrl, createClient } from '../db';
import { config } from '../config';
import { registerDemoIsolation } from './isolation';
import { buildRagicRecordUrl } from '../ragic-record-links';
import { dataset } from './data';
import { prepareDemo } from './run-control';
test.before(async () => prepareDemo());

test('繼承正式 env 也無法建立真實 DB/Ragic/SMTP 連線', () => {
  assert.equal(getDbUrl('local'), undefined);
  assert.equal(getDbUrl('docker'), undefined);
  assert.equal(getDbUrl('remote'), undefined);
  const client = createClient('postgresql://should-never-connect.invalid/company');
  assert.throws(() => client.$queryRaw, /Demo 禁止連接/);
  assert.equal(config.databaseUrl, '');
  assert.equal(config.ragicApiKey, '');
  assert.equal(config.smtp.host, '');
  assert.equal(config.smtp.pass, '');
  assert.equal(config.ragicBaseUrl, 'https://demo.invalid');
});

test('原 API 路由永久改送 demo，不由 env 或請求參數解除', () => {
  const configText = readFileSync(join(process.cwd(), 'next.config.js'), 'utf8');
  assert.match(configText, /beforeFiles:.*source: '\/api\/:path\*'.*destination: '\/demo-api\/:path\*'/);
  assert.equal(existsSync(join(process.cwd(), '.env')), false);
  assert.match(readFileSync(join(process.cwd(), 'src/instrumentation.ts'), 'utf8'), /registerDemoIsolation/);
  assert.doesNotMatch(readFileSync(join(process.cwd(), 'src/instrumentation.ts'), 'utf8'), /require\('\.\/instrumentation-node'\)/);
});

test('每個可執行 API 都是固定 demo 入口，原 handler 只保留在 reference', () => {
  let count = 0;
  function check(directory: string, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const reference = join(relative, entry.name);
      if (entry.isDirectory()) { check(path, reference); continue; }
      assert.equal(entry.name, 'route.ts');
      const text = readFileSync(path, 'utf8');
      assert.match(text, /import \{ forwardDemo \} from '@\/lib\/demo\/forward'/);
      assert.doesNotMatch(text, /from ['"].*(?:db|ragic|orchestrator|reference)/);
      assert.ok(existsSync(join(process.cwd(), 'reference/production-api', reference)));
      const original = readFileSync(join(process.cwd(), 'reference/production-api', reference), 'utf8');
      const methods = (source: string) => [...source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]).sort();
      assert.deepEqual(methods(text), methods(original), reference);
      count++;
    }
  }
  check(join(process.cwd(), 'src/app/api'));
  assert.equal(count, 56);
});

test('編碼 API 前綴仍使用固定 handler，動態參數保留資料身份', async () => {
  for (const prefix of ['/api', '/%61pi', '/a%70i']) {
    const response = await getSettings(new NextRequest(`http://127.0.0.1:3142${prefix}/settings`));
    assert.equal(response.headers.get('X-MRP-Data'), 'synthetic');
    assert.equal((await response.json()).connection.dbVersion, 'Interview demo・不連資料庫');
  }
  const partVersion = String(dataset(3).fg[0].partVersion);
  const response = await getPeriods(new NextRequest('http://127.0.0.1:3142/%61pi/fg-monthly/ignored/periods?runId=3'), { params: Promise.resolve({ partVersion }) });
  assert.equal(response.headers.get('X-MRP-Data'), 'synthetic');
  assert.deepEqual((await response.json()).periods, dataset(3).fgPeriods[partVersion]);
});

test('Ragic 連結只導向本機合成紀錄', () => {
  const link = buildRagicRecordUrl('order', 'DEMO-123');
  assert.ok(link?.startsWith('/demo-record?'));
  assert.equal(buildRagicRecordUrl('order', null), null);
});

test('合成報表全部具有同 Run/期間/資料識別，庫存分倉守恆', () => {
  for (const id of [1, 2, 3]) {
    const data = dataset(id);
    assert.equal(data.fg.filter((row) => !row.isAggregated).length, 48);
    assert.equal(data.cw.length, 36);
    for (const row of data.fg.filter((row) => !row.isAggregated)) {
      assert.equal(row.mrpRunId, id);
      assert.match(String(row.partVersion), /^(XA|XB)-PRODUCT-/);
      assert.equal(Number(row.wfgStockPc) + Number(row.ye1StockPc), row.currentStockPc);
      assert.equal(data.fgPeriods[String(row.partVersion)].length, 12);
      assert.equal(data.salesPeriods[String(row.partVersion)].length, 13);
    }
    for (const row of data.cw) { assert.match(String(row.materialPartNo), /^DEMO-/); assert.equal(data.cwPeriods[String(row.materialPartNo)].length, 28); }
  }
  assert.throws(() => dataset(99999), /找不到合成版本/);
});

test('出站 HTTP 的公司網址與亂數 negative control 都在 transport 前被擋', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try {
    process.env.DATABASE_URL_REMOTE = 'postgresql://should-never-connect.invalid/company';
    process.env.SMTP_HOST = 'should-never-connect.invalid';
    registerDemoIsolation();
    assert.equal(process.env.DATABASE_URL_REMOTE, undefined);
    assert.equal(process.env.SMTP_HOST, undefined);
    for (const url of ['https://fdtw.app', 'https://not-a-real-company.invalid', 'http://127.0.0.1:8080']) await assert.rejects(fetch(url), /禁止對外/);
    assert.equal(calls, 0);
    await fetch('http://127.0.0.1:3142/api/dashboard');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = saved; }
});
