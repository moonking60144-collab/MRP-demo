import type { NextRequest } from 'next/server';
import { GET, POST, PUT, PATCH, DELETE } from '@/app/demo-api/[...path]/route';

type RouteContext = { params: Promise<Record<string, string>> };
export async function forwardDemo(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, request: NextRequest, context?: RouteContext) {
  const params = context ? await context.params : {};
  const path = route.split('/').map((segment) => segment.startsWith('[') ? params[segment.slice(1, -1)] ?? '' : segment);
  const handler = { GET, POST, PUT, PATCH, DELETE }[method];
  return handler(request, { params: Promise.resolve({ path }) });
}
