import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';

/**
 * GET /api/fg-monthly/machines — distinct forgingMachine values from latest run
 * Returns: { machines: string[] }
 */
export async function GET() {
  try {
    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json({ machines: [] });
    }

    const rows = await prisma.fgMonthly.findMany({
      where: { mrpRunId: latest.id, forgingMachine: { not: null } },
      select: { forgingMachine: true },
      distinct: ['forgingMachine'],
      orderBy: { forgingMachine: 'asc' },
    });

    const machines = rows
      .map((r) => r.forgingMachine!)
      .filter((m) => m.trim() !== '');

    return NextResponse.json({ machines });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
