import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Prisma, type PrismaClient } from '@prisma/client';
import { config } from './config';
import prisma from './db';

const LAST_RAGIC_HEALTH_KEY = 'ragic_health_last_result';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SLOW_MS = 3_000;
const HEALTH_CACHE_MS = 30_000;

export type RagicHealthStatus =
  | 'healthy'
  | 'slow'
  | 'dns_error'
  | 'connect_timeout'
  | 'tls_error'
  | 'http_error'
  | 'api_error'
  | 'invalid_response'
  | 'config_error'
  | 'network_error';

export interface RagicNetworkTimings {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  totalMs: number;
}

export interface RagicHealthResult {
  ok: boolean;
  status: RagicHealthStatus;
  checkedAt: string;
  lastSuccessAt: string | null;
  statusCode: number | null;
  timings: RagicNetworkTimings;
  error: string | null;
}

interface ProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  slowMs?: number;
}

interface CheckOptions {
  force?: boolean;
  client?: PrismaClient;
  probe?: () => Promise<RagicHealthResult>;
}

interface SnapshotOptions {
  client?: PrismaClient;
  refresh?: () => Promise<RagicHealthResult>;
}

const HEALTH_RESULT_KEYS = new Set([
  'ok',
  'status',
  'checkedAt',
  'lastSuccessAt',
  'statusCode',
  'timings',
  'error',
]);
const TIMING_KEYS = new Set([
  'dnsMs',
  'tcpMs',
  'tlsMs',
  'ttfbMs',
  'downloadMs',
  'totalMs',
]);
const VALID_STATUSES = new Set<RagicHealthStatus>([
  'healthy',
  'slow',
  'dns_error',
  'connect_timeout',
  'tls_error',
  'http_error',
  'api_error',
  'invalid_response',
  'config_error',
  'network_error',
]);

