import { ArchiveReportCache } from './report-cache';
import type { ArchiveRunPage } from './browser-contract';

// Version discovery changes as imports finish; do not use the immutable report TTL.
export const archiveRunListCache = new ArchiveReportCache(20, 1024 * 1024, 30_000);

export function archiveRunListUrl(q: string, page: number) {
  return `/api/archive/runs?${new URLSearchParams({ q, page: String(page) })}`;
}

export function isArchiveRunListUrl(url: string) {
  return url.startsWith('/api/archive/runs?');
}

export function validateArchiveRunPage(body: ArchiveRunPage, url: string) {
  const page = Number(new URLSearchParams(url.split('?')[1]).get('page') ?? '1');
  if (body.page !== page || body.pageSize !== 50 || !Number.isSafeInteger(body.total)
    || body.total < 0 || !Array.isArray(body.runs) || body.runs.length > 50) {
    throw new Error('歷史版本清單回應不一致');
  }
}

export async function prefetchArchiveRunPage(url: string, signal: AbortSignal) {
  if (archiveRunListCache.peek(url) !== undefined) return;
  try {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json();
    validateArchiveRunPage(body, url);
    if (!signal.aborted) archiveRunListCache.set(url, body);
  } catch { /* Foreground navigation retains its own loading/error/retry path. */ }
}
