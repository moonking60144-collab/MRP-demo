import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  BOOTSTRAP_HYDRATED_EVENT,
  BOOTSTRAP_RECOVERY_SCRIPT,
  BOOTSTRAP_RECOVERY_STORAGE_KEY,
  clearBootstrapRecoveryAttempts,
  getBootstrapRecoveryAction,
  isChunkLoadError,
  readBootstrapRecoveryAttempts,
  writeBootstrapRecoveryAttempts,
} from './bootstrap-recovery';

function createScriptHarness(initialAttempts?: string, storageDenied = false) {
  const storage = new Map<string, string>();
  if (initialAttempts !== undefined) storage.set(BOOTSTRAP_RECOVERY_STORAGE_KEY, initialAttempts);

  let scheduled: (() => void) | undefined;
  let reloads = 0;
  let fallbackVisible = false;
  const windowListeners = new Map<string, () => void>();

  const context = {
    window: {
      addEventListener: (name: string, listener: () => void) => windowListeners.set(name, listener),
      clearTimeout: () => undefined,
      location: { reload: () => { reloads += 1; } },
      sessionStorage: {
        getItem: (key: string) => {
          if (storageDenied) throw new Error('SecurityError');
          return storage.get(key) ?? null;
        },
        removeItem: (key: string) => {
          if (storageDenied) throw new Error('SecurityError');
          return storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          if (storageDenied) throw new Error('SecurityError');
          storage.set(key, value);
        },
      },
      setTimeout: (callback: () => void) => {
        scheduled = callback;
        return 1;
      },
    },
    document: {
      addEventListener: () => undefined,
      documentElement: { dataset: {} as Record<string, string> },
      getElementById: () => ({
        classList: {
          add: () => { fallbackVisible = false; },
          remove: () => { fallbackVisible = true; },
        },
      }),
    },
  };

  vm.runInNewContext(BOOTSTRAP_RECOVERY_SCRIPT, context);
  return {
    fireHydrated: () => windowListeners.get(BOOTSTRAP_HYDRATED_EVENT)?.(),
    getAttempts: () => storage.get(BOOTSTRAP_RECOVERY_STORAGE_KEY),
    getFallbackShown: () => fallbackVisible,
    getReloads: () => reloads,
    runTimer: () => scheduled?.(),
  };
}

test('bootstrap 第一次未 hydration 時只自動重載一次', () => {
  const harness = createScriptHarness();
  harness.runTimer();

  assert.equal(harness.getReloads(), 1);
  assert.equal(harness.getAttempts(), '1');
  assert.equal(harness.getFallbackShown(), false);
});

test('bootstrap 第二次仍失敗時停止重載並顯示錯誤', () => {
  const harness = createScriptHarness('1');
  harness.runTimer();

  assert.equal(harness.getReloads(), 0);
  assert.equal(harness.getAttempts(), undefined);
  assert.equal(harness.getFallbackShown(), true);
});

test('hydration 成功會清除重載狀態且不再重載', () => {
  const harness = createScriptHarness('1');
  harness.fireHydrated();

  assert.equal(harness.getAttempts(), undefined);
  assert.equal(harness.getReloads(), 0);
});

test('錯誤遮罩顯示後才 hydration 仍會立即關閉遮罩', () => {
  const harness = createScriptHarness('1');
  harness.runTimer();
  assert.equal(harness.getFallbackShown(), true);

  harness.fireHydrated();
  assert.equal(harness.getFallbackShown(), false);
});

test('sessionStorage 被拒絕時不重載迴圈並顯示手動恢復畫面', () => {
  const harness = createScriptHarness(undefined, true);

  assert.doesNotThrow(() => harness.runTimer());
  assert.equal(harness.getReloads(), 0);
  assert.equal(harness.getFallbackShown(), true);
  assert.doesNotThrow(() => harness.fireHydrated());
  assert.equal(harness.getFallbackShown(), false);
});

test('client recovery helpers 遇到 sessionStorage SecurityError 不向外拋錯', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: () => { throw new Error('SecurityError'); },
        removeItem: () => { throw new Error('SecurityError'); },
        setItem: () => { throw new Error('SecurityError'); },
      },
    },
  });

  try {
    assert.equal(readBootstrapRecoveryAttempts(), null);
    assert.equal(writeBootstrapRecoveryAttempts(1), false);
    assert.doesNotThrow(() => clearBootstrapRecoveryAttempts());
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('只把 chunk 載入錯誤分類為可自動恢復', () => {
  const chunkError = new Error('Loading chunk app/layout failed.');
  chunkError.name = 'ChunkLoadError';

  assert.equal(isChunkLoadError(chunkError), true);
  assert.equal(isChunkLoadError(new Error('資料庫連線失敗')), false);
  assert.equal(getBootstrapRecoveryAction(0), 'reload');
  assert.equal(getBootstrapRecoveryAction(1), 'show_error');
});
