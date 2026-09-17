import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { dateToPeriodIndex, generateMonthlyPeriods } from '@/lib/mrp/period-utils';
import {
  attributeFgMonthlyOrderDemand,
  fgMonthlyOrderPeriodIndex,
  fgMonthlySourceTypes,
  isFgMonthlySourceMetric,
  summarizeAttributedFgMonthlyOrders,
} from '@/lib/mrp/fg-monthly-source-detail';
import {
  buildSharedErpPoolUsageSet,
  resolveSharedErpPlanDisplayMember,
} from '@/lib/mrp/shared-erp-display';
import { config } from '@/lib/config';
import {
  normalizeOrderDemandContractVersion,
  resolveOrderDemandContribution,
} from '@/lib/mrp/order-demand-contract';

/**
 * GET /api/fg-monthly/:partVersion/source-records
 * Returns the actual staging records that contributed to a period's numbers.
 *
 * Query params:
 *   runId?: specific run (defaults to latest)
 *   type: "orders" | "forecasts" | "work_orders" | "production_plans" | "inventory"
 *   metric?: source metric; when provided, it must be valid for the requested type
 *   periodIndex?: which month (0-based). If omitted, returns all.
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
    const type = url.searchParams.get('type') || '';
    const metric = url.searchParams.get('metric');
    const periodIndexParam = url.searchParams.get('periodIndex');

    if (metric !== null && !isFgMonthlySourceMetric(metric)) {
      return NextResponse.json({ error: 'invalid metric' }, { status: 400 });
    }
    if (
      metric !== null
      && !fgMonthlySourceTypes(metric).some((sourceType) => sourceType === type)
    ) {
      return NextResponse.json({ error: 'metric is not valid for type' }, { status: 400 });
    }

    const decodedPart = decodeURIComponent(partVersion);
    const requestedPartVersions = url.searchParams.getAll('partVersion')
      .map((value) => value.trim())
      .filter(Boolean);
    const sourcePartVersions = [...new Set(
      requestedPartVersions.length > 0 ? requestedPartVersions : [decodedPart],
    )];
    const partVersionFilter = sourcePartVersions.length === 1
      ? sourcePartVersions[0]
      : { in: sourcePartVersions };

    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }
    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    // 用 mrp_run.runDate 算 period 範圍，跟 fg-monthly-engine 對齊。
    // 原本用 new Date() 在跨日 / resume 場景下，UI drilldown 看到的 period
    // 邊界會跟 calc 寫進 fg_monthly_periods 的 period_start/end 對不齊，
    // 撈來源資料時可能漏抓或多抓邊界資料。
    // 順便：runId + runDate 一次 query 拿，省一次 DB round-trip。
    let runId: number;
    let runDate: Date | null = null;
    let orderDemandContractVersion: string | null | undefined;
    if (runIdParam) {
      runId = Number(runIdParam);
      if (!Number.isInteger(runId) || runId <= 0) {
        return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
      }
      const run = await client.mrpRun.findUnique({
        where: { id: runId },
        select: { runDate: true, orderDemandContractVersion: true },
      });
      if (!run) {
        return NextResponse.json({ error: 'MRP run not found' }, { status: 404 });
      }
      runDate = run.runDate;
      orderDemandContractVersion = run.orderDemandContractVersion;
    } else {
      const latest = dbSource
        ? await client.mrpRun.findFirst({
            where: { isLatest: true },
            orderBy: { createdAt: 'desc' },
          })
        : await getLatestRun();
      if (!latest) {
        return NextResponse.json({ records: [], total: 0 });
      }
      runId = latest.id;
      runDate = latest.runDate;
      orderDemandContractVersion = latest.orderDemandContractVersion;
    }
    const contractVersion = normalizeOrderDemandContractVersion(orderDemandContractVersion);
    const baseDate = runDate ? new Date(runDate) : new Date();
    const periods = generateMonthlyPeriods(baseDate, config.mrp.projectionMonths);
    const periodIndex = periodIndexParam !== null ? Number(periodIndexParam) : null;
    if (
      periodIndex !== null
      && (!Number.isInteger(periodIndex) || periodIndex < -1 || periodIndex >= periods.length)
    ) {
      return NextResponse.json({ error: 'invalid periodIndex' }, { status: 400 });
    }

    // Get period date range if specified
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;
    if (periodIndex !== null && periodIndex >= 0) {
      periodStart = periods[periodIndex].start;
      periodEnd = periods[periodIndex].end;
    }
    const isPriorPeriod = periodIndex === -1;
    const periodLabel = isPriorPeriod
      ? '前期'
      : periodIndex !== null
        ? periods[periodIndex].label
        : 'All';

    switch (type) {
      case 'orders': {
        const orderCandidates = await client.stagingOrder.findMany({
          where: {
            mrpRunId: runId,
            partVersion: partVersionFilter,
          },
          orderBy: [{ designatedShipDate: 'asc' }, { deliveryDate: 'asc' }],
        });
        const attributedOrders = orderCandidates.map((order) => {
          const attributedPeriodIndex = fgMonthlyOrderPeriodIndex(order, periods);
          const contribution = resolveOrderDemandContribution(order, contractVersion);
          return {
            order,
            contribution,
            attribution: attributeFgMonthlyOrderDemand(
              contribution,
              attributedPeriodIndex,
              periods.length,
            ),
          };
        });
        const contributesToMetric = ({ attribution }: typeof attributedOrders[number]) => {
          if (metric === 'ordersUnshipped') return attribution.outstandingOrderQty > 0;
          if (metric === 'ordersTotal') return attribution.recognizedOrderQty > 0;
          if (metric === 'demandIntegrated') {
            return attribution.recognizedOrderQty > 0
              || attribution.outstandingOrderQty > 0;
          }
          return true;
        };
        const records = attributedOrders
          .filter(contributesToMetric)
          .filter(({ attribution }) => {
            if (periodIndex !== null) return attribution.periodIndex === periodIndex;
            return metric === 'ordersTotal'
              ? attribution.status === 'included_period'
              : attribution.status === 'included_period'
                || attribution.status === 'included_prior';
          })
          .map(({ order, contribution, attribution }) => ({
            ...order,
            orderDemandContribution: contribution,
            orderDemandAttribution: attribution,
          }));
        const priorRecords = periodIndex === 0
          ? attributedOrders
              .filter(({ attribution }) => (
                attribution.status === 'included_prior'
                && attribution.outstandingOrderQty > 0
              ))
              .map(({ order, contribution, attribution }) => ({
                ...order,
                orderDemandContribution: contribution,
                orderDemandAttribution: attribution,
              }))
          : [];
        return NextResponse.json({
          type: 'orders',
          metric,
          partVersion: decodedPart,
          partVersions: sourcePartVersions,
          runId,
          dbSource,
          contractVersion,
          periodIndex,
          periodLabel,
          records,
          priorRecords,
          summary: summarizeAttributedFgMonthlyOrders(records.map((record) => ({
            contribution: record.orderDemandContribution,
            attribution: record.orderDemandAttribution,
          }))),
          priorSummary: summarizeAttributedFgMonthlyOrders(priorRecords.map((record) => ({
            contribution: record.orderDemandContribution,
            attribution: record.orderDemandAttribution,
          }))),
          total: records.length,
        });
      }

      case 'forecasts': {
        const records = await client.stagingForecast.findMany({
          where: {
            mrpRunId: runId,
            partVersion: partVersionFilter,
            ...(metric === 'forecastQty' || metric === 'demandIntegrated'
              ? { forecastQty: { gt: 0 } }
              : {}),
            ...(isPriorPeriod ? {
              forecastStart: { lt: periods[0].start },
            } : periodStart && periodEnd ? {
              forecastStart: { gte: periodStart, lte: periodEnd },
            } : {}),
          },
          orderBy: { forecastStart: 'asc' },
        });
        return NextResponse.json({
          type: 'forecasts',
          metric,
          partVersion: decodedPart,
          partVersions: sourcePartVersions,
          runId,
          dbSource,
          periodIndex,
          periodLabel,
          records,
          total: records.length,
        });
      }

      case 'work_orders': {
        const workOrderMetricFilter = metric === 'woScheduled'
          ? {
              subProcessCode: 'HF01',
              jobOrderCode: { notIn: ['99', ''] },
            }
          : metric === 'woUnscheduled'
            ? {
                subProcessCode: 'HF01',
                OR: [
                  { jobOrderCode: null },
                  { jobOrderCode: { in: ['99', ''] } },
                ],
              }
            : metric === 'woTotal'
              ? { subProcessCode: 'HF01' }
              : {};
        const records = await client.stagingWorkOrder.findMany({
          where: {
            mrpRunId: runId,
            partVersion: partVersionFilter,
            ...workOrderMetricFilter,
            ...(isPriorPeriod ? {
              endDate: { lt: periods[0].start },
            } : periodStart && periodEnd ? {
              endDate: { gte: periodStart, lte: periodEnd },
            } : {}),
          },
          orderBy: { endDate: 'asc' },
        });
        return NextResponse.json({
          type: 'work_orders',
          metric,
          partVersion: decodedPart,
          partVersions: sourcePartVersions,
          runId,
          dbSource,
          periodIndex,
          periodLabel,
          records,
          total: records.length,
        });
      }

      case 'production_plans': {
        const requestedMembers = await client.stagingPartVersion.findMany({
          where: {
            mrpRunId: runId,
            partVersion: { in: sourcePartVersions },
          },
          select: {
            partVersion: true,
            erpPartNo: true,
            customerCode: true,
          },
        });
        const requestedErps = [...new Set(requestedMembers.flatMap((member) => {
          const erpPartNo = member.erpPartNo?.trim();
          return erpPartNo ? [erpPartNo] : [];
        }))];
        const canResolveErpGroups = requestedMembers.length === sourcePartVersions.length
          && requestedErps.length > 0;
        const erpGroupMembers = canResolveErpGroups
          ? await client.stagingPartVersion.findMany({
              where: {
                mrpRunId: runId,
                erpPartNo: { in: requestedErps },
              },
              select: {
                partVersion: true,
                erpPartNo: true,
                customerCode: true,
              },
            })
          : [];
        const groupMembersByPartVersion = new Map(
          [...requestedMembers, ...erpGroupMembers].map(
            (member) => [member.partVersion.trim(), member] as const,
          ),
        );
        const groupMembers = canResolveErpGroups
          ? [...groupMembersByPartVersion.values()]
          : requestedMembers;
        const groupPartVersions = groupMembers.map((member) => member.partVersion.trim());
        const allPlans = await client.stagingProductionPlan.findMany({
          where: canResolveErpGroups
            ? {
                mrpRunId: runId,
                OR: [
                  { erpPartNo: { in: requestedErps } },
                  { partVersion: { in: groupPartVersions } },
                ],
              }
            : {
                mrpRunId: runId,
                partVersion: partVersionFilter,
              },
          orderBy: { completionDate: 'asc' },
        });
        const requestedPartVersionSet = new Set(sourcePartVersions);
        const erpByPartVersion = new Map(
          groupMembers.map((member) => [
            member.partVersion.trim(),
            member.erpPartNo?.trim() || null,
          ] as const),
        );
        const groupMembersByErp = new Map<string, typeof groupMembers>();
        for (const member of groupMembers) {
          const erpPartNo = member.erpPartNo?.trim();
          if (!erpPartNo) continue;
          const members = groupMembersByErp.get(erpPartNo) ?? [];
          members.push(member);
          groupMembersByErp.set(erpPartNo, members);
        }
        const sharedPoolErps = buildSharedErpPoolUsageSet(groupMembers, allPlans);
        const records = allPlans.filter((plan) => {
          const planPartVersion = plan.partVersion?.trim();
          const erpPartNo = plan.erpPartNo?.trim()
            || (planPartVersion ? erpByPartVersion.get(planPartVersion) ?? null : null);
          const planGroupMembers = erpPartNo
            ? groupMembersByErp.get(erpPartNo) ?? []
            : groupMembers;
          const sourceMember = resolveSharedErpPlanDisplayMember(
            plan,
            planGroupMembers,
            erpPartNo ? sharedPoolErps.has(erpPartNo) : false,
          );
          if (
            !sourceMember
            || !requestedPartVersionSet.has(sourceMember.partVersion.trim())
          ) return false;
          if (metric === 'plannedOutput' && (Number(plan.planQty) || 0) <= 0) return false;
          if (metric === 'planReportedQty' && (Number(plan.reportedQty) || 0) === 0) return false;
          if (metric === 'planClosedQty' && (Number(plan.closedQty) || 0) === 0) return false;
          if (periodIndex === null) return true;
          if (!plan.completionDate) return false;
          return dateToPeriodIndex(plan.completionDate, periods) === periodIndex;
        });
        return NextResponse.json({
          type: 'production_plans',
          metric,
          partVersion: decodedPart,
          partVersions: sourcePartVersions,
          runId,
          dbSource,
          periodIndex,
          periodLabel,
          records,
          total: records.length,
        });
      }

      case 'inventory': {
        // Look up inventory by erpPartNo — need to find it from part_versions first
        const partRec = await client.stagingPartVersion.findFirst({
          where: { mrpRunId: runId, partVersion: partVersionFilter },
          select: { erpPartNo: true },
        });
        const records = partRec?.erpPartNo
          ? await client.stagingInventory.findMany({
              where: { mrpRunId: runId, erpPartNo: partRec.erpPartNo },
            })
          : [];
        return NextResponse.json({
          type: 'inventory',
          metric,
          partVersion: decodedPart,
          partVersions: sourcePartVersions,
          runId,
          dbSource,
          erpPartNo: partRec?.erpPartNo,
          records,
          total: records.length,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown type: ${type}. Use: orders, forecasts, work_orders, production_plans, inventory` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
