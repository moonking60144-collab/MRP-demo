import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReportPage } from './use-report-page';

test('report page accepts a saved query identity and positive integer page', () => {
  assert.deepEqual(parseReportPage('{"context":"run:99/search:test","page":2}'), {
    context: 'run:99/search:test', page: 2,
  });
});

test('report page ignores missing, damaged and invalid session values', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}', '{"context":1,"page":2}']) {
    assert.equal(parseReportPage(raw), null);
  }
  for (const page of [-1, 0, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseReportPage(JSON.stringify({ context: 'test', page })), null);
  }
});
