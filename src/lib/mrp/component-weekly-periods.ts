export interface ComponentWeeklyRowRef {
  materialPartNo: string;
  mrpRunId: number;
  mrpType: string;
  dbSource?: string;
}

export interface ComponentWeeklyPeriodScope {
  dbSource?: string;
  runId: number;
  mrpType: string;
  materialPartNos: string[];
}

export interface ComponentWeeklyPeriodDetail {
  weekIndex: number;
  weekLabel: string | null;
  weekStart: string | null;
  remainingStock: number | null;
  usage: number;
  receipts: number;
}

export interface ComponentWeeklyPeriodLoadFailure {
  scope: ComponentWeeklyPeriodScope;
  rowKeys: string[];
  message: string;
}

export interface ComponentWeeklyPeriodLoadResult {
  periods: Record<string, ComponentWeeklyPeriodDetail[]>;
  failures: ComponentWeeklyPeriodLoadFailure[];
}

type PeriodFetcher = (input: string, init: RequestInit) => Promise<Response>;

function finiteNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`週期資料 ${field} 不是有效數字`);
  return number;
}

export function normalizeComponentWeeklyPeriod(value: unknown): ComponentWeeklyPeriodDetail {
  if (!value || typeof value !== 'object') throw new Error('週期資料格式錯誤');
  const period = value as Record<string, unknown>;
  return {
    weekIndex: finiteNumber(period.weekIndex, 'weekIndex'),
    weekLabel: period.weekLabel == null ? null : String(period.weekLabel),
    weekStart: period.weekStart == null ? null : String(period.weekStart),
    remainingStock: period.remainingStock == null
      ? null
      : finiteNumber(period.remainingStock, 'remainingStock'),
    usage: finiteNumber(period.usage, 'usage'),
    receipts: finiteNumber(period.receipts, 'receipts'),
  };
}

export function componentWeeklyRowKey(row: ComponentWeeklyRowRef): string {
  return [
    encodeURIComponent(row.dbSource || 'active'),
    row.mrpRunId,
    encodeURIComponent(row.mrpType),
    encodeURIComponent(row.materialPartNo),
  ].join('::');
}

export function componentWeeklyPeriodsCacheKey(rows: ComponentWeeklyRowRef[]): string | null {
  if (rows.length === 0) return null;
  return `/api/component-weekly/batch-periods?rows=${rows.map(componentWeeklyRowKey).join(',')}`;
}

export function groupComponentWeeklyPeriodScopes(rows: ComponentWeeklyRowRef[]): ComponentWeeklyPeriodScope[] {
  const scopes = new Map<string, ComponentWeeklyPeriodScope & { materials: Set<string> }>();

  for (const row of rows) {
    const scopeKey = [row.dbSource || 'active', row.mrpRunId, row.mrpType].join('::');
    let scope = scopes.get(scopeKey);
    if (!scope) {
      scope = {
        ...(row.dbSource ? { dbSource: row.dbSource } : {}),
        runId: row.mrpRunId,
        mrpType: row.mrpType,
        materialPartNos: [],
        materials: new Set<string>(),
      };
      scopes.set(scopeKey, scope);
    }
    scope.materials.add(row.materialPartNo);
  }

  return [...scopes.values()].map(({ materials, ...scope }) => ({
    ...scope,
    materialPartNos: [...materials],
  }));
}

export async function loadComponentWeeklyPeriods(
  rows: ComponentWeeklyRowRef[],
  fetcher: PeriodFetcher = fetch,
): Promise<ComponentWeeklyPeriodLoadResult> {
  const scopes = groupComponentWeeklyPeriodScopes(rows);
  const settled = await Promise.allSettled(scopes.map(async (scope) => {
    const response = await fetcher('/api/component-weekly/batch-periods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json() as {
      periods?: Record<string, unknown[]>;
      runId?: number;
      dbSource?: string | null;
    };
    const responseSource = json.dbSource ?? undefined;
    if (json.runId !== scope.runId || responseSource !== scope.dbSource) {
      throw new Error('回應來源或 Run 不符');
    }

    const periods: Record<string, ComponentWeeklyPeriodDetail[]> = {};
    const missingMaterialPartNos: string[] = [];
    for (const materialPartNo of scope.materialPartNos) {
      const materialPeriods = json.periods?.[materialPartNo];
      if (!materialPeriods || materialPeriods.length === 0) {
        missingMaterialPartNos.push(materialPartNo);
        continue;
      }
      periods[componentWeeklyRowKey({
        materialPartNo,
        mrpRunId: scope.runId,
        mrpType: scope.mrpType,
        dbSource: scope.dbSource,
      })] = materialPeriods.map(normalizeComponentWeeklyPeriod);
    }
    return { periods, missingMaterialPartNos };
  }));

  const periods: Record<string, ComponentWeeklyPeriodDetail[]> = {};
  const failures: ComponentWeeklyPeriodLoadFailure[] = [];
  settled.forEach((result, index) => {
    const scope = scopes[index]!;
    if (result.status === 'fulfilled') {
      Object.assign(periods, result.value.periods);
      if (result.value.missingMaterialPartNos.length > 0) {
        const missingScope = { ...scope, materialPartNos: result.value.missingMaterialPartNos };
        failures.push({
          scope: missingScope,
          rowKeys: result.value.missingMaterialPartNos.map((materialPartNo) => componentWeeklyRowKey({
            materialPartNo,
            mrpRunId: scope.runId,
            mrpType: scope.mrpType,
            dbSource: scope.dbSource,
          })),
          message: '找不到週期資料',
        });
      }
      return;
    }
    failures.push({
      scope,
      rowKeys: scope.materialPartNos.map((materialPartNo) => componentWeeklyRowKey({
        materialPartNo,
        mrpRunId: scope.runId,
        mrpType: scope.mrpType,
        dbSource: scope.dbSource,
      })),
      message: result.reason instanceof Error ? result.reason.message : '未知錯誤',
    });
  });

  return { periods, failures };
}
