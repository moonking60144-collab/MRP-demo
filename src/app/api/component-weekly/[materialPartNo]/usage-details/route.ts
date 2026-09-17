import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ materialPartNo: string }> }) {
  return forwardDemo('GET', 'component-weekly/[materialPartNo]/usage-details', request, context);
}
