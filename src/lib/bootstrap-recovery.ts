export const BOOTSTRAP_RECOVERY_STORAGE_KEY = 'demo-mrp:bootstrap-reload-attempts';
export const BOOTSTRAP_HYDRATED_EVENT = 'demo-mrp:hydrated';
export const BOOTSTRAP_RECOVERY_TIMEOUT_MS = 8_000;
export const BOOTSTRAP_RECOVERY_MAX_RELOADS = 1;

export type BootstrapRecoveryAction = 'reload' | 'show_error';

export function getBootstrapRecoveryAction(attempts: number): BootstrapRecoveryAction {
  return attempts < BOOTSTRAP_RECOVERY_MAX_RELOADS ? 'reload' : 'show_error';
}

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ChunkLoadError' || /ChunkLoadError|Loading chunk .* failed/i.test(error.message);
}

export function readBootstrapRecoveryAttempts(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const attempts = Number(window.sessionStorage.getItem(BOOTSTRAP_RECOVERY_STORAGE_KEY) || '0');
    return Number.isFinite(attempts) && attempts >= 0 ? attempts : 0;
  } catch {
    return null;
  }
}

export function writeBootstrapRecoveryAttempts(attempts: number): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.sessionStorage.setItem(BOOTSTRAP_RECOVERY_STORAGE_KEY, String(attempts));
    return true;
  } catch {
    return false;
  }
}

export function clearBootstrapRecoveryAttempts(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(BOOTSTRAP_RECOVERY_STORAGE_KEY);
  } catch {
    // sessionStorage may be blocked by browser policy.
  }
}

export const BOOTSTRAP_RECOVERY_SCRIPT = `
(function () {
  var key = ${JSON.stringify(BOOTSTRAP_RECOVERY_STORAGE_KEY)};
  var hydratedEvent = ${JSON.stringify(BOOTSTRAP_HYDRATED_EVENT)};
  var timeoutMs = ${BOOTSTRAP_RECOVERY_TIMEOUT_MS};
  var maxReloads = ${BOOTSTRAP_RECOVERY_MAX_RELOADS};
  var timerId;

  function hideFallback() {
    var fallback = document.getElementById('mrp-bootstrap-error');
    if (fallback) fallback.classList.add('hidden');
  }

  function showFallback() {
    var fallback = document.getElementById('mrp-bootstrap-error');
    if (fallback) fallback.classList.remove('hidden');
  }

  function readAttempts() {
    try {
      var attempts = Number(window.sessionStorage.getItem(key) || '0');
      return { available: true, value: isFinite(attempts) && attempts >= 0 ? attempts : 0 };
    } catch (error) {
      return { available: false, value: maxReloads };
    }
  }

  function writeAttempts(attempts) {
    try {
      window.sessionStorage.setItem(key, String(attempts));
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeAttempts() {
    try {
      window.sessionStorage.removeItem(key);
    } catch (error) {
    }
  }

  function clearRecovery() {
    window.clearTimeout(timerId);
    removeAttempts();
    hideFallback();
  }

  window.addEventListener(hydratedEvent, clearRecovery, { once: true });
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.closest && target.closest('#mrp-bootstrap-reload')) {
      removeAttempts();
      window.location.reload();
    }
  });

  timerId = window.setTimeout(function () {
    if (document.documentElement.dataset.mrpHydrated === 'true') {
      clearRecovery();
      return;
    }

    var recovery = readAttempts();
    if (recovery.available && recovery.value < maxReloads && writeAttempts(recovery.value + 1)) {
      window.location.reload();
      return;
    }

    removeAttempts();
    showFallback();
  }, timeoutMs);
})();
`;
