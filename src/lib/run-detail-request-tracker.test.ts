import assert from 'node:assert/strict';
import test from 'node:test';
import { RunDetailRequestTracker } from './run-detail-request-tracker';

test('Run 明細失效後，舊 request 不得覆蓋或清除新的 request', () => {
  const tracker = new RunDetailRequestTracker<string>();
  const oldRequest = Promise.resolve('old');
  const oldToken = tracker.capture(7);
  tracker.track(oldToken, oldRequest);

  tracker.invalidate(7);

  const newRequest = Promise.resolve('new');
  const newToken = tracker.capture(7);
  tracker.track(newToken, newRequest);

  assert.equal(tracker.isCurrent(oldToken), false);
  assert.equal(tracker.finish(oldToken), false);
  assert.equal(tracker.get(7), newRequest);
  assert.equal(tracker.isCurrent(newToken), true);
  assert.equal(tracker.finish(newToken), true);
  assert.equal(tracker.get(7), undefined);
});
