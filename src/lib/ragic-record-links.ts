export type RagicRecordType =
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

const RAGIC_RECORD_PATHS: Record<RagicRecordType, string> = {
  forecast: 'forms31/6',
  inventory: 'forms12/8',
  'inventory-master': 'g6mrp/1',
  'inventory-lot': 'forms4/16',
  'inventory-movement': 'forms4/20',
  order: 'forms31/2',
  'part-version': 'forms31/10',
  'production-plan': 'd4/10',
  'purchase-order': 'p6mrp/1',
  'work-order': 'forms8/92',
  'work-order-bom': 'forms8/28',
};

const RAGIC_BASE = '';

export function buildRagicRecordUrl(
  type: RagicRecordType,
  recordId: string | null | undefined,
): string | null {
  const normalizedId = recordId?.trim();
  return normalizedId
    ? `${RAGIC_BASE}/demo-record?type=${encodeURIComponent(type)}&id=${encodeURIComponent(normalizedId)}&form=${encodeURIComponent(RAGIC_RECORD_PATHS[type])}`
    : null;
}
