const RAGIC_STATUS_LABELS: Record<string, string> = {
  healthy: '連線正常',
  slow: '連線延遲',
  dns_error: 'DNS 解析失敗',
  connect_timeout: 'HTTPS 連線逾時',
  tls_error: 'TLS 憑證異常',
  http_error: 'HTTP 回應異常',
  api_error: 'API 拒絕請求',
  invalid_response: '回應格式異常',
  config_error: '後端連線設定異常',
  network_error: '網路異常',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatTaipeiDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatRagicPreflightError(
  payload: unknown,
  fallback: string,
): string {
  if (!isRecord(payload)) return fallback;
  const baseError = typeof payload.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : fallback;
  if (isRecord(payload.dbHealth)) {
    const health = payload.dbHealth;
    const missing = Array.isArray(health.missing)
      ? health.missing.filter((item): item is string => typeof item === 'string')
      : [];
    if (missing.length > 0) {
      return [
        '資料庫結構尚未更新，MRP 未開始執行。',
        `缺少項目：${missing.slice(0, 8).join('、')}${missing.length > 8 ? `，另 ${missing.length - 8} 項` : ''}`,
        '請先套用版本控制內的 prisma/init.sql migration，再重新執行。',
      ].join('\n');
    }
    if (typeof health.error === 'string' && health.error.trim()) {
      return `資料庫檢查失敗，MRP 未開始執行。\n技術資訊：${health.error.trim()}`;
    }
  }
  if (!isRecord(payload.ragicHealth)) return baseError;

  const health = payload.ragicHealth;
  const status = typeof health.status === 'string' ? health.status : '';
  const label = RAGIC_STATUS_LABELS[status];
  if (!label) return baseError;

  const lines = [`Ragic ${label}，MRP 未開始執行。`];
  const lastSuccess = formatTaipeiDateTime(health.lastSuccessAt);
  if (lastSuccess) lines.push(`最近成功：${lastSuccess}`);

  const technicalError = typeof health.error === 'string' ? health.error.trim() : '';
  if (technicalError) {
    lines.push(`技術資訊：${technicalError}`);
  } else if (typeof health.statusCode === 'number') {
    lines.push(`技術資訊：HTTP ${health.statusCode}`);
  }
  return lines.join('\n');
}
