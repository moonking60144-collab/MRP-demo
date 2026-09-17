// Null-safe sort comparators for client-side sorting

export function compareValues(
  a: unknown,
  b: unknown,
  direction: 'asc' | 'desc',
): number {
  const mul = direction === 'asc' ? 1 : -1;

  // Nulls always last
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  // Numbers
  if (typeof a === 'number' && typeof b === 'number') {
    return (a - b) * mul;
  }

  // Booleans
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return ((a ? 1 : 0) - (b ? 1 : 0)) * mul;
  }

  // Strings (try numeric parse first)
  const strA = String(a);
  const strB = String(b);
  const numA = parseFloat(strA);
  const numB = parseFloat(strB);
  if (!isNaN(numA) && !isNaN(numB)) {
    return (numA - numB) * mul;
  }

  return strA.localeCompare(strB, 'zh-TW') * mul;
}

export function multiFieldSort<T extends Record<string, unknown>>(
  items: T[],
  sortFields: { id: string; direction: 'asc' | 'desc' }[],
): T[] {
  if (sortFields.length === 0) return items;
  return [...items].sort((a, b) => {
    for (const field of sortFields) {
      const result = compareValues(a[field.id], b[field.id], field.direction);
      if (result !== 0) return result;
    }
    return 0;
  });
}
