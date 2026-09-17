export const ORDER_DEMAND_CONTRACT_V1 = 'order-demand-v1';
export const ORDER_DEMAND_CONTRACT_V2 = 'order-demand-v2-manual-close';

export type OrderDemandContractVersion =
  | typeof ORDER_DEMAND_CONTRACT_V1
  | typeof ORDER_DEMAND_CONTRACT_V2;

export type OrderDemandContributionBasis =
  | 'legacy_manual_close_excluded'
  | 'open_order_unshipped'
  | 'closed_order_completed'
  | 'manual_close_actual_shipped';

export type OrderDemandAnomaly =
  | 'manual_close_shipped_unknown'
  | 'prepared_exceeds_order'
  | 'shipped_exceeds_order'
  | 'sold_exceeds_order'
  | 'shipped_exceeds_prepared'
  | 'sold_exceeds_shipped';

export const ORDER_DEMAND_BASIS_LABELS: Record<OrderDemandContributionBasis, string> = {
  legacy_manual_close_excluded: '歷史規則：人工結案排除',
  open_order_unshipped: '一般訂單：以未出庫量承擔需求',
  closed_order_completed: '一般結案：無未出庫需求',
  manual_close_actual_shipped: '人工結案：以實際出庫認列',
};

export const ORDER_DEMAND_ANOMALY_LABELS: Record<OrderDemandAnomaly, string> = {
  manual_close_shipped_unknown: '人工結案缺少實際已出庫量',
  prepared_exceeds_order: '已備貨量大於原始訂單量',
  shipped_exceeds_order: '已出庫量大於原始訂單量',
  sold_exceeds_order: '已銷貨量大於原始訂單量',
  shipped_exceeds_prepared: '已出庫量大於已備貨量',
  sold_exceeds_shipped: '已銷貨量大於已出庫量',
};

export interface OrderDemandInput {
  orderQty: unknown;
  preparedQty?: unknown;
  unprepQty?: unknown;
  shippedQty?: unknown;
  unshippedQty?: unknown;
  soldQty?: unknown;
  unsoldQty?: unknown;
  prepStatus?: string | null;
  shipmentStatus?: string | null;
  salesStatus?: string | null;
}

export interface OrderDemandContribution {
  contractVersion: OrderDemandContractVersion;
  isManualClose: boolean;
  basis: OrderDemandContributionBasis;
  rawOrderQty: number;
  preparedQty: number | null;
  shippedQty: number | null;
  soldQty: number | null;
  sourceUnprepQty: number | null;
  sourceUnshippedQty: number | null;
  sourceUnsoldQty: number | null;
  remainingToPrepareQty: number | null;
  remainingToShipQty: number | null;
  remainingToSellQty: number | null;
  preparedNotShippedQty: number | null;
  recognizedOrderQty: number;
  outstandingOrderQty: number;
  demandResolvedQty: number;
  closedUnfulfilledQty: number | null;
  anomalies: OrderDemandAnomaly[];
}

export interface OrderDemandSummary {
  orderCount: number;
  manualCloseCount: number;
  anomalyCount: number;
  unknownPreparedCount: number;
  unknownShippedCount: number;
  unknownSoldCount: number;
  unknownPreparedNotShippedCount: number;
  unknownClosedUnfulfilledCount: number;
  rawOrderQty: number;
  preparedQty: number;
  shippedQty: number;
  soldQty: number;
  preparedNotShippedQty: number;
  recognizedOrderQty: number;
  outstandingOrderQty: number;
  demandResolvedQty: number;
  closedUnfulfilledQty: number;
}

export function normalizeOrderDemandContractVersion(
  value: string | null | undefined,
): OrderDemandContractVersion {
  if (value == null || value === '' || value === ORDER_DEMAND_CONTRACT_V1) {
    return ORDER_DEMAND_CONTRACT_V1;
  }
  if (value === ORDER_DEMAND_CONTRACT_V2) return ORDER_DEMAND_CONTRACT_V2;
  throw new Error(`Unsupported order demand contract version: ${value}`);
}

function quantityOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function addIfKnown(total: number, value: number | null): number {
  return value === null ? total : total + value;
}

