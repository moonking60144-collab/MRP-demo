import assert from 'node:assert/strict';
import test from 'node:test';

import { nextAppVersion, parseAppVersion } from './app-version';

test('App patch 使用雙位數，99 才向 minor 進位', () => {
  assert.equal(nextAppVersion('2.1.3'), '2.1.4');
  assert.equal(nextAppVersion('2.1.98'), '2.1.99');
  assert.equal(nextAppVersion('2.1.99'), '2.2.0');
});

test('minor 到 9 且 patch 到 99 時向 major 進位', () => {
  assert.equal(nextAppVersion('2.9.99'), '3.0.0');
  assert.equal(nextAppVersion('9.9.99'), '10.0.0');
  assert.equal(nextAppVersion('10.0.0'), '10.0.1');
});

test('App 版本拒絕超出契約的 minor、patch 與前導零', () => {
  assert.throws(() => parseAppVersion('2.10.0'), /minor/);
  assert.throws(() => parseAppVersion('2.1.100'), /patch/);
  assert.throws(() => parseAppVersion('02.1.3'), /格式無效/);
});
