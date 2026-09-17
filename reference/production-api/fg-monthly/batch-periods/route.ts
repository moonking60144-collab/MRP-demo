import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';

/**
 * POST /api/fg-monthly/batch-periods — Get period data for multiple parts at once
 * Body: { partVersions: string[], runId?: number, dbSource?: DbMode, aggregated?: boolean }
 * Returns: { periods: Record<string, PeriodDetail[]>, runId, dbSource }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      partVersions: rawPartVersions,
      runId: runIdParam,
      dbSource: dbSourceParam,
      aggregated,
    } = body;
    const isAgg = aggregated === true;
    const dbSource = dbSourceParam === undefined || dbSourceParam === null || dbSourceParam === ''
      ? null
      : dbSourceParam;

    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'Invalid dbSource' }, { status: 400 });
    }

    const partVersions = Array.isArray(rawPartVersions)
      ? Array.from(new Set(
        rawPartVersions
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean),
      ))
      : [];
    if (partVersions.length === 0) {
      return NextResponse.json({ periods: {}, runId: null, dbSource });
    }

    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json(
        { error: `Database source ${dbSource} is not configured` },
        { status: 503 },
      );
    }

    let runId: number | null = null;
    const hasRunId = runIdParam !== undefined && runIdParam !== null && runIdParam !== '';
    if (hasRunId) {
      const parsedRunId = Number(runIdParam);
      if (!Number.isInteger(parsedRunId) || parsedRunId <= 0) {
        return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
      }
      const run = await client.mrpRun.findUnique({
        where: { id: parsedRunId },
        select: { id: true },
      });
      if (!run) {
        return NextResponse.json({ error: 'MRP Run not found' }, { status: 404 });
      }
      runId = parsedRunId;
    } else {
      const latest = dbSource
        ? await client.mrpRun.findFirst({
          where: { isLatest: true },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
        : await getLatestRun();
      if (!latest) {
        return NextResponse.json({ periods: {}, runId: null, dbSource });
      }
      runId = latest.id;
    }

    const periods = await client.fgMonthlyPeriod.findMany({
      where: { mrpRunId: runId, partVersion: { in: partVersions }, isAggregated: isAgg },
      orderBy: [{ partVersion: 'asc' }, { periodIndex: 'asc' }],
    });

    // Group by partVersion
    const grouped: Record<string, typeof periods> = {};
    for (const p of periods) {
      if (!grouped[p.partVersion]) grouped[p.partVersion] = [];
      grouped[p.partVersion]!.push(p);
    }

    return NextResponse.json({ periods: grouped, runId, dbSource });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
