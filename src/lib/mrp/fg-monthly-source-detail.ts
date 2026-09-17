import {
  summarizeOrderDemandContributions,
  type OrderDemandContribution,
  type OrderDemandSummary,
} from './order-demand-contract';
import { dateToPeriodIndex, type MrpPeriod } from './period-utils';

export type FgMonthlySourceType =
  | 'orders'
  | 'forecasts'
  | 'production_plans'
  | 'work_orders';

export type FgMonthlySourceMetric =
  | 'demandIntegrated'
  | 'ordersUnshipped'
  | 'forecastQty'
  | 'plannedOutput'
  | 'ordersTotal'
  | 'woScheduled'
  | 'woUnscheduled'
  | 'woTotal'
  | 'planReportedQty'
  | 'planClosedQty';

export type FgMonthlySummarySourceMetric = Extract<
  FgMonthlySourceMetric,
  'woScheduled' | 'woUnscheduled' | 'woTotal' | 'planReportedQty' | 'planClosedQty'
>;

export interface FgMonthlySourcePeriod {
  periodIndex: number | null;
  periodLabel: string;
  demandIntegrated: number;
  ordersUnshipped: number;
  forecastQty: number;
  plannedOutput: number;
  ordersTotal: number;
  woScheduled?: number;
  woUnscheduled?: number;
  woTotal?: number;
  planReportedQty?: number;
  planClosedQty?: number;
}

export interface FgMonthlyPeriodSourceRequest {
  partVersion: string;
  memberPartVersions?: string[];
  mrpRunId: number;
  dbSource?: string;
  metric: FgMonthlySourceMetric;
  period: FgMonthlySourcePeriod;
}

export type FgMonthlyOrderAttributionStatus =
  | 'included_prior'
  | 'included_period'
  | 'excluded_missing_designated_ship_date'
  | 'excluded_after_projection';

export interface FgMonthlyOrderAttribution {
  status: FgMonthlyOrderAttributionStatus;
  periodIndex: number | null;
  recognizedOrderQty: number;
  outstandingOrderQty: number;
  demandResolvedQty: number;
}

export const FG_MONTHLY_ORDER_ATTRIBUTION_LABELS: Record<
  FgMonthlyOrderAttributionStatus,
  string
> = {
  included_prior: '前期：只承擔未出庫需求',
  included_period: '本期納入',
  excluded_missing_designated_ship_date: '未納入：缺指定出貨日',
  excluded_after_projection: '未納入：超出投影範圍',
};

export const FG_MONTHLY_SOURCE_METRIC_LABELS: Record<FgMonthlySourceMetric, string> = {
  demandIntegrated: '需求整合',
  ordersUnshipped: '訂單未結',
  forecastQty: '預示量',
  plannedOutput: '生產計畫',
  ordersTotal: '訂單總量',
  woScheduled: '鍛造已排',
  woUnscheduled: '鍛造待排',
  woTotal: '鍛造未結合計',
  planReportedQty: '計畫累計報工',
  planClosedQty: '計畫累計結案入庫',
};

export function isFgMonthlySourceMetric(value: unknown): value is FgMonthlySourceMetric {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(FG_MONTHLY_SOURCE_METRIC_LABELS, value);
}

export function isFgMonthlySummarySourceMetric(
  value: unknown,
): value is FgMonthlySummarySourceMetric {
  return value === 'woScheduled'
    || value === 'woUnscheduled'
    || value === 'woTotal'
    || value === 'planReportedQty'
    || value === 'planClosedQty';
}

export function fgMonthlySourceTypes(
  metric: FgMonthlySourceMetric,
): FgMonthlySourceType[] {
  if (metric === 'demandIntegrated') return ['orders', 'forecasts'];
  if (metric === 'forecastQty') return ['forecasts'];
  if (
    metric === 'plannedOutput'
    || metric === 'planReportedQty'
    || metric === 'planClosedQty'
  ) {
    return ['production_plans'];
  }
  if (
    metric === 'woScheduled'
    || metric === 'woUnscheduled'
    || metric === 'woTotal'
  ) {
    return ['work_orders'];
  }
  return ['orders'];
}

