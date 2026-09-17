import { serializeColumnFilter } from './hooks/use-table-filtering';
import {
  createColumnFilterOptionsFingerprint,
  type ColumnFilterOption,
  type ColumnFilterOptionsContext,
} from './column-header-contract';

const CACHE_TTL_MS = 30_000;
const optionCache = new Map<string, {
  expiresAt: number;
  options: ColumnFilterOption[];
}>();

function resolveEndpoint(tableId: string): string {
  if (tableId === 'fg_monthly_detailed' || tableId === 'fg_monthly_traditional') {
    return '/api/fg-monthly';
  }
  if (
    tableId === 'sales_meeting'
    || tableId === 'sales_meeting_detailed'
    || tableId === 'sales_meeting_traditional'
  ) {
    return '/api/sales-meeting';
  }
  if (tableId.startsWith('component_weekly_')) return '/api/component-weekly';
  if (tableId.startsWith('source_')) return '/api/source-data';
  throw new Error(`不支援的 server facet tableId: ${tableId}`);
}

function appendFixedScope(
  params: URLSearchParams,
  fixedScope: ColumnFilterOptionsContext['fixedScope'],
) {
  for (const [key, value] of Object.entries(fixedScope || {})) {
    if (value === undefined || value === null || value === false || value === '') continue;
    params.set(key, String(value));
  }
}

export function buildColumnFilterOptionsUrl(context: ColumnFilterOptionsContext): string {
  if (!context.columnId || !context.valueType) throw new Error('server facet 缺少欄位或型別');
  const params = new URLSearchParams({
    facet: context.columnId,
    facetType: context.valueType,
    page: '1',
    limit: '1',
  });
  if (context.runId != null && !context.mergeDb) params.set('runId', String(context.runId));
  if (context.dbSource) params.set('dbSource', context.dbSource);
  if (context.mergeDb) params.set('merge', 'true');
  if (context.tableId.startsWith('component_weekly_')) {
    params.set('mrpType', context.tableId.slice('component_weekly_'.length));
  }
  if (context.tableId.startsWith('source_')) {
    params.set('table', context.tableId.slice('source_'.length));
  }
  if (context.globalSearch) params.set('search', context.globalSearch);
  if (context.query) params.set('facetQuery', context.query);
  if (context.limit) params.set('facetLimit', String(context.limit));
  appendFixedScope(params, context.fixedScope);
  for (const filter of context.columnFilters) {
    if (filter.columnId === context.columnId) continue;
    params.set(`filter_${filter.columnId}`, serializeColumnFilter(filter));
  }
  return `${resolveEndpoint(context.tableId)}?${params}`;
}

async function requestColumnFilterOptions(
  context: ColumnFilterOptionsContext,
  signal?: AbortSignal,
): Promise<ColumnFilterOption[]> {
  const response = await fetch(buildColumnFilterOptionsUrl(context), { signal });
  const json = await response.json() as {
    error?: string;
    facet?: unknown;
    options?: unknown;
    runId?: unknown;
    dbSource?: unknown;
    merge?: unknown;
  };
  if (!response.ok) {
    throw new Error(json.error || `欄位選項讀取失敗 (${response.status})`);
  }
  if (json.facet !== context.columnId) throw new Error('欄位選項回應與請求欄位不一致');
  if (context.mergeDb) {
    if (json.merge !== true) throw new Error('欄位選項回應與合併資料來源不一致');
  } else {
    if (context.runId != null && json.runId !== context.runId) {
      throw new Error('欄位選項回應與選取的 MRP Run 不一致');
    }
    if (context.runId == null && (!Number.isInteger(json.runId) || Number(json.runId) <= 0)) {
      throw new Error('欄位選項回應缺少有效的 MRP Run');
    }
    if ((json.dbSource ?? null) !== (context.dbSource ?? null)) {
      throw new Error('欄位選項回應與選取的資料庫來源不一致');
    }
  }
  if (!Array.isArray(json.options)) return [];
  return json.options.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const candidate = option as { value?: unknown; label?: unknown; count?: unknown };
    if (typeof candidate.value !== 'string' || typeof candidate.label !== 'string') return [];
    return [{
      value: candidate.value,
      label: candidate.label,
      ...(typeof candidate.count === 'number' ? { count: candidate.count } : {}),
    }];
  });
}

export function loadColumnFilterOptions(
  context: ColumnFilterOptionsContext,
  signal?: AbortSignal,
): Promise<ColumnFilterOption[]> {
  const key = createColumnFilterOptionsFingerprint(context);
  const cached = optionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.options);
  return requestColumnFilterOptions(context, signal).then((options) => {
    optionCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, options });
    return options;
  });
}
