import { type NextRequest } from 'next/server';
import { listArchiveRuns } from '@/lib/archive/browser-query';
import { archiveResponse } from '@/lib/archive/browser-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return archiveResponse(() => listArchiveRuns(request.nextUrl.searchParams));
}
