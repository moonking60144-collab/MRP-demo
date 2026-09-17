import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { scheduleWorkOrderGenerationQueue } from '@/lib/mrp/work-order-generation-queue';
import { config } from '@/lib/config';
import { generateMonthlyPeriods } from '@/lib/mrp/period-utils';
import {
  attributeFgMonthlyOrderDemand,
  fgMonthlyOrderPeriodIndex,
  summarizeAttributedFgMonthlyOrders,
} from '@/lib/mrp/fg-monthly-source-detail';
import {
  normalizeOrderDemandContractVersion,
  resolveOrderDemandContribution,
} from '@/lib/mrp/order-demand-contract';

/**
 * GET /api/fg-monthly/:partVersion/sources?runId=Y&dbSource=local|docker|remote
 *
 * 一次撈該 partVersion 在 7 個 staging table 內的全部 records（不切期），給
 * detail modal 的「來源」panel 用。
 *
 * 與 ./source-records 端點區別：
 *   - source-records：drilldown 用，一次撈 1 個 type + 可帶 periodIndex 篩月份
 *   - sources（本端點）：總覽用，一次回 7 個 type，不切期
 *
 * Filter 規則：
 *   - part_versions / orders / forecasts / work_orders / production_plans：by partVersion
 *   - inventory：by erpPartNo（從 part_versions 撈出來）
 *   - work_order_bom：先撈 work_orders 拿 wo_number list，再 IN 篩
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
    const decodedPart = decodeURIComponent(partVersion);
    const requestedMembers = url.searchParams.getAll('partVersion')
      .map((value) => value.trim())
      .filter(Boolean);
    const sourcePartVersions = [...new Set(
      requestedMembers.length > 0 ? requestedMembers : [decodedPart],
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
        select: { id: true, runDate: true, orderDemandContractVersion: true },
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
        return NextResponse.json({
          partVersion: decodedPart,
          runId: null,
          dbSource,
          partVersions: [], inventory: [], orders: [], forecasts: [],
          workOrders: [], workOrderBoms: [], productionPlans: [],
        });
      }
      runId = latest.id;
      runDate = latest.runDate;
      orderDemandContractVersion = latest.orderDemandContractVersion;
    }
    const contractVersion = normalizeOrderDemandContractVersion(orderDemandContractVersion);
    const periods = generateMonthlyPeriods(
      runDate ? new Date(runDate) : new Date(),
      config.mrp.projectionMonths,
    );

    const partVersions = sourcePartVersions.length === 1
      ? await client.stagingPartVersion.findFirst({
          where: { mrpRunId: runId, partVersion: sourcePartVersions[0] },
        }).then((row) => row ? [row] : [])
      : await client.stagingPartVersion.findMany({
          where: { mrpRunId: runId, partVersion: { in: sourcePartVersions } },
        });
    const erpPartNos = [...new Set(partVersions.flatMap((row) => (
      row.erpPartNo ? [row.erpPartNo] : []
    )))];
    const erpPartNo = erpPartNos.length === 1 ? erpPartNos[0] : null;

    // work_orders 先撈拿 wo_number list（給 BOM 用）
    const workOrders = await client.stagingWorkOrder.findMany({
      where: { mrpRunId: runId, partVersion: partVersionFilter },
      orderBy: [{ endDate: 'asc' }],
    });
    const woNumbers = workOrders
      .map((w) => w.woNumber)
      .filter((n): n is string => !!n);

    const [inventory, orderRows, forecasts, productionPlans, productionPlanTransfers, workOrderBoms] =
      await Promise.all([
        erpPartNos.length > 0
          ? client.stagingInventory.findMany({
              where: {
                mrpRunId: runId,
                erpPartNo: erpPartNos.length === 1 ? erpPartNos[0] : { in: erpPartNos },
              },
            })
          : Promise.resolve([]),
        client.stagingOrder.findMany({
          where: { mrpRunId: runId, partVersion: partVersionFilter },
          orderBy: [{ designatedShipDate: 'asc' }, { deliveryDate: 'asc' }],
        }),
        client.stagingForecast.findMany({
          where: { mrpRunId: runId, partVersion: partVersionFilter },
          orderBy: [{ forecastStart: 'asc' }],
        }),
        client.stagingProductionPlan.findMany({
          where: { mrpRunId: runId, partVersion: partVersionFilter },
          orderBy: [{ completionDate: 'asc' }],
        }),
        client.productionPlanTransfer.findMany({
          where: { mrpRunId: runId, partVersion: partVersionFilter },
          select: {
            id: true,
            ragicRecordId: true,
            ragicPlanNo: true,
            workOrderStatus: true,
            workOrderError: true,
            workOrderStartedAt: true,
            workOrderCompletedAt: true,
          },
        }),
        woNumbers.length > 0
          ? client.stagingWorkOrderBom.findMany({
              where: { mrpRunId: runId, woNumber: { in: woNumbers } },
              orderBy: [{ startDate: 'asc' }],
            })
          : Promise.resolve([]),
      ]);
    const attributedOrders = orderRows.map((order) => {
      const contribution = resolveOrderDemandContribution(order, contractVersion);
      const attribution = attributeFgMonthlyOrderDemand(
        contribution,
        fgMonthlyOrderPeriodIndex(order, periods),
        periods.length,
      );
      return { order, contribution, attribution };
    });
    const orders = attributedOrders.map(({ order, contribution, attribution }) => ({
      ...order,
      orderDemandContribution: contribution,
      orderDemandAttribution: attribution,
    }));

    if (!dbSource) scheduleWorkOrderGenerationQueue();
    const transferByRecordId = new Map(
      productionPlanTransfers
        .filter((transfer) => transfer.ragicRecordId)
        .map((transfer) => [transfer.ragicRecordId, transfer]),
    );
    const transferByPlanNo = new Map(
      productionPlanTransfers
        .filter((transfer) => transfer.ragicPlanNo)
        .map((transfer) => [transfer.ragicPlanNo, transfer]),
    );
    const trackedProductionPlans = productionPlans.map((plan) => {
      const transfer = (plan.ragicRecordId ? transferByRecordId.get(plan.ragicRecordId) : undefined)
        ?? (plan.planNo ? transferByPlanNo.get(plan.planNo) : undefined);
      return {
        ...plan,
        workOrderTransferId: transfer?.id ?? null,
        generationStatus: transfer?.workOrderStatus ?? null,
        generationError: transfer?.workOrderError ?? null,
        generationStartedAt: transfer?.workOrderStartedAt ?? null,
        generationCompletedAt: transfer?.workOrderCompletedAt ?? null,
      };
    });

    return NextResponse.json({
      partVersion: decodedPart,
      runId,
      dbSource,
      contractVersion,
      sourcePartVersions,
      erpPartNo,
      erpPartNos,
      partVersions,
      inventory,
      orders,
      orderDemandSummary: summarizeAttributedFgMonthlyOrders(attributedOrders),
      forecasts,
      workOrders,
      workOrderBoms,
      productionPlans: trackedProductionPlans,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
