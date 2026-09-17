import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return forwardDemo('GET', 'archive/runs/[id]/weekly-report', request, context);
}
