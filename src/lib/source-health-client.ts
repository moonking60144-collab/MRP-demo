function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatSourcePreflightError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const message = typeof payload.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : fallback;
  if (!isRecord(payload.dbHealth)) return message;
  const missing = Array.isArray(payload.dbHealth.missing)
    ? payload.dbHealth.missing.filter((item): item is string => typeof item === 'string')
    : [];
  return missing.length
    ? `Demo 資料結構尚未準備完成。\n缺少項目：${missing.slice(0, 8).join('、')}`
    : message;
}
