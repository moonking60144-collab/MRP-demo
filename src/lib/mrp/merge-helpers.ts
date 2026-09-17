import { PrismaClient } from '@prisma/client';
import { type DbMode, getAvailableClients } from '../db';

export interface DbSource {
  mode: DbMode;
  runVersionCode: string;
  runDate: string;
  runId: number;
}

export interface MergedQueryResult<T> {
  items: (T & { dbSource: DbMode })[];
  total: number;
  sources: DbSource[];
}

/**
 * Fetch the latest run's data from all available DBs, tag each item with its source,
 * and deduplicate by a natural key (latest runDate wins).
 */
export async function fetchMergedData<T extends Record<string, unknown>>(
  queryFn: (client: PrismaClient) => Promise<{
    items: T[];
    run: { id: number; versionCode: string; runDate: Date | string } | null;
  }>,
  keyFn: (item: T) => string,
): Promise<MergedQueryResult<T>> {
  const clients = await getAvailableClients();
  if (clients.length === 0) {
    return { items: [], total: 0, sources: [] };
  }

  // Query all DBs in parallel
  const settled = await Promise.allSettled(
    clients.map(async ({ mode, client }) => {
      const result = await queryFn(client);
      return { mode, ...result };
    }),
  );

  const sources: DbSource[] = [];
  const allItems: { item: T; dbSource: DbMode; runDate: Date }[] = [];

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { mode, items, run } = result.value;
    if (!run || items.length === 0) continue;

    const runDateObj = run.runDate instanceof Date ? run.runDate : new Date(run.runDate);
    const runDateStr = runDateObj.toISOString().split('T')[0];

    sources.push({
      mode,
      runVersionCode: run.versionCode,
      runDate: runDateStr,
      runId: run.id,
    });

    for (const item of items) {
      allItems.push({ item, dbSource: mode, runDate: runDateObj });
    }
  }

  // Deduplicate: group by natural key, keep latest runDate
  const deduped = new Map<string, { item: T; dbSource: DbMode; runDate: Date }>();
  for (const entry of allItems) {
    const key = keyFn(entry.item);
    const existing = deduped.get(key);
    if (!existing || entry.runDate > existing.runDate) {
      deduped.set(key, entry);
    }
  }

  const items = Array.from(deduped.values()).map(({ item, dbSource }) => ({
    ...item,
    dbSource,
  }));

  return { items, total: items.length, sources };
}

/**
 * Apply in-memory text search across specified fields.
 */
export function applySearch<T extends Record<string, unknown>>(
  items: T[],
  search: string,
  fields: string[],
): T[] {
  if (!search) return items;
  const lower = search.toLowerCase();
  return items.filter((item) =>
    fields.some((f) => {
      const val = item[f];
      return typeof val === 'string' && val.toLowerCase().includes(lower);
    }),
  );
}

/**
 * Apply in-memory sorting (multi-field).
 */
export function applySort<T extends Record<string, unknown>>(
  items: T[],
  sortFields: { key: string; dir: 'asc' | 'desc' }[],
): T[] {
  if (sortFields.length === 0) return items;
  return [...items].sort((a, b) => {
    for (const { key, dir } of sortFields) {
      const aVal = a[key];
      const bVal = b[key];
      if (aVal == null && bVal == null) continue;
      if (aVal == null) return dir === 'asc' ? -1 : 1;
      if (bVal == null) return dir === 'asc' ? 1 : -1;
      if (aVal < bVal) return dir === 'asc' ? -1 : 1;
      if (aVal > bVal) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

/**
 * Apply in-memory pagination.
 */
export function applyPagination<T>(items: T[], page: number, limit: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}
