export function isTestErpPartNo(value: unknown): boolean {
  return typeof value === 'string' && value.toLocaleLowerCase().includes('test');
}

export interface NumericColumnFilter {
  operator: 'equals' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'isEmpty' | 'isNotEmpty';
  value: number | [number, number] | null;
}

export function parseNumericColumnFilter(value: string | null): NumericColumnFilter | null {
  if (!value) return null;
  const colonIndex = value.indexOf(':');
  if (colonIndex <= 0) return null;
  const operator = value.slice(0, colonIndex);
  const rawValue = value.slice(colonIndex + 1);

  if (operator === 'isEmpty' || operator === 'isNotEmpty') {
    return { operator, value: null };
  }

  if (operator === 'between') {
    const [min, max] = rawValue.split(',').map(Number);
    return Number.isFinite(min) && Number.isFinite(max)
      ? { operator, value: [min, max] }
      : null;
  }

  const normalizedOperator = operator === 'equalsNumber' ? 'equals' : operator;
  if (!['equals', 'gt', 'gte', 'lt', 'lte'].includes(normalizedOperator)) return null;
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) return null;
  return {
    operator: normalizedOperator as NumericColumnFilter['operator'],
    value: numericValue,
  };
}

export function matchesNumericColumnFilter(
  actualValue: number | null | undefined,
  filter: NumericColumnFilter,
): boolean {
  if (filter.operator === 'isEmpty') return actualValue == null;
  if (filter.operator === 'isNotEmpty') return actualValue != null;
  if (actualValue == null) return false;
  if (filter.operator === 'between') {
    const [min, max] = filter.value as [number, number];
    return actualValue >= min && actualValue <= max;
  }
  const expected = filter.value as number;
  switch (filter.operator) {
    case 'equals': return actualValue === expected;
    case 'gt': return actualValue > expected;
    case 'gte': return actualValue >= expected;
    case 'lt': return actualValue < expected;
    case 'lte': return actualValue <= expected;
  }
}

export function filterPartVersionsByInventoryAnomalyCount(
  rows: readonly {
    partVersion: string;
    erpPartNo: string | null;
    aggregatedMembers: readonly string[];
  }[],
  memberErpByPartVersion: ReadonlyMap<string, string | null>,
  anomalyCountByErp: ReadonlyMap<string, number>,
  filter: NumericColumnFilter,
): string[] {
  return rows.flatMap((row) => {
    const erpPartNos = row.aggregatedMembers.length > 0
      ? row.aggregatedMembers.flatMap((member) => memberErpByPartVersion.get(member) ?? [])
      : row.erpPartNo ? [row.erpPartNo] : [];
    const anomalyCount = [...new Set(erpPartNos)].reduce(
      (total, erpPartNo) => total + (anomalyCountByErp.get(erpPartNo) ?? 0),
      0,
    );
    return matchesNumericColumnFilter(anomalyCount, filter) ? [row.partVersion] : [];
  });
}
