import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';

/**
 * POST /api/component-weekly/batch-periods — Get period data for multiple materials at once
 * Body: { materialPartNos: string[], mrpType: string, runId: number, dbSource?: DbMode }
 * Returns: { periods: Record<string, PeriodDetail[]>, runId, dbSource }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { materialPartNos, mrpType, runId: runIdParam, dbSource } = body;

    if (!Array.isArray(materialPartNos) || materialPartNos.length === 0) {
      return NextResponse.json({ periods: {}, runId: null });
    }
    if (!mrpType || !['W', 'B', 'D'].includes(mrpType)) {
      return NextResponse.json({ error: 'mrpType required' }, { status: 400 });
    }

    const runId = Number(runIdParam);
    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'runId required' }, { status: 400 });
    }
    if (dbSource !== undefined && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }

    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    const periods = await client.componentWeeklyPeriod.findMany({
      where: {
        mrpRunId: runId,
        mrpType,
        materialPartNo: { in: materialPartNos },
      },
      orderBy: [{ materialPartNo: 'asc' }, { weekIndex: 'asc' }],
    });

    // Group by materialPartNo
    const grouped: Record<string, typeof periods> = {};
    for (const p of periods) {
      if (!grouped[p.materialPartNo]) grouped[p.materialPartNo] = [];
      grouped[p.materialPartNo]!.push(p);
    }

    return NextResponse.json({ periods: grouped, runId, dbSource: dbSource ?? null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
