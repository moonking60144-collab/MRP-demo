import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { getEnrichedSuggestions } from '@/lib/mrp/plan-transfer-helpers';

/**
 * GET /api/fg-monthly/:partVersion/periods — Get period details for a part
 * Query params:
 *   runId?: specific run (defaults to latest)
 *   dbSource?: 'local'|'docker'|'remote' — query a specific DB (for merge mode)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ partVersion: string }> },
) {
  try {
    const { partVersion } = await params;
    const url = req.nextUrl;
    const runIdParam = url.searchParams.get('runId');
    const dbSource = url.searchParams.get('dbSource');
    const aggregated = url.searchParams.get('aggregated') === 'true';

    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }
    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    let runId: number;
    if (runIdParam) {
      runId = Number(runIdParam);
      if (!Number.isInteger(runId) || runId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
      }
      const run = await client.mrpRun.findUnique({ where: { id: runId } });
      if (!run) {
        return NextResponse.json({ error: 'MRP Run not found' }, { status: 404 });
      }
    } else {
      const latest = dbSource
        ? await client.mrpRun.findFirst({ where: { isLatest: true }, orderBy: { createdAt: 'desc' } })
        : await getLatestRun();
      if (!latest) {
        return NextResponse.json({
          periods: [],
          suggestions: [],
          runId: null,
          dbSource: dbSource ?? null,
        });
      }
      runId = latest.id;
    }

    const decodedPartVersion = decodeURIComponent(partVersion);

    const [periods, enrichedSuggestions] = await Promise.all([
      client.fgMonthlyPeriod.findMany({
        where: { mrpRunId: runId, partVersion: decodedPartVersion, isAggregated: aggregated },
        orderBy: { periodIndex: 'asc' },
      }),
      getEnrichedSuggestions(client, runId, decodedPartVersion),
    ]);

    return NextResponse.json({
      periods,
      suggestions: enrichedSuggestions,
      runId,
      dbSource: dbSource ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
