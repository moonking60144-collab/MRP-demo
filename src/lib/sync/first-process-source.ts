export function aggregateFirstProcessValue(
  values: readonly (string | null | undefined)[],
): string | null {
  const unique = new Set(values.map((value) => value ?? null));
  return unique.size > 1 ? '混合' : [...unique][0] ?? null;
}
