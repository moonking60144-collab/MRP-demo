import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ partVersion: string }> }) {
  return forwardDemo('GET', 'fg-monthly/[partVersion]/sources', request, context);
}
