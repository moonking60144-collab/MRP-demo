export interface SerializedColumnFilter {
  columnId: string;
  operator: string;
  value: string;
}

export interface SerializedSortField {
  key: string;
  dir: 'asc' | 'desc';
}

export interface CustomerCodeFacetOption {
  value: string;
  label: string;
  count: number;
}

export type ColumnFacetValueType = 'text' | 'numeric' | 'date' | 'enum' | 'boolean';

export interface ColumnFacetOption {
  value: string;
  label: string;
  count: number;
}

const COLUMN_FACET_VALUE_TYPES = new Set<ColumnFacetValueType>([
  'text', 'numeric', 'date', 'enum', 'boolean',
]);

export function parseColumnFacetValueType(value: string | null): ColumnFacetValueType | null {
  return value && COLUMN_FACET_VALUE_TYPES.has(value as ColumnFacetValueType)
    ? value as ColumnFacetValueType
    : null;
}

export function normalizeColumnFacetValue(
  value: unknown,
  valueType: ColumnFacetValueType,
): { value: string; label: string; sortValue: string | number } | null {
  if (value == null) return null;
  if (valueType === 'boolean') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') return null;
    const normalized = value === true || value === 'true';
    return { value: String(normalized), label: normalized ? '是' : '否', sortValue: normalized ? 1 : 0 };
  }
  if (valueType === 'numeric') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return { value: String(numeric), label: numeric.toLocaleString('zh-TW'), sortValue: numeric };
  }
  if (valueType === 'date') {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    const normalized = date.toISOString().slice(0, 10);
    return { value: normalized, label: normalized, sortValue: normalized };
  }
  const normalized = String(value).trim();
  return normalized ? { value: normalized, label: normalized, sortValue: normalized } : null;
}

export function collectColumnFacetOptions(
  rows: readonly unknown[],
  columnId: string,
  valueType: ColumnFacetValueType,
  query = '',
  limit = 100,
): ColumnFacetOption[] {
  const values = new Map<string, ColumnFacetOption & { sortValue: string | number }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !(columnId in row)) continue;
    const record = row as Record<string, unknown>;
    const normalized = normalizeColumnFacetValue(record[columnId], valueType);
    if (!normalized) continue;
    const rawCount = typeof record.count === 'number'
      ? record.count
      : typeof (record._count as { _all?: unknown } | undefined)?._all === 'number'
        ? (record._count as { _all: number })._all
        : 1;
    const current = values.get(normalized.value);
    if (current) current.count += rawCount;
    else values.set(normalized.value, { ...normalized, count: rawCount });
  }
  const expected = query.trim().toLocaleLowerCase();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  return [...values.values()]
    .filter((option) => (
      !expected
      || option.label.toLocaleLowerCase().includes(expected)
      || option.value.toLocaleLowerCase().includes(expected)
    ))
    .sort((left, right) => (
      typeof left.sortValue === 'number' && typeof right.sortValue === 'number'
        ? left.sortValue - right.sortValue
        : String(left.sortValue).localeCompare(String(right.sortValue))
    ))
    .slice(0, safeLimit)
    .map(({ value, label, count }) => ({ value, label, count }));
}

export function collectCustomerCodeOptions(rows: readonly unknown[]): string[] {
  return [...new Set(rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || !('customerCode' in row)) return [];
    const customerCode = (row as { customerCode?: unknown }).customerCode;
    return typeof customerCode === 'string' && customerCode.trim()
      ? [customerCode.trim()]
      : [];
  }))].sort((left, right) => left.localeCompare(right));
}

