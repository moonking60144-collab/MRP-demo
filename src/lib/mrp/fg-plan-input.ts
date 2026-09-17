export function parsePositivePlanQty(value: unknown): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseFulfillToPeriod(value: unknown): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 12) return null;
  return Number.isInteger(parsed * 2) ? parsed : null;
}
