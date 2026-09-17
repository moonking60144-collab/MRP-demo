import type { VirtualTableGroup } from '@/components/ui/virtual-table-groups';

export function buildFgRowGroups(items: { id: number; forgingParent: string | null; aggregatedMembers?: string[] | null }[], options: {
  showTree: boolean;
  aggregated: boolean;
  expanded: ReadonlySet<number>;
  memberCounts: Record<number, number>;
  loading: Record<number, boolean>;
}): VirtualTableGroup[] {
  const groups: VirtualTableGroup[] = [];
  let rowCount = 0;
  for (let start = 0; start < items.length;) {
    let end = start + 1;
    if (options.showTree) while (end < items.length && (items[end].forgingParent || '') === (items[start].forgingParent || '')) end++;
    let height = 0;
    let parts = 0;
    const stripeStart = rowCount;
    for (let index = start; index < end; index++) {
      const item = items[index];
      const members = item.aggregatedMembers?.length ?? 1;
      parts += Math.max(1, members);
      height += 24;
      rowCount++;
      if (options.aggregated && members > 1 && options.expanded.has(item.id)) {
        height += options.loading[item.id] ? 32 : (options.memberCounts[item.id] ?? 0) * 24;
        rowCount += options.loading[item.id] ? 1 : (options.memberCounts[item.id] ?? 0);
      }
    }
    if (options.showTree && (end - start > 1 || parts > 1)) { height += 24; rowCount++; }
    groups.push({ key: String(items[start].id), start, end, estimatedHeight: height, stripeStart });
    start = end;
  }
  return groups;
}
