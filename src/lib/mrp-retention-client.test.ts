import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveMissingSelectedRunFallback,
  resolveRetentionFallbackRunId,
} from './mrp-retention-client';

test('只有選取中的 Run 確實被 retention 刪除才回退最新版本', () => {
  assert.equal(resolveRetentionFallbackRunId(8, 139, [8]), 139);
  assert.equal(resolveRetentionFallbackRunId(9, 139, [8]), null);
  assert.equal(resolveRetentionFallbackRunId(8, null, [8]), null);
  assert.equal(resolveRetentionFallbackRunId(null, 139, [8]), null);
});


test('SSE 重連只在精確確認原選取 Run 不存在時回退最新版本', async () => {
  assert.equal(
    await resolveMissingSelectedRunFallback(8, 139, async () => false),
    139,
  );
  assert.equal(
    await resolveMissingSelectedRunFallback(8, 139, async () => true),
    null,
  );

  let existenceChecks = 0;
  assert.equal(
    await resolveMissingSelectedRunFallback(139, 139, async () => {
      existenceChecks += 1;
      return true;
    }),
    null,
  );
  assert.equal(existenceChecks, 0);
});
