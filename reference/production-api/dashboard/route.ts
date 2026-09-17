import { NextResponse } from 'next/server';
import prisma, { currentDbMode } from '@/lib/db';
import { getLatestRun, listRuns } from '@/lib/mrp/run-orchestrator';

/**
 * GET /api/dashboard — Dashboard summary data
 */
export async function GET() {
  try {
    const latestRun = await getLatestRun();

    if (!latestRun) {
      return NextResponse.json({
        latestRun: null,
        summary: null,
      });
    }

    // Aggregate stats from the latest run.
    // Exclude `isAggregated` rows: those are 主件聚合 grouped views of the same physical parts —
    // counting them would double-up the totals (e.g. 2,878 per-version + 2,204 groups = 5,082).
    const [totalParts, shortageParts, totalWithPlans, recentRuns] = await Promise.all([
      prisma.fgMonthly.count({
        where: { mrpRunId: latestRun.id, isAggregated: false },
      }),
      prisma.fgMonthly.count({
        where: { mrpRunId: latestRun.id, isAggregated: false, shouldPlanProduction: true },
      }),
      prisma.fgPlanSuggestion.groupBy({
        by: ['partVersion'],
        where: { mrpRunId: latestRun.id },
      }),
      listRuns(50),
    ]);

    return NextResponse.json({
      dbMode: currentDbMode(),
      latestRun: {
        id: latestRun.id,
        versionCode: latestRun.versionCode,
        runDate: latestRun.runDate,
        status: latestRun.status,
        completedAt: latestRun.completedAt,
        createdBy: latestRun.createdBy,
      },
      summary: {
        totalParts,
        shortageParts,
        partsWithPlans: totalWithPlans.length,
        healthPct: totalParts > 0
          ? Math.round(((totalParts - shortageParts) / totalParts) * 100)
          : 100,
      },
      recentRuns,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
