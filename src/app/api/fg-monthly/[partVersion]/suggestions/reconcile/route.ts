import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest, context: { params: Promise<{ partVersion: string }> }) {
  return forwardDemo('POST', 'fg-monthly/[partVersion]/suggestions/reconcile', request, context);
}
