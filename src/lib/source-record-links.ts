export type SourceRecordType =
  | 'forecast'
  | 'inventory'
  | 'inventory-master'
  | 'inventory-lot'
  | 'inventory-movement'
  | 'order'
  | 'part-version'
  | 'production-plan'
  | 'purchase-order'
  | 'work-order'
  | 'work-order-bom';

export function buildSourceRecordUrl(
  type: SourceRecordType,
  recordId: string | null | undefined,
): string | null {
  const id = recordId?.trim();
  return id
    ? `/demo-record?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`
    : null;
}
