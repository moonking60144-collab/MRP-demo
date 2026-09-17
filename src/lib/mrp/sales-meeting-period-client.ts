import type { SalesMeetingPeriodRowRef } from './list-periods-contract';

const PERIOD_GROUP_BATCH_SIZE = 1000;

export interface SalesMeetingPeriodRequestGroup {
  partVersion: string;
  memberPartVersions: string[];
}

export interface SalesMeetingPeriodScope {
  runId: number;
  dbSource?: string;
  groups: SalesMeetingPeriodRequestGroup[];
}

type PeriodFetcher = (input: string, init: RequestInit) => Promise<Response>;

export function groupSalesMeetingPeriodScopes(
  rows: SalesMeetingPeriodRowRef[],
): SalesMeetingPeriodScope[] {
  const scopes = new Map<string, SalesMeetingPeriodScope & {
    groupsByPartVersion: Map<string, SalesMeetingPeriodRequestGroup>;
  }>();

  for (const row of rows) {
    const partVersion = row.partVersion.trim();
    if (!partVersion) continue;
    const members = [...new Set(
      (row.memberPartVersions || [partVersion]).map((value) => value.trim()).filter(Boolean),
    )];
    if (!members.includes(partVersion)) members.unshift(partVersion);

    const scopeKey = `${row.dbSource || 'active'}\u0000${row.mrpRunId}`;
    let scope = scopes.get(scopeKey);
    if (!scope) {
      scope = {
        runId: row.mrpRunId,
        ...(row.dbSource ? { dbSource: row.dbSource } : {}),
        groups: [],
        groupsByPartVersion: new Map(),
      };
      scopes.set(scopeKey, scope);
    }
    scope.groupsByPartVersion.set(partVersion, { partVersion, memberPartVersions: members });
  }

  return [...scopes.values()].map(({ groupsByPartVersion, ...scope }) => ({
    ...scope,
    groups: [...groupsByPartVersion.values()],
  }));
}

export async function loadSalesMeetingPeriods<T>(
  rows: SalesMeetingPeriodRowRef[],
  options: { fetcher?: PeriodFetcher; signal?: AbortSignal } = {},
): Promise<Record<string, T[]>> {
  const fetcher = options.fetcher || fetch;
  const requests = groupSalesMeetingPeriodScopes(rows).flatMap((scope) => {
    const chunks: SalesMeetingPeriodScope[] = [];
    for (let index = 0; index < scope.groups.length; index += PERIOD_GROUP_BATCH_SIZE) {
      chunks.push({ ...scope, groups: scope.groups.slice(index, index + PERIOD_GROUP_BATCH_SIZE) });
    }
    return chunks;
  });

  const batches = await Promise.all(requests.map(async (scope) => {
    const response = await fetcher('/api/sales-meeting/batch-periods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
      signal: options.signal,
    });
    const json = await response.json() as {
      error?: string;
      periods?: Record<string, T[]>;
      runId?: number | null;
      dbSource?: string | null;
    };
    if (!response.ok) {
      throw new Error(json.error || `產銷週期資料讀取失敗 (${response.status})`);
    }
    if (
      json.runId !== scope.runId
      || (json.dbSource ?? undefined) !== scope.dbSource
    ) {
      throw new Error('產銷週期回應與選取的 MRP Run／資料庫來源不一致');
    }
    return json.periods || {};
  }));

  return Object.assign({}, ...batches) as Record<string, T[]>;
}
