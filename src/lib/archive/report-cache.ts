import { ARCHIVE_VIEWS } from './browser-contract';

interface Entry { data: unknown; expires: number; size: number }

/** Payload budget, not a claim about the JavaScript engine's total heap usage. */
export class ArchiveReportCache {
  private entries = new Map<string, Entry>();
  private size = 0;
  constructor(private maxEntries = 32, private maxBytes = 16 * 1024 * 1024, private ttl = 5 * 60_000) {}

  peek<T>(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expires > now ? entry.data as T : undefined;
  }

  get<T>(key: string, now = Date.now()): T | undefined {
    const data = this.peek<T>(key, now);
    if (data === undefined) { this.delete(key); return undefined; }
    const entry = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return data;
  }

  set(key: string, data: unknown, now = Date.now()): void {
    this.delete(key);
    const size = JSON.stringify(data).length * 2;
    if (size > this.maxBytes) return;
    this.entries.set(key, { data, size, expires: now + this.ttl });
    this.size += size;
    while (this.entries.size > this.maxEntries || this.size > this.maxBytes) this.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.size -= entry.size;
    this.entries.delete(key);
  }
}

export const archiveReportCache = new ArchiveReportCache();

export function isArchiveReportUrl(url: string): boolean {
  const match = /^\/api\/archive\/runs\/[0-9a-f-]{36}\/([^/?]+)(?:\?|$)/i.exec(url);
  return Boolean(match && (match[1] === 'fg-report' || match[1] === 'weekly-report' || Object.hasOwn(ARCHIVE_VIEWS, match[1])));
}
