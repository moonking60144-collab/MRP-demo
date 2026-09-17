import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return forwardDemo('GET', 'fg-monthly/ignored-customers', request);
}

export function PUT(request: NextRequest) {
  return forwardDemo('PUT', 'fg-monthly/ignored-customers', request);
}
