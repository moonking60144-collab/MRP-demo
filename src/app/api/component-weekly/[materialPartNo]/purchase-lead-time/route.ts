import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PATCH(request: NextRequest, context: { params: Promise<{ materialPartNo: string }> }) {
  return forwardDemo('PATCH', 'component-weekly/[materialPartNo]/purchase-lead-time', request, context);
}
