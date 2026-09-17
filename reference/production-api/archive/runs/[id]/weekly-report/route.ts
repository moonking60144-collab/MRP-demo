import { type NextRequest } from 'next/server';
import { readArchiveWeeklyReport } from '@/lib/archive/browser-query';
import { archiveResponse } from '@/lib/archive/browser-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return archiveResponse(async () => readArchiveWeeklyReport((await context.params).id, request.nextUrl.searchParams));
}
