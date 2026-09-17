/**
 * Per-run log capture.
 *
 * Wraps each MRP run in an AsyncLocalStorage context that owns an in-memory
 * ring buffer of {ts, level, msg} entries. `runLog.{info,warn,error}` writes
 * to both the console (so docker/pm2 logs still show everything) AND the
 * buffer; a background flusher persists the buffer to mrp_run.logs every 2s
 * so the UI can render it live via the existing /api/runs/:id polling.
 *
 * Why: production deployments don't always have terminal access, and a hung
 * Source API call needs to surface its diagnostic trail to the operator
 * looking at the 執行紀錄 panel — not to the docker stdout that nobody reads.
 */
import { AsyncLocalStorage } from 'async_hooks';
import prisma from './db';

export interface RunLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  seq?: number;
}

interface LogContext {
  runId: number;
  buffer: RunLogEntry[];
  dirty: boolean;
  nextSeq: number;
}

/** Cap to keep the JSONB column small even on very long runs. */
const MAX_LOG_ENTRIES = 1000;
/** Flush interval — short enough that a 6-min stall surfaces partial logs. */
const FLUSH_INTERVAL_MS = 2_000;

const storage = new AsyncLocalStorage<LogContext>();

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function append(level: RunLogEntry['level'], args: unknown[]): void {
  // Always pass through to console so terminal/docker logs are unaffected
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);

  const ctx = storage.getStore();
  if (!ctx) return;

  ctx.buffer.push({ ts: Date.now(), level, msg: format(args), seq: ctx.nextSeq++ });
  // Ring buffer: drop oldest when capped
  if (ctx.buffer.length > MAX_LOG_ENTRIES) {
    ctx.buffer.splice(0, ctx.buffer.length - MAX_LOG_ENTRIES);
  }
  ctx.dirty = true;
}

export const runLog = {
  info: (...args: unknown[]) => append('info', args),
  warn: (...args: unknown[]) => append('warn', args),
  error: (...args: unknown[]) => append('error', args),
};

/**
 * Run `fn` inside a context that captures all `runLog.*` calls and flushes
 * them to mrp_run.logs every 2s plus once at the end. Safe to nest — inner
 * calls join the outer context (same runId) implicitly via AsyncLocalStorage.
 */
export async function withRunLogging<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  // Seed the buffer with whatever the run already has on disk so a NESTED
  // wrapper (sync phase wraps once, calc phases wrap again) accumulates
  // instead of replacing each previous phase's logs. Without this, the
  // calc-phase wrapper would start with an empty buffer and the first
  // flush would overwrite the entire sync log section in mrp_run.logs.
  let seedBuffer: RunLogEntry[] = [];
  try {
    const existing = await prisma.mrpRun.findUnique({
      where: { id: runId },
      select: { logs: true },
    });
    if (Array.isArray(existing?.logs)) {
      seedBuffer = (existing!.logs as unknown[]).filter(
        (e): e is RunLogEntry =>
          !!e && typeof e === 'object' &&
          typeof (e as RunLogEntry).ts === 'number' &&
          typeof (e as RunLogEntry).msg === 'string',
      );
      let lastSeq = 0;
      seedBuffer = seedBuffer.map((entry) => {
        const candidateSeq = Number(entry.seq);
        const seq = Number.isInteger(candidateSeq) && candidateSeq > lastSeq
          ? candidateSeq
          : lastSeq + 1;
        lastSeq = seq;
        return { ...entry, seq };
      });
      // Trim if the prior phase already filled the cap — keep the most
      // recent entries so we still have headroom for new ones.
      if (seedBuffer.length > MAX_LOG_ENTRIES - 100) {
        seedBuffer = seedBuffer.slice(-(MAX_LOG_ENTRIES - 100));
      }
    }
  } catch {
    // First-ever flush for a brand-new run record may race with the create
    // — fall back to empty buffer. We'll accumulate from here.
  }

  const ctx: LogContext = {
    runId,
    buffer: seedBuffer,
    dirty: false,
    nextSeq: (seedBuffer.at(-1)?.seq ?? 0) + 1,
  };

  const flush = async () => {
    if (!ctx.dirty) return;
    ctx.dirty = false;
    const snapshot = ctx.buffer.slice();
    try {
      await prisma.mrpRun.update({
        where: { id: runId },
        data: { logs: snapshot as object },
      });
    } catch {
      // Best-effort: if the DB is briefly unavailable we'd rather drop a flush
      // than crash the run. Next tick will retry with the same (still-dirty=false
      // here, so re-mark) buffer. We don't re-mark to avoid retry storms.
    }
  };

  const flusher = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  try {
    return await storage.run(ctx, fn);
  } finally {
    clearInterval(flusher);
    // Final flush guarantees the last few lines (often the error itself) land
    ctx.dirty = true;
    await flush();
  }
}
