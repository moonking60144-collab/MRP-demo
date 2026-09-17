import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createRagicRecord,
  executeRagicActionButton,
  RagicActionButtonError,
  RagicCreateError,
  RagicUpdateError,
  updateRagicRecord,
} from './ragic-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function expectOutcome(status: number, outcome: 'definite_failure' | 'unknown') {
  globalThis.fetch = async () => new Response('failed', { status });
  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (err) => err instanceof RagicCreateError && err.outcome === outcome,
  );
}

test('轉單 POST 收到 4xx 時判定為明確失敗，可安全重試', async () => {
  await expectOutcome(400, 'definite_failure');
});

test('轉單 POST 收到 HTTP 402 + code 203 時結果不確定，必須鎖住重試', async () => {
  globalThis.fetch = async () => Response.json(
    { status: 'ERROR', code: 203, msg: 'POST request did not finish' },
    { status: 402 },
  );
  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (err) => err instanceof RagicCreateError && err.outcome === 'unknown',
  );
});

test('轉單 POST 收到 HTTP 200 + ERROR code 203 時結果不確定，必須鎖住重試', async () => {
  globalThis.fetch = async () => Response.json({
    status: 'ERROR',
    code: 203,
    msg: 'POST request did not finish',
  });
  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (err) => err instanceof RagicCreateError && err.outcome === 'unknown',
  );
});

test('轉單 POST 收到明確的認證錯誤時維持可安全重試', async () => {
  globalThis.fetch = async () => Response.json(
    { status: 'ERROR', code: 304, msg: 'Invalid API key' },
    { status: 402 },
  );
  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (err) => err instanceof RagicCreateError && err.outcome === 'definite_failure',
  );
});

test('轉單 POST 收到 5xx 時結果不確定，必須鎖住重試', async () => {
  await expectOutcome(504, 'unknown');
});

test('轉單 POST 連線中斷時結果不確定，必須鎖住重試', async () => {
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (err) => err instanceof RagicCreateError && err.outcome === 'unknown',
  );
});

test('轉單 POST 連線失敗會保留底層網路原因', async () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND fdtw.app'), { code: 'ENOTFOUND' });
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause });
  };

  await assert.rejects(
    () => createRagicRecord('/default/d4/10', { field: 'value' }),
    (error) => error instanceof RagicCreateError
      && error.outcome === 'unknown'
      && error.message.includes('ENOTFOUND')
      && error.message.includes('fdtw.app'),
  );
});

test('轉單 POST 明示 SUCCESS 時，即使沒有 record id 仍宣告成功', async () => {
  globalThis.fetch = async () => Response.json({ status: 'SUCCESS' });
  const result = await createRagicRecord('/default/d4/10', { field: 'value' });
  assert.equal(result.id, null);
  assert.deepEqual(result.rawResponse, { status: 'SUCCESS' });
});

test('動作按鈕用單筆 Form [10] record + bId=92 執行', async () => {
  let calledUrl = '';
  let calledMethod = '';
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledMethod = String(init?.method);
    return Response.json({ status: 'SUCCESS', msg: 'Action completed.' });
  };

  const result = await executeRagicActionButton('/default/d4/10', '5637', '92');
  const url = new URL(calledUrl);
  assert.equal(calledMethod, 'POST');
  assert.equal(url.pathname, '/default/d4/10/5637');
  assert.equal(url.searchParams.get('bId'), '92');
  assert.equal(result.status, 'SUCCESS');
});

test('動作按鈕 POST 連線中斷時不自動重送', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('socket hang up');
  };

  await assert.rejects(
    () => executeRagicActionButton('/default/d4/10', '5637', '92'),
    (err) => err instanceof RagicActionButtonError && /結果不明/.test(err.message),
  );
  assert.equal(calls, 1);
});

test('動作按鈕收到 HTTP 403 時是明確失敗，可修正權限後重試', async () => {
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });

  await assert.rejects(
    () => executeRagicActionButton('/default/d4/10', '5637', '92'),
    (err) => err instanceof RagicActionButtonError
      && err.outcome === 'definite_failure'
      && err.status === 403,
  );
});

test('動作按鈕收到 Ragic code 106 時是明確失敗', async () => {
  globalThis.fetch = async () => Response.json({
    status: 'ERROR',
    code: 106,
    msg: 'No access right',
  });

  await assert.rejects(
    () => executeRagicActionButton('/default/d4/10', '5637', '92'),
    (err) => err instanceof RagicActionButtonError
      && err.outcome === 'definite_failure'
      && err.code === 106,
  );
});

test('動作按鈕收到 HTTP 402 + code 203 時結果不明，必須鎖住重試', async () => {
  globalThis.fetch = async () => Response.json(
    { status: 'ERROR', code: 203, msg: 'POST request did not finish' },
    { status: 402 },
  );

  await assert.rejects(
    () => executeRagicActionButton('/default/d4/10', '5637', '92'),
    (err) => err instanceof RagicActionButtonError
      && err.outcome === 'unknown'
      && err.code === 203,
  );
});

test('動作按鈕收到 HTTP 5xx 時結果不明，必須鎖住重試', async () => {
  globalThis.fetch = async () => new Response('Server Error', { status: 503 });

  await assert.rejects(
    () => executeRagicActionButton('/default/d4/10', '5637', '92'),
    (err) => err instanceof RagicActionButtonError
      && err.outcome === 'unknown'
      && err.status === 503,
  );
});

test('單筆更新只 PATCH 指定欄位並啟用 Ragic record lock 檢查', async () => {
  let calledUrl = '';
  let calledMethod = '';
  let calledBody = '';
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledMethod = String(init?.method);
    calledBody = String(init?.body);
    return Response.json({ status: 'SUCCESS' });
  };

  const result = await updateRagicRecord(
    '/default/g6mrp/1',
    '2401',
    { '1037338': 26 },
  );
  const url = new URL(calledUrl);

  assert.equal(calledMethod, 'PATCH');
  assert.equal(url.pathname, '/default/g6mrp/1/2401');
  assert.equal(url.searchParams.get('checkLock'), 'true');
  assert.equal(url.searchParams.get('naming'), 'EID');
  assert.deepEqual(JSON.parse(calledBody), { '1037338': 26 });
  assert.deepEqual(result.rawResponse, { status: 'SUCCESS' });
});

test('單筆更新連線中斷時不自動重送', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('socket hang up');
  };

  await assert.rejects(
    () => updateRagicRecord('/default/g6mrp/1', '2401', { '1037338': 12 }),
    (error) => error instanceof RagicUpdateError && error.outcome === 'unknown',
  );
  assert.equal(calls, 1);
});

test('單筆更新收到明確權限錯誤時回報 definite_failure', async () => {
  globalThis.fetch = async () => Response.json(
    { status: 'ERROR', code: 304, msg: 'Invalid API key' },
    { status: 402 },
  );

  await assert.rejects(
    () => updateRagicRecord('/default/g6mrp/1', '2401', { '1037338': '' }),
    (error) => error instanceof RagicUpdateError
      && error.outcome === 'definite_failure'
      && error.code === 304,
  );
});
