import { PrismaClient } from '@prisma/client';
import { calculationContext } from './demo/calculation-context';

export type DbMode = 'local' | 'docker' | 'remote';

const ALL_MODES: DbMode[] = ['local', 'docker', 'remote'];

export function isDbMode(value: unknown): value is DbMode {
  return typeof value === 'string' && ALL_MODES.includes(value as DbMode);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient;
  prismaDbMode: string;
  /** Cached clients for multi-DB merge queries */
  mergeClients: Map<DbMode, PrismaClient>;
  /** Serializes run-start and DB hot-switch critical sections. */
  runtimeDbControlTail?: Promise<void>;
};

export function createClient(url: string): PrismaClient {
  void url;
  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      if (property === '$disconnect') return async () => {};
      throw new Error('Demo 禁止連接真實資料庫；請使用合成資料介面。');
    },
  });
}

export function getDbUrl(mode: DbMode): string | undefined {
  void mode;
  return undefined;
}

function resolveDbUrl(): string {
  return '';
}

// Initialise on first load
if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = createClient(resolveDbUrl());
  globalForPrisma.prismaDbMode = 'local';
}
if (!globalForPrisma.mergeClients) {
  globalForPrisma.mergeClients = new Map();
}

export async function withRuntimeDbControl<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalForPrisma.runtimeDbControlTail ?? Promise.resolve();
  let release!: () => void;
  globalForPrisma.runtimeDbControlTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Hot-swap the Prisma client to a different database URL.
 * Called from the settings API — no server restart needed.
 */
export async function reconnectDb(url: string, mode: DbMode): Promise<void> {
  try { await globalForPrisma.prisma.$disconnect(); } catch { /* ignore */ }
  globalForPrisma.prisma = createClient(url);
  globalForPrisma.prismaDbMode = mode;
  // Clear merge cache since active DB changed
  await disconnectMergeClients();
}

/**
 * Get a PrismaClient for a specific DB mode (for merge/period queries).
 * Returns the active client if mode matches current, otherwise creates/reuses a cached client.
 */
export function getClientForMode(mode: DbMode): PrismaClient | null {
  if (mode === globalForPrisma.prismaDbMode) return globalForPrisma.prisma;
  const url = getDbUrl(mode);
  if (!url) return null;
  if (!globalForPrisma.mergeClients.has(mode)) {
    globalForPrisma.mergeClients.set(mode, createClient(url));
  }
  return globalForPrisma.mergeClients.get(mode)!;
}

/**
 * Get all available DB clients (connectivity-tested).
 * Used by merge queries to fetch data from all reachable DBs.
 */
export async function getAvailableClients(): Promise<{ mode: DbMode; client: PrismaClient }[]> {
  const results: { mode: DbMode; client: PrismaClient }[] = [];

  await Promise.allSettled(
    ALL_MODES.map(async (mode) => {
      const url = getDbUrl(mode);
      if (!url) return;
      const client = getClientForMode(mode);
      if (!client) return;
      try {
        await client.$queryRaw`SELECT 1`;
        results.push({ mode, client });
      } catch {
        // DB unreachable — skip silently
      }
    }),
  );

  return results;
}

/** Disconnect cached merge clients (call on settings change). */
export async function disconnectMergeClients(): Promise<void> {
  for (const [, client] of globalForPrisma.mergeClients) {
    try { await client.$disconnect(); } catch { /* ignore */ }
  }
  globalForPrisma.mergeClients.clear();
}

export function currentDbMode(): DbMode {
  return (globalForPrisma.prismaDbMode || 'local') as DbMode;
}

// Proxy forwards all access to the live globalForPrisma.prisma,
// so hot-swaps are transparent to every module that imported `prisma`.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const syntheticClient = calculationContext.getStore();
    if (syntheticClient) return (syntheticClient as unknown as Record<string | symbol, unknown>)[prop];
    return (globalForPrisma.prisma as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export default prisma;
