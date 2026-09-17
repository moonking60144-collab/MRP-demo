type RunAttemptGlobal = {
  __mrpActiveAttemptRunIds?: Set<number>;
};

const attemptGlobal = globalThis as unknown as RunAttemptGlobal;
const activeAttemptRunIds = attemptGlobal.__mrpActiveAttemptRunIds
  ?? (attemptGlobal.__mrpActiveAttemptRunIds = new Set<number>());

export class PhaseTimeoutError extends Error {
  constructor(label: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${label} timed out after ${Math.round(timeoutMs / 60000)} min`, options);
    this.name = 'PhaseTimeoutError';
  }
}

export async function withRunAttempt<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  if (activeAttemptRunIds.has(runId)) {
    throw new Error(`MRP run #${runId} already has an active local attempt`);
  }

  activeAttemptRunIds.add(runId);
  try {
    return await fn();
  } finally {
    activeAttemptRunIds.delete(runId);
  }
}

export function getActiveLocalRunIds(): number[] {
  return [...activeAttemptRunIds];
}

type PromiseTuple<T extends readonly unknown[]> = {
  [K in keyof T]: PromiseLike<T[K]>;
};

export async function settleAllOrThrow<T extends readonly unknown[]>(
  promises: PromiseTuple<T>,
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;

  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

export async function withSettledTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  try {
    const value = await promise;
    if (timedOut) throw new PhaseTimeoutError(label, timeoutMs);
    return value;
  } catch (error) {
    if (timedOut && !(error instanceof PhaseTimeoutError)) {
      throw new PhaseTimeoutError(label, timeoutMs, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
