import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getClientForMode, isDbMode } from '@/lib/db';

/**
 * GET /api/component-weekly/[materialPartNo]/periods
 * Returns 28 weekly period rows for a specific material
 * Query params:
 *   mrpType: required — 'W', 'B', or 'D'
 *   runId: specific run
 *   dbSource?: 'local'|'docker'|'remote' — query a specific DB (for merge mode)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ materialPartNo: string }> },
) {
  try {
    const { materialPartNo } = await params;
    const url = req.nextUrl;
    const mrpType = url.searchParams.get('mrpType');

    if (!mrpType || !['W', 'B', 'D'].includes(mrpType)) {
      return NextResponse.json(
        { error: 'mrpType query param required (W, B, or D)' },
        { status: 400 },
      );
    }

    const runId = Number(url.searchParams.get('runId'));
    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'runId query param required' }, { status: 400 });
    }

    const dbSourceParam = url.searchParams.get('dbSource');
    if (dbSourceParam !== null && !isDbMode(dbSourceParam)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }
    const client = dbSourceParam ? getClientForMode(dbSourceParam) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSourceParam}` }, { status: 503 });
    }

    const decodedMaterialPartNo = decodeURIComponent(materialPartNo);

    const periods = await client.componentWeeklyPeriod.findMany({
      where: {
        mrpRunId: runId,
        materialPartNo: decodedMaterialPartNo,
        mrpType,
      },
      orderBy: { weekIndex: 'asc' },
    });

    return NextResponse.json({ periods, runId, dbSource: dbSourceParam });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
