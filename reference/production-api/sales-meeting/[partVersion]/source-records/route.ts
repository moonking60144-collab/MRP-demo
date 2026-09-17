import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { config } from '@/lib/config';
import { generateWeeklyPeriods } from '@/lib/mrp/period-utils';
import { groupSalesMeetingPeriods } from '@/lib/mrp/sales-meeting-display';

const WEEK_COUNT = 12;
const SOURCE_TYPES = new Set(['orders', 'production_plans', 'balance']);
const SOURCE_SCOPES = new Set(['week', 'recent', 'all']);

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

function dateWhere(weekIndex: number, weeks: ReturnType<typeof generateWeeklyPeriods>) {
  if (weekIndex === 0) return { lt: weeks[0].start };
  const week = weeks[weekIndex - 1];
  return { gte: week.start, lte: week.end };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ partVersion: string }> },
) {
  try {
    const { partVersion } = await params;
    const decodedPartVersion = decodeURIComponent(partVersion).trim();
    const runId = Number(req.nextUrl.searchParams.get('runId'));
    const type = req.nextUrl.searchParams.get('type') || '';
    const scope = req.nextUrl.searchParams.get('scope') || 'week';
    const weekIndexParam = req.nextUrl.searchParams.get('weekIndex');
    const weekIndex = scope !== 'week' ? 0 : weekIndexParam === null || weekIndexParam.trim() === ''
      ? Number.NaN
      : Number(weekIndexParam);
    const dbSource = req.nextUrl.searchParams.get('dbSource');
    const memberPartVersions = parseMemberPartVersions(
      req.nextUrl.searchParams.get('memberPartVersions'),
      decodedPartVersion,
    );

    if (
      !decodedPartVersion
      || !Number.isInteger(runId)
      || runId <= 0
      || !SOURCE_TYPES.has(type)
      || !SOURCE_SCOPES.has(scope)
      || (scope !== 'week' && type === 'production_plans')
      || !Number.isInteger(weekIndex)
      || weekIndex < 0
      || weekIndex > WEEK_COUNT
      || !memberPartVersions
    ) {
      return NextResponse.json(
        { error: '缺少或無效的 runId、type、scope、weekIndex、partVersion' },
        { status: 400 },
      );
    }
    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: '無效的 dbSource' }, { status: 400 });
    }
    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `資料庫來源目前無法使用：${dbSource}` }, { status: 503 });
    }

    const [run, summaries, requestedPartRows] = await Promise.all([
      client.mrpRun.findUnique({ where: { id: runId }, select: { runDate: true } }),
      client.salesMeeting.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
      }),
      client.stagingPartVersion.findMany({
        where: { mrpRunId: runId, partVersion: { in: memberPartVersions } },
        select: { partVersion: true, customerPartNo: true },
      }),
    ]);
    const summaryByVersion = new Map(summaries.map((row) => [row.partVersion, row]));
    const partByVersion = new Map(requestedPartRows.map((row) => [row.partVersion, row]));
    const summary = summaryByVersion.get(decodedPartVersion);
    const representativePart = partByVersion.get(decodedPartVersion);
    if (!run || !summary) {
      return NextResponse.json({ error: '找不到此 MRP Run 的產銷資料' }, { status: 404 });
    }
    const validGroup = representativePart && memberPartVersions.every((member) => {
      const memberSummary = summaryByVersion.get(member);
      const memberPart = partByVersion.get(member);
      return memberSummary
        && memberPart
        && memberSummary.customerCode === summary.customerCode
        && memberSummary.erpPartNo === summary.erpPartNo
        && memberPart.customerPartNo === representativePart.customerPartNo;
    });
    if (!validGroup) {
      return NextResponse.json({ error: '來源明細群組識別不一致' }, { status: 400 });
    }

    const weeks = generateWeeklyPeriods(new Date(run.runDate), WEEK_COUNT);
    const scopedDate = scope === 'recent'
      ? { lte: weeks[3].end }
      : scope === 'all' ? { not: null } : dateWhere(weekIndex, weeks);
    const groupRows = summary.erpPartNo
      ? await client.salesMeeting.findMany({
          where: { mrpRunId: runId, erpPartNo: summary.erpPartNo },
          select: { customerCode: true, partVersion: true },
          orderBy: [{ customerCode: 'asc' }, { partVersion: 'asc' }],
        })
      : [{ customerCode: summary.customerCode, partVersion: summary.partVersion }];
    const groupPartVersions = new Set(groupRows.map((row) => row.partVersion));
    const isDisplayOwner = memberPartVersions.includes(groupRows[0]?.partVersion || '');

    const [periodRows, previousPeriodRows, orders, candidatePlans] = await Promise.all([
      scope === 'week' ? client.salesMeetingPeriod.findMany({
        where: {
          mrpRunId: runId,
          partVersion: { in: memberPartVersions },
          weekIndex,
        },
      }) : Promise.resolve([]),
      scope === 'week' && weekIndex > 1
        ? client.salesMeetingPeriod.findMany({
            where: {
              mrpRunId: runId,
              partVersion: { in: memberPartVersions },
              weekIndex: weekIndex - 1,
            },
          })
        : Promise.resolve([]),
      client.stagingOrder.findMany({
        where: {
          mrpRunId: runId,
          partVersion: type === 'balance'
            ? { in: [...groupPartVersions] }
            : { in: memberPartVersions },
          shipmentStatus: '未結案',
          salesStatus: '未結案',
          unshippedQty: { gt: 0 },
          designatedShipDate: scopedDate,
        },
        orderBy: [{ designatedShipDate: 'asc' }, { partVersion: 'asc' }, { orderNo: 'asc' }],
      }),
      scope === 'week' ? client.stagingProductionPlan.findMany({
        where: {
          mrpRunId: runId,
          planQty: { gt: 0 },
          completionDate: scopedDate,
          OR: [
            { partVersion: { in: [...groupPartVersions] } },
            ...(summary.erpPartNo ? [{ erpPartNo: summary.erpPartNo }] : []),
          ],
        },
        orderBy: [{ completionDate: 'asc' }, { planNo: 'asc' }],
      }) : Promise.resolve([]),
    ]);

    const productionPlans = type === 'balance' ? candidatePlans : candidatePlans.filter((plan) => {
      const planPartVersion = plan.partVersion?.trim() || '';
      if (memberPartVersions.includes(planPartVersion)) return true;
      return isDisplayOwner && !groupPartVersions.has(planPartVersion);
    });
    const normalizePeriods = (rows: typeof periodRows) => rows.map((period) => ({
      ...period,
      remainingStock: period.remainingStock == null ? null : Number(period.remainingStock),
      demand: Number(period.demand),
      supply: Number(period.supply),
    }));
    const period = groupSalesMeetingPeriods(
      normalizePeriods(periodRows),
      decodedPartVersion,
    )[0] || null;
    const previousPeriod = groupSalesMeetingPeriods(
      normalizePeriods(previousPeriodRows),
      decodedPartVersion,
    )[0] || null;
    const orderRecords = orders.map((record) => ({
      ...record,
      ragicUrl: record.ragicRecordId
        ? `${config.ragicBaseUrl}/default/forms31/2/${record.ragicRecordId}`
        : null,
    }));
    const productionPlanRecords = productionPlans.map((record) => ({
      ...record,
      ragicUrl: record.ragicRecordId
        ? `${config.ragicBaseUrl}/default/d4/10/${record.ragicRecordId}`
        : null,
    }));
    const week = weekIndex === 0 ? null : weeks[weekIndex - 1];
    const summaryBalance = scope === 'week' ? null : {
      demand: summaries.reduce((total, row) => total + Number(scope === 'recent' ? row.outstanding04 : row.totalOrderDemand), 0),
      remainingStock: Math.min(...summaries.map(row => Number(scope === 'recent' ? row.fgDiff04 : row.totalFgDiff))),
      includesProductionPlans: false,
      members: summaries.map(row => ({
        partVersion: row.partVersion,
        demand: Number(scope === 'recent' ? row.outstanding04 : row.totalOrderDemand),
        remainingStock: Number(scope === 'recent' ? row.fgDiff04 : row.totalFgDiff),
      })),
    };

    return NextResponse.json({
      type,
      scope,
      runId,
      partVersion: decodedPartVersion,
      customerPartNo: representativePart.customerPartNo,
      memberPartVersions,
      erpPartNo: summary.erpPartNo,
      weekIndex,
      weekLabel: scope === 'recent' ? '前期＋前4週' : scope === 'all' ? '全部訂單（含12週以外）' : weekIndex === 0 ? '前期' : week?.label,
      summaryBalance,
      sharedPool: {
        isShared: groupRows.length > 1,
        isDisplayOwner,
        members: groupRows,
      },
      summary: {
        goodStockPc: Number(summary.goodStockPc),
        goodStockKg: Number(summary.goodStockKg),
        wfgStockPc: summary.wfgStockPc == null ? null : Number(summary.wfgStockPc),
        ye1StockPc: summary.ye1StockPc == null ? null : Number(summary.ye1StockPc),
      },
      period: period ? {
        demand: Number(period.demand),
        supply: Number(period.supply),
        remainingStock: period.remainingStock == null ? null : Number(period.remainingStock),
      } : null,
      previousRemainingStock: previousPeriod?.remainingStock == null
        ? null
        : Number(previousPeriod.remainingStock),
      orders: orderRecords,
      productionPlans: productionPlanRecords,
      total: type === 'orders'
        ? orderRecords.length
        : type === 'production_plans'
          ? productionPlanRecords.length
          : orderRecords.length + productionPlanRecords.length,
      dbSource,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '讀取產銷來源失敗' },
      { status: 500 },
    );
  }
}
