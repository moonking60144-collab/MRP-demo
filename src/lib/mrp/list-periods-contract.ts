export function groupPeriodRows<
  T extends Record<K, string>,
  K extends keyof T,
>(rows: T[], key: K): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const row of rows) {
    const value = row[key];
    if (!grouped[value]) grouped[value] = [];
    grouped[value]!.push(row);
  }
  return grouped;
}

export function hasCompletePeriodMap(
  identities: string[],
  periods: unknown,
): periods is Record<string, unknown[]> {
  if (!periods || typeof periods !== 'object') return false;
  const periodMap = periods as Record<string, unknown>;
  return identities.length > 0 && identities.every((identity) => (
    Array.isArray(periodMap[identity]) && periodMap[identity].length > 0
  ));
}

export interface SalesMeetingPeriodRowRef {
  partVersion: string;
  memberPartVersions?: string[];
  mrpRunId: number;
  dbSource?: string;
}

export function salesMeetingPeriodsCacheKey(
  rows: SalesMeetingPeriodRowRef[],
): string | null {
  if (rows.length === 0) return null;
  const identities = rows.map((row) => [
    row.dbSource ?? null,
    row.mrpRunId,
    row.partVersion,
    row.memberPartVersions || [row.partVersion],
  ]);
  return `/api/sales-meeting/batch-periods?identities=${encodeURIComponent(JSON.stringify(identities))}`;
}
