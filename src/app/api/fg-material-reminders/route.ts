import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return forwardDemo('GET', 'fg-material-reminders', request);
}

export function POST(request: NextRequest) {
  return forwardDemo('POST', 'fg-material-reminders', request);
}
