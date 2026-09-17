import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { groupSalesMeetingPeriods } from '@/lib/mrp/sales-meeting-display';

interface RequestedGroup {
  partVersion: string;
  memberPartVersions: string[];
}

function parseGroups(body: Record<string, unknown>): RequestedGroup[] {
  if (Array.isArray(body.groups)) {
    return body.groups.flatMap((group) => {
      if (!group || typeof group !== 'object') return [];
      const candidate = group as Record<string, unknown>;
      if (typeof candidate.partVersion !== 'string' || !Array.isArray(candidate.memberPartVersions)) return [];
      const members = [...new Set(candidate.memberPartVersions
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean))];
      const partVersion = candidate.partVersion.trim();
      if (!partVersion || !members.includes(partVersion)) return [];
      return [{ partVersion, memberPartVersions: members }];
    });
  }
  if (!Array.isArray(body.partVersions)) return [];
  return body.partVersions.flatMap((value) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    const partVersion = value.trim();
    return [{ partVersion, memberPartVersions: [partVersion] }];
  });
}

/**
 * POST /api/sales-meeting/batch-periods — Get period data for multiple parts at once
 * Body: { groups: RequestedGroup[], runId?: number, dbSource?: DbMode }
 * Legacy body: { partVersions: string[], runId?: number, dbSource?: DbMode }
 * Returns: { periods: Record<string, PeriodDetail[]>, runId, dbSource }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const groups = parseGroups(body);
    const runIdParam = body.runId;
    const dbSource = body.dbSource === undefined || body.dbSource === null || body.dbSource === ''
      ? null
      : body.dbSource;

    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }

    if (groups.length === 0) {
      return NextResponse.json({ periods: {}, runId: null, dbSource });
    }
    const allPartVersions = [...new Set(groups.flatMap((group) => group.memberPartVersions))];
    if (groups.length > 5000 || allPartVersions.length > 10000) {
      return NextResponse.json({ error: 'requested period groups exceed limit' }, { status: 400 });
    }

    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json(
        { error: `database source unavailable: ${dbSource}` },
        { status: 503 },
      );
    }

    let runId: number | null = null;
    const hasRunId = runIdParam !== undefined && runIdParam !== null && runIdParam !== '';
    if (hasRunId) {
      const parsedRunId = Number(runIdParam);
      if (!Number.isInteger(parsedRunId) || parsedRunId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
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

    const [summaries, partRows, periods] = await Promise.all([
      client.salesMeeting.findMany({
        where: { mrpRunId: runId, partVersion: { in: allPartVersions } },
        select: { partVersion: true, customerCode: true, erpPartNo: true },
      }),
      client.stagingPartVersion.findMany({
        where: { mrpRunId: runId, partVersion: { in: allPartVersions } },
        select: { partVersion: true, customerPartNo: true },
      }),
      client.salesMeetingPeriod.findMany({
        where: { mrpRunId: runId, partVersion: { in: allPartVersions } },
        orderBy: [{ partVersion: 'asc' }, { weekIndex: 'asc' }],
      }),
    ]);
    const summaryByVersion = new Map(summaries.map((row) => [row.partVersion, row]));
    const partByVersion = new Map(partRows.map((row) => [row.partVersion, row]));
    for (const group of groups) {
      const representative = summaryByVersion.get(group.partVersion);
      const representativePart = partByVersion.get(group.partVersion);
      const valid = representative && representativePart && group.memberPartVersions.every((partVersion) => {
        const summary = summaryByVersion.get(partVersion);
        const part = partByVersion.get(partVersion);
        return summary
          && part
          && summary.customerCode === representative.customerCode
          && summary.erpPartNo === representative.erpPartNo
          && part.customerPartNo === representativePart.customerPartNo;
      });
      if (!valid) {
        return NextResponse.json({ error: 'period group identity mismatch' }, { status: 400 });
      }
    }

    const periodsByPartVersion = new Map<string, typeof periods>();
    for (const period of periods) {
      const rows = periodsByPartVersion.get(period.partVersion) || [];
      rows.push(period);
      periodsByPartVersion.set(period.partVersion, rows);
    }
    const grouped = Object.fromEntries(groups.map((group) => [
      group.partVersion,
      groupSalesMeetingPeriods(
        group.memberPartVersions
          .flatMap((partVersion) => periodsByPartVersion.get(partVersion) || [])
          .map((period) => ({
            ...period,
            remainingStock: period.remainingStock == null ? null : Number(period.remainingStock),
            demand: Number(period.demand),
            supply: Number(period.supply),
          })),
        group.partVersion,
      ),
    ]));

    return NextResponse.json({ periods: grouped, runId, dbSource });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
