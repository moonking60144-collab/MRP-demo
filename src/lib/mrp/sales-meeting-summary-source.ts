import type {
  SalesMeetingItem,
  SalesMeetingSourceTarget,
  SalesMeetingSummaryKey,
} from './sales-meeting-types';

export function salesMeetingSummarySource(item: SalesMeetingItem, key: SalesMeetingSummaryKey): SalesMeetingSourceTarget {
  const recent = key === 'outstanding04' || key === 'fgDiff04';
  return {
    item,
    type: key === 'outstanding04' || key === 'totalOrderDemand' ? 'orders' : 'balance',
    scope: recent ? 'recent' : 'all',
    weekIndex: 0,
    weekLabel: recent ? '近期（前期＋前4週）' : '全部訂單（含12週以外）',
  };
}