export function resolveOrderDemandContribution(
  order: OrderDemandInput,
  contractVersionInput: string | null | undefined,
): OrderDemandContribution {
  const contractVersion = normalizeOrderDemandContractVersion(contractVersionInput);
  const rawOrderQty = quantityOrNull(order.orderQty) ?? 0;
  const preparedQty = quantityOrNull(order.preparedQty);
  const shippedQty = quantityOrNull(order.shippedQty);
  const soldQty = quantityOrNull(order.soldQty);
  const sourceUnprepQty = quantityOrNull(order.unprepQty);
  const sourceUnshippedQty = quantityOrNull(order.unshippedQty);
  const sourceUnsoldQty = quantityOrNull(order.unsoldQty);
  const isManualClose = order.prepStatus?.trim() === '人工結案';
  const anomalies: OrderDemandAnomaly[] = [];

  if (preparedQty !== null && preparedQty > rawOrderQty) anomalies.push('prepared_exceeds_order');
  if (shippedQty !== null && shippedQty > rawOrderQty) anomalies.push('shipped_exceeds_order');
  if (soldQty !== null && soldQty > rawOrderQty) anomalies.push('sold_exceeds_order');
  if (preparedQty !== null && shippedQty !== null && shippedQty > preparedQty) {
    anomalies.push('shipped_exceeds_prepared');
  }
  if (shippedQty !== null && soldQty !== null && soldQty > shippedQty) {
    anomalies.push('sold_exceeds_shipped');
  }

  const remainingToPrepareQty = preparedQty === null
    ? null
    : Math.max(0, rawOrderQty - preparedQty);
  const remainingToShipQty = shippedQty === null
    ? null
    : Math.max(0, rawOrderQty - shippedQty);
  const remainingToSellQty = soldQty === null
    ? null
    : Math.max(0, rawOrderQty - soldQty);
  const preparedNotShippedQty = preparedQty === null || shippedQty === null
    ? null
    : Math.max(0, preparedQty - shippedQty);

  if (isManualClose) {
    if (contractVersion === ORDER_DEMAND_CONTRACT_V1) {
      return {
        contractVersion,
        isManualClose,
        basis: 'legacy_manual_close_excluded',
        rawOrderQty,
        preparedQty,
        shippedQty,
        soldQty,
        sourceUnprepQty,
        sourceUnshippedQty,
        sourceUnsoldQty,
        remainingToPrepareQty,
        remainingToShipQty,
        remainingToSellQty,
        preparedNotShippedQty,
        recognizedOrderQty: 0,
        outstandingOrderQty: 0,
        demandResolvedQty: 0,
        closedUnfulfilledQty: shippedQty === null
          ? null
          : Math.max(0, rawOrderQty - Math.min(rawOrderQty, shippedQty)),
        anomalies,
      };
    }

    if (shippedQty === null) anomalies.push('manual_close_shipped_unknown');
    const recognizedOrderQty = Math.min(rawOrderQty, shippedQty ?? 0);
    return {
      contractVersion,
      isManualClose,
      basis: 'manual_close_actual_shipped',
      rawOrderQty,
      preparedQty,
      shippedQty,
      soldQty,
      sourceUnprepQty,
      sourceUnshippedQty,
      sourceUnsoldQty,
      remainingToPrepareQty,
      remainingToShipQty,
      remainingToSellQty,
      preparedNotShippedQty,
      recognizedOrderQty,
      outstandingOrderQty: 0,
      demandResolvedQty: recognizedOrderQty,
      closedUnfulfilledQty: shippedQty === null
        ? null
        : Math.max(0, rawOrderQty - recognizedOrderQty),
      anomalies,
    };
  }

  const recognizedOrderQty = rawOrderQty;
  const outstandingOrderQty = order.salesStatus === '未結案'
    ? sourceUnshippedQty ?? 0
    : 0;
  return {
    contractVersion,
    isManualClose,
    basis: order.salesStatus === '未結案'
      ? 'open_order_unshipped'
      : 'closed_order_completed',
    rawOrderQty,
    preparedQty,
    shippedQty,
    soldQty,
    sourceUnprepQty,
    sourceUnshippedQty,
    sourceUnsoldQty,
    remainingToPrepareQty,
    remainingToShipQty,
    remainingToSellQty,
    preparedNotShippedQty,
    recognizedOrderQty,
    outstandingOrderQty,
    demandResolvedQty: Math.max(0, recognizedOrderQty - outstandingOrderQty),
    closedUnfulfilledQty: 0,
    anomalies,
  };
}

export function summarizeOrderDemandContributions(
  contributions: readonly OrderDemandContribution[],
): OrderDemandSummary {
  return contributions.reduce<OrderDemandSummary>((summary, contribution) => ({
    orderCount: summary.orderCount + 1,
    manualCloseCount: summary.manualCloseCount + (contribution.isManualClose ? 1 : 0),
    anomalyCount: summary.anomalyCount + (contribution.anomalies.length > 0 ? 1 : 0),
    unknownPreparedCount: summary.unknownPreparedCount + (contribution.preparedQty === null ? 1 : 0),
    unknownShippedCount: summary.unknownShippedCount + (contribution.shippedQty === null ? 1 : 0),
    unknownSoldCount: summary.unknownSoldCount + (contribution.soldQty === null ? 1 : 0),
    unknownPreparedNotShippedCount: summary.unknownPreparedNotShippedCount
      + (contribution.preparedNotShippedQty === null ? 1 : 0),
    unknownClosedUnfulfilledCount: summary.unknownClosedUnfulfilledCount
      + (contribution.closedUnfulfilledQty === null ? 1 : 0),
    rawOrderQty: summary.rawOrderQty + contribution.rawOrderQty,
    preparedQty: addIfKnown(summary.preparedQty, contribution.preparedQty),
    shippedQty: addIfKnown(summary.shippedQty, contribution.shippedQty),
    soldQty: addIfKnown(summary.soldQty, contribution.soldQty),
    preparedNotShippedQty: addIfKnown(
      summary.preparedNotShippedQty,
      contribution.preparedNotShippedQty,
    ),
    recognizedOrderQty: summary.recognizedOrderQty + contribution.recognizedOrderQty,
    outstandingOrderQty: summary.outstandingOrderQty + contribution.outstandingOrderQty,
    demandResolvedQty: summary.demandResolvedQty + contribution.demandResolvedQty,
    closedUnfulfilledQty: addIfKnown(
      summary.closedUnfulfilledQty,
      contribution.closedUnfulfilledQty,
    ),
  }), {
    orderCount: 0,
    manualCloseCount: 0,
    anomalyCount: 0,
    unknownPreparedCount: 0,
    unknownShippedCount: 0,
    unknownSoldCount: 0,
    unknownPreparedNotShippedCount: 0,
    unknownClosedUnfulfilledCount: 0,
    rawOrderQty: 0,
    preparedQty: 0,
    shippedQty: 0,
    soldQty: 0,
    preparedNotShippedQty: 0,
    recognizedOrderQty: 0,
    outstandingOrderQty: 0,
    demandResolvedQty: 0,
    closedUnfulfilledQty: 0,
  });
}
