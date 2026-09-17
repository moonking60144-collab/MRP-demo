import type { NextRequest } from 'next/server';
import { forwardDemo } from '@/lib/demo/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return forwardDemo('PATCH', 'table-presets/[id]', request, context);
}

export function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return forwardDemo('DELETE', 'table-presets/[id]', request, context);
}