let cachedHealth: { result: RagicHealthResult; expiresAt: number } | null = null;
let healthInFlight: Promise<RagicHealthResult> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableDuration(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function roundDuration(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}

function elapsed(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  return roundDuration(now - before);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function buildTimings(
  startedAt: number,
  lookupAt: number | null,
  connectAt: number | null,
  secureAt: number | null,
  responseAt: number | null,
  completedAt: number,
): RagicNetworkTimings {
  const connectionReadyAt = secureAt ?? connectAt ?? lookupAt ?? startedAt;
  return {
    dnsMs: elapsed(lookupAt, startedAt),
    tcpMs: elapsed(connectAt, lookupAt ?? startedAt),
    tlsMs: elapsed(secureAt, connectAt ?? lookupAt ?? startedAt),
    ttfbMs: elapsed(responseAt, connectionReadyAt),
    downloadMs: elapsed(completedAt, responseAt),
    totalMs: Math.max(0, Math.round(completedAt - startedAt)),
  };
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyRagicProbeError(error: unknown): RagicHealthStatus {
  const code = errorCode(error).toUpperCase();
  const message = errorMessage(error);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|dns/i.test(message)) {
    return 'dns_error';
  }
  if (
    code === 'PREFLIGHT_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /connect timeout|timed out|timeout/i.test(message)
  ) {
    return 'connect_timeout';
  }
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    /certificate|tls|ssl/i.test(message)
  ) {
    return 'tls_error';
  }
  return 'network_error';
}

function createResult(
  status: RagicHealthStatus,
  checkedAt: Date,
  timings: RagicNetworkTimings,
  options?: { statusCode?: number | null; error?: string | null },
): RagicHealthResult {
  const ok = status === 'healthy' || status === 'slow';
  const checkedAtIso = checkedAt.toISOString();
  return {
    ok,
    status,
    checkedAt: checkedAtIso,
    lastSuccessAt: ok ? checkedAtIso : null,
    statusCode: options?.statusCode ?? null,
    timings,
    error: options?.error ?? null,
  };
}

export async function probeRagicHealth(
  options: ProbeOptions = {},
): Promise<RagicHealthResult> {
  const checkedAt = new Date();
  const baseUrl = options.baseUrl ?? config.ragicBaseUrl;
  const apiKey = options.apiKey ?? config.ragicApiKey;
  const timeoutMs = positiveDuration(
    options.timeoutMs ?? Number(process.env.RAGIC_PREFLIGHT_TIMEOUT_MS),
    DEFAULT_TIMEOUT_MS,
  );
  const slowMs = positiveDuration(
    options.slowMs ?? Number(process.env.RAGIC_HEALTH_SLOW_MS),
    DEFAULT_SLOW_MS,
  );
  const emptyTimings: RagicNetworkTimings = {
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    ttfbMs: null,
    downloadMs: null,
    totalMs: 0,
  };

  if (!apiKey) {
    return createResult('config_error', checkedAt, emptyTimings, {
      error: 'RAGIC_API_KEY 未設定',
    });
  }

  let target: URL;
  try {
    target = new URL('/default/e6mrp/1', baseUrl);
  } catch {
    return createResult('config_error', checkedAt, emptyTimings, {
      error: 'RAGIC_BASE_URL 格式無效',
    });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return createResult('config_error', checkedAt, emptyTimings, {
      error: `RAGIC_BASE_URL 不支援 ${target.protocol}`,
    });
  }

  target.searchParams.set('api', '');
  target.searchParams.set('v', '3');
  target.searchParams.set('naming', 'EID');
  target.searchParams.set('limit', '1');
  target.searchParams.set('listing', 'true');
  target.searchParams.set('subtables', '0');
  target.searchParams.set('fetchDomainIds', '1006554');
  target.searchParams.set('where', '1006554,eq,使用中');

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let lookupAt: number | null = null;
    let connectAt: number | null = null;
    let secureAt: number | null = null;
    let responseAt: number | null = null;
    let settled = false;
    let cancelHardTimeout = () => {};

    const finish = (result: RagicHealthResult) => {
      if (settled) return;
      settled = true;
      cancelHardTimeout();
      resolve(result);
    };

    const onResponse = (response: IncomingMessage) => {
      responseAt = performance.now();
      const statusCode = response.statusCode ?? null;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      response.on('data', (chunk: Buffer | string) => {
        if (receivedBytes >= 64 * 1024) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buffer.subarray(0, 64 * 1024 - receivedBytes));
        receivedBytes += buffer.length;
      });
      response.on('end', () => {
        const completedAt = performance.now();
        const timings = buildTimings(
          startedAt,
          lookupAt,
          connectAt,
          secureAt,
          responseAt,
          completedAt,
        );
        const body = Buffer.concat(chunks).toString('utf8');

        if (statusCode === null || statusCode < 200 || statusCode >= 300) {
          finish(createResult('http_error', checkedAt, timings, {
            statusCode,
            error: `Ragic HTTP ${statusCode ?? 'unknown'}`,
          }));
          return;
        }

        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          finish(createResult('invalid_response', checkedAt, timings, {
            statusCode,
            error: 'Ragic 回應不是有效 JSON',
          }));
          return;
        }
        if (!isRecord(json)) {
          finish(createResult('invalid_response', checkedAt, timings, {
            statusCode,
            error: 'Ragic 回應格式無效',
          }));
          return;
        }
        if (String(json.status ?? '').trim().toUpperCase() === 'ERROR') {
          const code = json.code === undefined || json.code === null ? '' : ` ${String(json.code)}`;
          const message = String(json.msg ?? json.message ?? 'Unknown Ragic error');
          finish(createResult('api_error', checkedAt, timings, {
            statusCode,
            error: `Ragic API${code}: ${message}`,
          }));
          return;
        }

        finish(createResult(
          timings.totalMs >= slowMs ? 'slow' : 'healthy',
          checkedAt,
          timings,
          { statusCode },
        ));
      });
      response.on('error', (error) => {
        const completedAt = performance.now();
        finish(createResult(
          classifyRagicProbeError(error),
          checkedAt,
          buildTimings(startedAt, lookupAt, connectAt, secureAt, responseAt, completedAt),
          { statusCode, error: errorMessage(error) },
        ));
      });
    };

    const requestOptions: RequestOptions = {
      method: 'GET',
      agent: false,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${apiKey}`,
        Connection: 'close',
      },
    };
    const request = target.protocol === 'https:'
      ? httpsRequest(target, requestOptions, onResponse)
      : httpRequest(target, requestOptions, onResponse);

    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      socket.once('lookup', () => { lookupAt = performance.now(); });
      socket.once('connect', () => { connectAt = performance.now(); });
      socket.once('secureConnect', () => { secureAt = performance.now(); });
    });
    request.on('error', (error) => {
      const completedAt = performance.now();
      finish(createResult(
        classifyRagicProbeError(error),
        checkedAt,
        buildTimings(startedAt, lookupAt, connectAt, secureAt, responseAt, completedAt),
        { error: errorMessage(error) },
      ));
    });

    const hardTimeout = setTimeout(() => {
      const error = Object.assign(new Error(`Ragic preflight timeout after ${timeoutMs}ms`), {
        code: 'PREFLIGHT_TIMEOUT',
      });
      request.destroy(error);
    }, timeoutMs);
    cancelHardTimeout = () => clearTimeout(hardTimeout);

    request.end();
  });
}

export function parseRagicHealthResult(value: unknown): RagicHealthResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !HEALTH_RESULT_KEYS.has(key)) ||
    typeof value.ok !== 'boolean' ||
    typeof value.status !== 'string' ||
    !VALID_STATUSES.has(value.status as RagicHealthStatus) ||
    typeof value.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    (value.lastSuccessAt !== null && (
      typeof value.lastSuccessAt !== 'string' ||
      !Number.isFinite(Date.parse(value.lastSuccessAt))
    )) ||
    (value.statusCode !== null && (!Number.isInteger(value.statusCode) || (value.statusCode as number) < 100)) ||
    (value.error !== null && typeof value.error !== 'string') ||
    !isRecord(value.timings) ||
    Object.keys(value.timings).some((key) => !TIMING_KEYS.has(key)) ||
    !isNullableDuration(value.timings.dnsMs) ||
    !isNullableDuration(value.timings.tcpMs) ||
    !isNullableDuration(value.timings.tlsMs) ||
    !isNullableDuration(value.timings.ttfbMs) ||
    !isNullableDuration(value.timings.downloadMs) ||
    typeof value.timings.totalMs !== 'number' ||
    !Number.isFinite(value.timings.totalMs) ||
    value.timings.totalMs < 0
  ) {
    return null;
  }

  const status = value.status as RagicHealthStatus;
  if (value.ok !== (status === 'healthy' || status === 'slow')) return null;

  return value as unknown as RagicHealthResult;
}

export async function getLastRagicHealthResult(
  client: PrismaClient = prisma,
): Promise<RagicHealthResult | null> {
  const row = await client.appSetting.findUnique({
    where: { key: LAST_RAGIC_HEALTH_KEY },
    select: { value: true },
  });
  return parseRagicHealthResult(row?.value);
}

export async function saveLastRagicHealthResult(
  result: RagicHealthResult,
  client: PrismaClient = prisma,
): Promise<void> {
  const value = result as unknown as Prisma.InputJsonValue;
  await client.appSetting.upsert({
    where: { key: LAST_RAGIC_HEALTH_KEY },
    create: { key: LAST_RAGIC_HEALTH_KEY, value },
    update: { value },
  });
}

export async function checkRagicHealth(
  options: CheckOptions = {},
): Promise<RagicHealthResult> {
  const now = Date.now();
  if (!options.force && cachedHealth && cachedHealth.expiresAt > now) {
    return cachedHealth.result;
  }
  if (healthInFlight) return healthInFlight;

  healthInFlight = (async () => {
    const client = options.client ?? prisma;
    const [current, previous] = await Promise.all([
      (options.probe ?? probeRagicHealth)(),
      getLastRagicHealthResult(client).catch(() => null),
    ]);
    const result: RagicHealthResult = {
      ...current,
      lastSuccessAt: current.ok ? current.checkedAt : previous?.lastSuccessAt ?? null,
    };
    await saveLastRagicHealthResult(result, client).catch(() => undefined);
    cachedHealth = { result, expiresAt: Date.now() + HEALTH_CACHE_MS };
    return result;
  })();

  try {
    return await healthInFlight;
  } finally {
    healthInFlight = null;
  }
}

export async function getRagicHealthSnapshot(
  options: SnapshotOptions = {},
): Promise<RagicHealthResult | null> {
  const client = options.client ?? prisma;
  const snapshot = await getLastRagicHealthResult(client).catch(() => null);
  void (options.refresh ?? (() => checkRagicHealth({ client })))().catch(() => undefined);
  return snapshot;
}

export class RagicPreflightError extends Error {
  constructor(readonly health: RagicHealthResult) {
    super(`Ragic 目前無法連線（${health.status}），未建立 MRP Run`);
    this.name = 'RagicPreflightError';
  }
}

export async function requireRagicPreflight(
  check: () => Promise<RagicHealthResult> = () => checkRagicHealth({ force: true }),
): Promise<RagicHealthResult> {
  const health = await check();
  if (!health.ok) throw new RagicPreflightError(health);
  return health;
}