type FgMonthlyDemandInputs = Pick<
  FgMonthlySourcePeriod,
  'ordersTotal' | 'ordersUnshipped' | 'forecastQty'
>;

export function fgMonthlyDemandCalculation<T extends FgMonthlyDemandInputs>(period: T) {
  const shippedQty = Math.max(0, period.ordersTotal - period.ordersUnshipped);
  const baseDemand = Math.max(period.forecastQty, period.ordersTotal);
  return {
    shippedQty,
    baseDemand,
    demandIntegrated: Math.max(0, baseDemand - shippedQty),
  };
}

export function fgMonthlyOrderPeriodIndex(
  order: { designatedShipDate: Date | null },
  periods: MrpPeriod[],
): number | null {
  if (!order.designatedShipDate) return null;
  return dateToPeriodIndex(order.designatedShipDate, periods);
}

export function attributeFgMonthlyOrderDemand(
  contribution: OrderDemandContribution,
  periodIndex: number | null,
  periodCount: number,
): FgMonthlyOrderAttribution {
  if (periodIndex === null) {
    return {
      status: 'excluded_missing_designated_ship_date',
      periodIndex,
      recognizedOrderQty: 0,
      outstandingOrderQty: 0,
      demandResolvedQty: 0,
    };
  }
  if (periodIndex >= periodCount) {
    return {
      status: 'excluded_after_projection',
      periodIndex,
      recognizedOrderQty: 0,
      outstandingOrderQty: 0,
      demandResolvedQty: 0,
    };
  }
  if (periodIndex < 0) {
    return {
      status: 'included_prior',
      periodIndex,
      recognizedOrderQty: 0,
      outstandingOrderQty: contribution.outstandingOrderQty,
      demandResolvedQty: 0,
    };
  }
  return {
    status: 'included_period',
    periodIndex,
    recognizedOrderQty: contribution.recognizedOrderQty,
    outstandingOrderQty: contribution.outstandingOrderQty,
    demandResolvedQty: contribution.demandResolvedQty,
  };
}

export function summarizeAttributedFgMonthlyOrders(
  rows: ReadonlyArray<{
    contribution: OrderDemandContribution;
    attribution: FgMonthlyOrderAttribution;
  }>,
): OrderDemandSummary {
  return summarizeOrderDemandContributions(rows.map(({ contribution, attribution }) => ({
    ...contribution,
    recognizedOrderQty: attribution.recognizedOrderQty,
    outstandingOrderQty: attribution.outstandingOrderQty,
    demandResolvedQty: attribution.demandResolvedQty,
  })));
}

export function fgMonthlyDemandExplanation(
  period: FgMonthlySourcePeriod,
  aggregated: boolean,
) {
  if (aggregated) {
    return {
      kind: 'aggregated' as const,
      demandIntegrated: period.demandIntegrated,
    };
  }
  return {
    kind: 'formula' as const,
    ...fgMonthlyDemandCalculation(period),
  };
}

export function fgMonthlySourcePeriod(
  metric: FgMonthlySourceMetric,
  value: number,
  periodIndex: number | null,
  periodLabel: string,
): FgMonthlySourcePeriod {
  return {
    periodIndex,
    periodLabel,
    demandIntegrated: metric === 'demandIntegrated' ? value : 0,
    ordersUnshipped: metric === 'ordersUnshipped' ? value : 0,
    forecastQty: metric === 'forecastQty' ? value : 0,
    plannedOutput: metric === 'plannedOutput' ? value : 0,
    ordersTotal: metric === 'ordersTotal' ? value : 0,
    woScheduled: metric === 'woScheduled' ? value : 0,
    woUnscheduled: metric === 'woUnscheduled' ? value : 0,
    woTotal: metric === 'woTotal' ? value : 0,
    planReportedQty: metric === 'planReportedQty' ? value : 0,
    planClosedQty: metric === 'planClosedQty' ? value : 0,
  };
}
