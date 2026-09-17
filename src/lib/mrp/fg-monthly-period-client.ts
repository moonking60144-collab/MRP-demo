export interface FgMonthlyPeriodIdentity {
  partVersion: string;
  mrpRunId: number;
  dbSource?: string;
}

export interface FgMonthlyMemberIdentity extends FgMonthlyPeriodIdentity {
  aggregatedMembers?: string[];
}

export interface FgMonthlySourceResponseIdentity {
  partVersion: string;
  runId: number | null;
  dbSource?: string | null;
  sourcePartVersions?: string[];
}

export function fgMonthlyPeriodsCacheKey(
  identities: FgMonthlyPeriodIdentity[],
  aggregated: boolean,
): string | null {
  if (identities.length === 0) return null;
  return `/api/fg-monthly/batch-periods?aggregated=${aggregated ? 1 : 0}&identities=${encodeURIComponent(JSON.stringify(
    identities.map((identity) => [
      identity.partVersion,
      identity.mrpRunId,
      identity.dbSource ?? null,
    ]),
  ))}`;
}

export async function fetchFgMonthlyPeriodsByIdentity<T>(
  identities: FgMonthlyPeriodIdentity[],
  aggregated: boolean,
  options?: { signal?: AbortSignal },
): Promise<Record<string, T[]>> {
  const groups = new Map<string, {
    runId: number;
    dbSource?: string;
    partVersions: string[];
  }>();

  for (const identity of identities) {
    const partVersion = identity.partVersion.trim();
    if (!partVersion) continue;
    const key = `${identity.mrpRunId}\u0000${identity.dbSource ?? ''}`;
    const group = groups.get(key) ?? {
      runId: identity.mrpRunId,
      dbSource: identity.dbSource,
      partVersions: [],
    };
    if (!group.partVersions.includes(partVersion)) group.partVersions.push(partVersion);
    groups.set(key, group);
  }

  const batches = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const body: {
        partVersions: string[];
        runId: number;
        dbSource?: string;
        aggregated: boolean;
      } = {
        partVersions: group.partVersions,
        runId: group.runId,
        aggregated,
      };
      if (group.dbSource) body.dbSource = group.dbSource;

      const response = await fetch('/api/fg-monthly/batch-periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || `月推期間資料讀取失敗 (${response.status})`);
      }
      if (
        json.runId !== group.runId
        || (json.dbSource ?? undefined) !== group.dbSource
      ) {
        throw new Error('月推期間回應與選取的 MRP Run／資料庫來源不一致');
      }
      return (json.periods ?? {}) as Record<string, T[]>;
    }),
  );

  return Object.assign({}, ...batches) as Record<string, T[]>;
}

export async function fetchFgMonthlyMembersByIdentity<T>(
  parent: FgMonthlyMemberIdentity,
  options?: {
    sortFields?: string;
    excludeTest?: boolean;
    signal?: AbortSignal;
  },
): Promise<T[]> {
  const partVersions = [...new Set(
    (parent.aggregatedMembers ?? []).map((value) => value.trim()).filter(Boolean),
  )];
  if (partVersions.length === 0) return [];

  const params = new URLSearchParams({
    page: '1',
    limit: '500',
    partVersionsIn: partVersions.join(','),
    runId: String(parent.mrpRunId),
  });
  if (parent.dbSource) params.set('dbSource', parent.dbSource);
  if (options?.sortFields) params.set('sortFields', options.sortFields);
  if (options?.excludeTest) params.set('excludeTest', 'true');

  const response = await fetch(`/api/fg-monthly?${params}`, {
    signal: options?.signal,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `月推聚合成員讀取失敗 (${response.status})`);
  }
  if (
    json.runId !== parent.mrpRunId
    || (json.dbSource ?? undefined) !== parent.dbSource
  ) {
    throw new Error('月推聚合成員回應與選取的 MRP Run／資料庫來源不一致');
  }
  return (json.items ?? []) as T[];
}

export async function fetchFgMonthlySourcesByIdentity<
  T extends FgMonthlySourceResponseIdentity = FgMonthlySourceResponseIdentity,
>(
  identity: FgMonthlyMemberIdentity,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const params = new URLSearchParams({ runId: String(identity.mrpRunId) });
  if (identity.dbSource) params.set('dbSource', identity.dbSource);
  for (const memberPartVersion of identity.aggregatedMembers ?? []) {
    params.append('partVersion', memberPartVersion);
  }

  const response = await fetch(
    `/api/fg-monthly/${encodeURIComponent(identity.partVersion)}/sources?${params}`,
    { signal: options?.signal },
  );
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `月推來源總覽讀取失敗 (${response.status})`);
  }
  if (
    json.partVersion !== identity.partVersion
    || json.runId !== identity.mrpRunId
    || (json.dbSource ?? undefined) !== identity.dbSource
  ) {
    throw new Error('月推來源總覽回應與選取的料號／MRP Run／資料庫來源不一致');
  }
  const expectedMembers = [...new Set(
    (identity.aggregatedMembers ?? []).map((value) => value.trim()).filter(Boolean),
  )].sort();
  if (expectedMembers.length > 0) {
    const responseMembers = [...new Set(
      (json.sourcePartVersions ?? []).map((value: string) => value.trim()).filter(Boolean),
    )].sort();
    if (JSON.stringify(responseMembers) !== JSON.stringify(expectedMembers)) {
      throw new Error('月推來源總覽回應與選取的聚合成員不一致');
    }
  }
  return json as T;
}
