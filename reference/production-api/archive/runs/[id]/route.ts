import { type NextRequest } from 'next/server';
import { readArchiveRun } from '@/lib/archive/browser-query';
import { archiveResponse } from '@/lib/archive/browser-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return archiveResponse(async () => readArchiveRun((await context.params).id));
}