export function collectCustomerCodeFacetOptions(
  rows: readonly unknown[],
  query = '',
  limit = 100,
): CustomerCodeFacetOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('customerCode' in row)) continue;
    const customerCode = (row as { customerCode?: unknown }).customerCode;
    if (typeof customerCode !== 'string' || !customerCode.trim()) continue;
    const value = customerCode.trim();
    const rawCount = 'count' in row ? (row as { count?: unknown }).count : 1;
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0
      ? rawCount
      : 1;
    counts.set(value, (counts.get(value) || 0) + count);
  }
  const expected = query.trim().toLocaleLowerCase();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  return [...counts]
    .filter(([value]) => !expected || value.toLocaleLowerCase().includes(expected))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, safeLimit)
    .map(([value, count]) => ({ value, label: value, count }));
}

export function excludeSerializedColumnFilter(
  filters: SerializedColumnFilter[],
  columnId: string,
): SerializedColumnFilter[] {
  return filters.filter((filter) => filter.columnId !== columnId);
}

export function parseSerializedColumnFilters(
  searchParams: URLSearchParams,
  allowedColumns?: ReadonlySet<string>,
): SerializedColumnFilter[] {
  const filters: SerializedColumnFilter[] = [];
  searchParams.forEach((value, key) => {
    if (!key.startsWith('filter_')) return;
    const colonIdx = value.indexOf(':');
    if (colonIdx <= 0) return;
    const columnId = key.slice('filter_'.length);
    if (!columnId || (allowedColumns && !allowedColumns.has(columnId))) return;
    filters.push({
      columnId,
      operator: value.slice(0, colonIdx),
      value: value.slice(colonIdx + 1),
    });
  });
  return filters;
}

export function parseSerializedSortFields(
  value: string,
  allowedColumns: ReadonlySet<string>,
): SerializedSortField[] {
  if (!value) return [];
  const fields: SerializedSortField[] = [];
  for (const serializedField of value.split(',')) {
    const [key, dir] = serializedField.split(':');
    if (!key || !allowedColumns.has(key) || (dir !== 'asc' && dir !== 'desc')) continue;
    fields.push({ key, dir });
  }
  return fields;
}

function parseFiniteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOneOfValues(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean))]
      .slice(0, 100);
  } catch {
    return [];
  }
}

function oneOfValueType(operator: string): ColumnFacetValueType | null {
  if (operator === 'oneOf') return 'text';
  if (operator === 'oneOfNumber') return 'numeric';
  if (operator === 'oneOfDate') return 'date';
  if (operator === 'oneOfBoolean') return 'boolean';
  return null;
}

export function applySerializedColumnFiltersToPrismaWhere(
  where: Record<string, unknown>,
  filters: SerializedColumnFilter[],
  skippedColumns: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  for (const { columnId, operator, value } of filters) {
    if (skippedColumns.has(columnId)) continue;

    if (operator === 'contains' || operator === 'startsWith' || operator === 'endsWith') {
      where[columnId] = { [operator]: value, mode: 'insensitive' };
      continue;
    }
    if (operator === 'equals') {
      where[columnId] = { equals: value, mode: 'insensitive' };
      continue;
    }
    const oneOfType = oneOfValueType(operator);
    if (oneOfType) {
      const values = parseOneOfValues(value);
      if (values.length === 0) continue;
      if (oneOfType === 'numeric') {
        const numericValues = values.map(Number).filter(Number.isFinite);
        if (numericValues.length > 0) where[columnId] = { in: numericValues };
      } else if (oneOfType === 'boolean') {
        const booleanValues = values.flatMap((entry) => (
          entry === 'true' ? [true] : entry === 'false' ? [false] : []
        ));
        if (booleanValues.length > 0) where[columnId] = { in: booleanValues };
      } else if (oneOfType === 'date') {
        const dateValues = values
          .map(parseDate)
          .filter((entry): entry is Date => entry !== null);
        if (dateValues.length > 0) where[columnId] = { in: dateValues };
      } else {
        where[columnId] = { in: values, mode: 'insensitive' };
      }
      continue;
    }
    if (operator === 'equalsNumber') {
      const parsed = parseFiniteNumber(value);
      if (parsed !== null) where[columnId] = { equals: parsed };
      continue;
    }
    if (operator === 'equalsBoolean') {
      where[columnId] = { equals: value === 'true' };
      continue;
    }
    if (operator === 'isEmpty') {
      where[columnId] = null;
      continue;
    }
    if (operator === 'isNotEmpty') {
      where[columnId] = { not: null };
      continue;
    }
    if (operator.endsWith('Date')) {
      const dateOperator = operator.slice(0, -'Date'.length);
      const parsed = parseDate(value);
      if (parsed && ['equals', 'gt', 'gte', 'lt', 'lte'].includes(dateOperator)) {
        where[columnId] = { [dateOperator]: parsed };
      }
      continue;
    }
    if (operator === 'between') {
      const [minRaw, maxRaw] = value.split(',');
      const min = parseFiniteNumber(minRaw);
      const max = parseFiniteNumber(maxRaw);
      if (min !== null && max !== null) where[columnId] = { gte: min, lte: max };
      continue;
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
      const parsed = parseFiniteNumber(value);
      if (parsed !== null) where[columnId] = { [operator]: parsed };
    }
  }
  return where;
}

