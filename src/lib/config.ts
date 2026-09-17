/**
 * Application configuration — reads from environment variables
 */

export const config = {
  // Ragic
  ragicBaseUrl: 'https://demo.invalid',
  ragicApiKey: '',

  // Auth mode: 'session_cookie' (production, same domain) or 'api_key' (dev/remote)
  authMode: 'api_key' as 'session_cookie' | 'api_key',

  // Database
  dbMode: 'local' as 'local' | 'docker' | 'remote',
  databaseUrl: '',
  databaseUrls: {
    local: '',
    docker: '',
    remote: '',
  },

  // Email / SMTP
  smtp: {
    host: '',
    port: Number(587),
    user: '',
    pass: '',
    from: '',
  },
  notifyEmails: [] as string[],

  // MRP defaults
  mrp: {
    projectionMonths: 12,
    defaultBufferPct: 0.10,
    // 27 forward weeks + 1 prior bucket = 28 total, matching Ragic d4_21
    // line 1739 (`for (var i = 1; i <= 27; i++)`) and line 1776
    // (`avgUsagePerWeek = totalUsage / 28`). Was 28 forward, which produced
    // an extra W28 column not present in Ragic's CSV and inflated the
    // divisor to 29.
    componentWeeks: 27,
  },
} as const;
