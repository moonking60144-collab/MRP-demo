import { NextResponse } from 'next/server';
import { checkDatabaseHealth } from '@/lib/db-health-server';

/**
 * GET /api/db-health — Check that all expected schemas and tables exist
 */
export async function GET() {
  const health = await checkDatabaseHealth();
  return NextResponse.json(health, { status: health.error ? 500 : 200 });
}
