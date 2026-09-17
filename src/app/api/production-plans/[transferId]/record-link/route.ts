import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest, context: { params: Promise<{ transferId: string }> }) {
  return forwardDemo('POST', 'production-plans/[transferId]/record-link', request, context);
}
