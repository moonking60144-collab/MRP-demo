import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { groupSalesMeetingPeriods } from '@/lib/mrp/sales-meeting-display';

function parseMemberPartVersions(value: string | null, representative: string): string[] | null {
  if (!value) return [representative];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const members = [...new Set(parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean))];
    if (members.length === 0 || members.length > 100 || !members.includes(representative)) return null;
    return members;
  } catch {
    return null;
  }
}

/**
 * GET /api/sales-meeting/[partVersion]/periods
 * Returns 13 weekly period rows (W00 prior + W01-W12) for a specific part version
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

    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }
    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    let runId: number;
    if (runIdParam) {
      runId = parseInt(runIdParam, 10);
    } else {
      const latest = dbSource
        ? await client.mrpRun.findFirst({ where: { isLatest: true }, orderBy: { createdAt: 'desc' } })
        : await getLatestRun();
      if (!latest) {
        return NextResponse.json({ periods: [] });
      }
      runId = latest.id;
    }

    const decodedPartVersion = decodeURIComponent(partVersion);
    const memberPartVersions = parseMemberPartVersions(
      url.searchParams.get('memberPartVersions'),
      decodedPartVersion,
    );
    if (!memberPartVersions) {
      return NextResponse.json({ error: 'invalid memberPartVersions' }, { status: 400 });
    }

    const [summaries, partRows, periods] = await Promise.all([
      client.salesMeeting.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
        select: { partVersion: true, customerCode: true, erpPartNo: true },
      }),
      client.stagingPartVersion.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
        select: { partVersion: true, customerPartNo: true },
      }),
      client.salesMeetingPeriod.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
        orderBy: [{ partVersion: 'asc' }, { weekIndex: 'asc' }],
      }),
    ]);
    const summaryByVersion = new Map(summaries.map((row) => [row.partVersion, row]));
    const partByVersion = new Map(partRows.map((row) => [row.partVersion, row]));
    const representative = summaryByVersion.get(decodedPartVersion);
    const representativePart = partByVersion.get(decodedPartVersion);
    const valid = representative && representativePart && memberPartVersions.every((member) => {
      const summary = summaryByVersion.get(member);
      const part = partByVersion.get(member);
      return summary
        && part
        && summary.customerCode === representative.customerCode
        && summary.erpPartNo === representative.erpPartNo
        && part.customerPartNo === representativePart.customerPartNo;
    });
    if (!valid) {
      return NextResponse.json({ error: 'period group identity mismatch' }, { status: 400 });
    }

    const groupedPeriods = groupSalesMeetingPeriods(
      periods.map((period) => ({
        ...period,
        remainingStock: period.remainingStock == null ? null : Number(period.remainingStock),
        demand: Number(period.demand),
        supply: Number(period.supply),
      })),
      decodedPartVersion,
    );

    return NextResponse.json({ periods: groupedPeriods });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
