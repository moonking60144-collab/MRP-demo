export function boundedConcurrency(
  rawValue: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export async function mapWithBoundedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index]!, index);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    },
  );

  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
  return results;
}