function compareDateValue(actual: unknown, expected: string): number | null {
  const actualDate = parseDate(String(actual ?? ''));
  const expectedDate = parseDate(expected);
  if (!actualDate || !expectedDate) return null;
  return actualDate.getTime() - expectedDate.getTime();
}

export function applySerializedColumnFiltersToRows<T>(
  rows: T[],
  filters: SerializedColumnFilter[],
  skippedColumns: ReadonlySet<string> = new Set(),
): T[] {
  return rows.filter((row) => filters.every(({ columnId, operator, value }) => {
    if (skippedColumns.has(columnId)) return true;
    const actual = (row as Record<string, unknown>)[columnId];

    if (operator === 'isEmpty') return actual == null || String(actual).trim() === '';
    if (operator === 'isNotEmpty') return actual != null && String(actual).trim() !== '';

    const actualText = String(actual ?? '').toLocaleLowerCase();
    const expectedText = value.toLocaleLowerCase();
    if (operator === 'contains') return actualText.includes(expectedText);
    if (operator === 'startsWith') return actualText.startsWith(expectedText);
    if (operator === 'endsWith') return actualText.endsWith(expectedText);
    if (operator === 'equals') return actualText === expectedText;
    const oneOfType = oneOfValueType(operator);
    if (oneOfType) {
      const values = parseOneOfValues(value);
      const normalizedActual = normalizeColumnFacetValue(actual, oneOfType);
      return !!normalizedActual && values.some((candidate) => (
        normalizedActual.value.toLocaleLowerCase() === candidate.toLocaleLowerCase()
      ));
    }

    if (operator.endsWith('Date')) {
      const dateOperator = operator.slice(0, -'Date'.length);
      const comparison = compareDateValue(actual, value);
      if (comparison === null) return false;
      if (dateOperator === 'equals') return comparison === 0;
      if (dateOperator === 'gt') return comparison > 0;
      if (dateOperator === 'gte') return comparison >= 0;
      if (dateOperator === 'lt') return comparison < 0;
      if (dateOperator === 'lte') return comparison <= 0;
      return true;
    }

    if (operator === 'equalsBoolean') return String(actual) === value;

    const actualNumber = Number(actual);
    if (!Number.isFinite(actualNumber)) return false;
    if (operator === 'equalsNumber') return actualNumber === Number(value);
    if (operator === 'gt') return actualNumber > Number(value);
    if (operator === 'gte') return actualNumber >= Number(value);
    if (operator === 'lt') return actualNumber < Number(value);
    if (operator === 'lte') return actualNumber <= Number(value);
    if (operator === 'between') {
      const [min, max] = value.split(',').map(Number);
      return actualNumber >= min && actualNumber <= max;
    }
    return true;
  }));
}
