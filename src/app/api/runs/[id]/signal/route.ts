import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return forwardDemo('POST', 'runs/[id]/signal', request, context);
}
