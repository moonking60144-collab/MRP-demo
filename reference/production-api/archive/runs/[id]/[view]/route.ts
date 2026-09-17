import { type NextRequest } from 'next/server';
import { readArchiveRows } from '@/lib/archive/browser-query';
import { archiveResponse } from '@/lib/archive/browser-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; view: string }> }) {
  return archiveResponse(async () => {
    const { id, view } = await context.params;
    return readArchiveRows(id, view, request.nextUrl.searchParams);
  });
}
