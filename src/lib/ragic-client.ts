/**
 * Ragic HTTP API client
 * Handles both API-key auth (dev) and session-cookie auth (production)
 */
import { config } from './config';
import { runLog } from './run-logger';

interface RagicWhereClause {
  fieldId: string;
  operator: 'eq' | 'regex' | 'gte' | 'lte' | 'gt' | 'lt' | 'like';
  value: string;
}

interface RagicListingOptions {
  path: string;
  /** Override the base URL (e.g. for internal container→host calls) */
  baseUrl?: string;
  /** Pass session ID for cookie-based auth */
  sessionId?: string;
  /**
   * Filter conditions using Ragic's where format: field_id,operator,value
   * Multiple where clauses are supported (same field with eq/regex/like = OR; gte+lte = AND range).
   */
  where?: RagicWhereClause[];
  /** Page size for pagination (default 1000). Fetches all pages automatically. */
  limit?: number;
  /** Set to false to disable listing mode. Some fields are not returned in listing mode. Default: true */
  listing?: boolean;
  /** Set to false to omit subtable payloads from full-record responses. */
  includeSubtables?: boolean;
  /** Return only these Ragic field EIDs while preserving full-field values. */
  fetchDomainIds?: readonly string[];
}

export interface RagicRecord {
  _ragic_id: string;
  [fieldEid: string]: string;
}

/**
 * Per-request hard timeout (ms). If Ragic doesn't return within this window,
 * the AbortController fires and the request fails — preventing the whole
 * sync pipeline from hanging indefinitely on a stalled API call.
 *
 * Production has been observed hanging on the WO BOM step with no error and
 * no progress; this guarantees that scenario surfaces as a recoverable error.
 */
const RAGIC_FETCH_TIMEOUT_MS = Number(process.env.RAGIC_FETCH_TIMEOUT_MS) || 120_000;
const RAGIC_FETCH_RETRIES = Number(process.env.RAGIC_FETCH_RETRIES) || 2;
const RAGIC_HEARTBEAT_MS = 15_000;

export interface RagicResponseTelemetry {
  data: unknown;
  bytes: number;
  parseMs: number;
}

export function parseRagicResponseText(text: string): RagicResponseTelemetry {
  const parseStartedAt = Date.now();
  const data = JSON.parse(text) as unknown;
  return {
    data,
    bytes: new TextEncoder().encode(text).byteLength,
    parseMs: Date.now() - parseStartedAt,
  };
}

/**
 * Strip auth params/headers for safe logging — never write API keys or
 * session IDs into the log stream.
 */
function safeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('sid');
    u.searchParams.delete('APIKey');
    return u.toString();
  } catch {
    return rawUrl.replace(/sid=[^&]+/g, 'sid=***').replace(/APIKey=[^&]+/g, 'APIKey=***');
  }
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : null;
  if (!cause || typeof cause !== 'object') return message;

  const causeRecord = cause as Record<string, unknown>;
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof causeRecord.message === 'string'
      ? causeRecord.message
      : String(cause);
  const causeCode = typeof causeRecord.code === 'string' ? causeRecord.code : '';
  const detail = [causeCode, causeMessage].filter(Boolean).join(': ');
  return detail && detail !== message ? `${message}; cause=${detail}` : message;
}

/**
 * Wrap fetch with a hard timeout, periodic heartbeat log, and retry-on-error.
 * Returns the parsed JSON body. Throws on non-2xx, timeout, or network failure
 * (after exhausting retries).
 */
async function fetchRagicJson(
  rawUrl: string,
  headers: Record<string, string>,
  label: string,
  options?: { timeoutMs?: number; retries?: number },
): Promise<unknown> {
  const safeUrl = safeUrlForLog(rawUrl);
  let lastErr: unknown = null;
  const timeoutMs = options?.timeoutMs ?? RAGIC_FETCH_TIMEOUT_MS;
  const retries = options?.retries ?? RAGIC_FETCH_RETRIES;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const fetchStart = Date.now();

    const heartbeat = setInterval(() => {
      const waited = Math.round((Date.now() - fetchStart) / 1000);
      runLog.warn(`[Ragic] ⏳ ${label} still waiting after ${waited}s (attempt ${attempt}/${retries + 1}) — ${safeUrl}`);
    }, RAGIC_HEARTBEAT_MS);

    const timeout = setTimeout(() => {
      runLog.error(`[Ragic] ✗ ${label} TIMEOUT after ${timeoutMs}ms (attempt ${attempt}) — aborting — ${safeUrl}`);
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(rawUrl, { headers, signal: controller.signal });
      const headersReceivedAt = Date.now();
      const ttfbMs = headersReceivedAt - fetchStart;
      const body = await res.text().catch(() => '<unreadable>');
      const bodyReceivedAt = Date.now();
      const downloadMs = bodyReceivedAt - headersReceivedAt;
      const bodyBytes = new TextEncoder().encode(body).byteLength;

      if (!res.ok) {
        const totalMs = bodyReceivedAt - fetchStart;
        runLog.error(`[Ragic] ✗ ${label} HTTP ${res.status} (ttfb=${ttfbMs}ms download=${downloadMs}ms bytes=${bodyBytes} total=${totalMs}ms attempt=${attempt}) — ${body.slice(0, 200)} — ${safeUrl}`);
        // 5xx (server error) + 429 (throttle / queue full) 可重試；其餘 4xx 不重試。
        // Ragic doc: 5 req/sec 是 review 門檻、queue 滿(>50) 拒收 — 兩者可能回 429/503。
        const isRetryable = res.status >= 500 || res.status === 429;
        if (isRetryable && attempt <= retries) {
          lastErr = new Error(`Ragic API error ${res.status}: ${body.slice(0, 200)}`);
          // 429 throttle 通常要 sleep 較久；用更長 backoff（10s × attempt，上限 30s）。
          // 5xx 維持原本即時 continue 行為。
          if (res.status === 429) {
            const throttleBackoff = Math.min(10000 * attempt, 30000);
            runLog.warn(`[Ragic] ↻ ${label} HTTP 429 throttled — retrying in ${throttleBackoff}ms (attempt ${attempt}/${retries + 1})`);
            await new Promise((r) => setTimeout(r, throttleBackoff));
          }
          continue;
        }
        throw new Error(`Ragic API error ${res.status}: ${body.slice(0, 500)}`);
      }

      const parsed = parseRagicResponseText(body);
      const data = parsed.data;
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const envelope = data as Record<string, unknown>;
        if (String(envelope.status ?? '').trim().toUpperCase() === 'ERROR') {
          const code = envelope.code === undefined || envelope.code === null
            ? ''
            : ` ${String(envelope.code)}`;
          const message = String(envelope.msg ?? envelope.message ?? 'Unknown Ragic error');
          throw new Error(`Ragic API error${code}: ${message}`);
        }
      }
      const totalMs = Date.now() - fetchStart;
      runLog.info(`[Ragic] ✓ ${label} ttfb=${ttfbMs}ms download=${downloadMs}ms parse=${parsed.parseMs}ms bytes=${parsed.bytes} total=${totalMs}ms attempt=${attempt}`);
      return data;
    } catch (err) {
      const fetchMs = Date.now() - fetchStart;
      const isAbort = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
      const isNetwork = err instanceof Error && /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(err.message);
      lastErr = err;

      if (attempt <= retries && (isAbort || isNetwork)) {
        const backoff = Math.min(2000 * attempt, 8000);
        runLog.warn(`[Ragic] ↻ ${label} ${isAbort ? 'timed out' : 'network error'} after ${fetchMs}ms — retrying in ${backoff}ms (attempt ${attempt}/${retries + 1})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      const detail = errorDetail(err);
      runLog.error(`[Ragic] ✗ ${label} FAILED after ${fetchMs}ms attempt ${attempt}: ${detail} — ${safeUrl}`);
      throw detail === (err instanceof Error ? err.message : String(err))
        ? err
        : new Error(detail, { cause: err });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Ragic fetch exhausted retries: ${String(lastErr)}`);
}

/**
 * Fetch ALL records from a Ragic listing with automatic pagination.
 *
 * Ragic defaults to 1000 records but accepts a caller-provided larger limit.
 * We paginate using offset, deduplicate by record ID, and stop when we get
 * fewer records than the requested page size.
 */
export async function fetchRagicListing(opts: RagicListingOptions): Promise<RagicRecord[]> {
  const base = opts.baseUrl || config.ragicBaseUrl;
  const pageSize = opts.limit || 1000;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (!opts.sessionId && config.ragicApiKey) {
    headers['Authorization'] = `Basic ${config.ragicApiKey}`;
  }

  const useListing = opts.listing !== false;
  const allRecords = new Map<string, RagicRecord>();
  let offset = 0;
  let pageNum = 0;
  const totalStart = Date.now();

  while (true) {
    pageNum++;
    const url = new URL(`${base}${opts.path}`);
    url.searchParams.set('api', '');
    url.searchParams.set('v', '3');
    url.searchParams.set('naming', 'EID');
    url.searchParams.set('limit', String(pageSize));
    if (useListing) {
      url.searchParams.set('listing', 'true');
    }
    if (opts.includeSubtables === false) {
      url.searchParams.set('subtables', '0');
    }
    if (opts.fetchDomainIds) {
      for (const fieldId of opts.fetchDomainIds) {
        url.searchParams.append('fetchDomainIds', fieldId);
      }
    }

    if (offset > 0) {
      url.searchParams.set('offset', String(offset));
    }

    // Auth
    if (opts.sessionId) {
      url.searchParams.set('login_type', 'sessionId');
      url.searchParams.set('sid', opts.sessionId);
    }

    // Where clauses
    if (opts.where) {
      for (const clause of opts.where) {
        url.searchParams.append('where', `${clause.fieldId},${clause.operator},${clause.value}`);
      }
    }

    const label = `GET ${opts.path} page=${pageNum} offset=${offset}`;
    runLog.info(`[Ragic] ${label} limit=${pageSize} listing=${useListing} → ${safeUrlForLog(url.toString())}`);
    const fetchStart = Date.now();
    const data = (await fetchRagicJson(url.toString(), headers, label)) as Record<string, unknown>;
    const fetchMs = Date.now() - fetchStart;

    // Ragic returns { "recordId": { fields... }, ... }
    // Filter: only keep entries where key is numeric and value is an object
    const pageRecords: RagicRecord[] = [];
    for (const [id, fields] of Object.entries(data)) {
      // Skip metadata keys (start with _ or non-numeric)
      if (!/^\d+$/.test(id)) continue;
      // Skip non-object values
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) continue;

      const rec: RagicRecord = {
        _ragic_id: id,
        ...(fields as Record<string, string>),
      };
      pageRecords.push(rec);
      allRecords.set(id, rec); // Deduplicate by ID
    }

    runLog.info(`[Ragic] ✓ page ${pageNum}: ${pageRecords.length} records (${fetchMs}ms), total unique: ${allRecords.size}`);

    // Stop if we got fewer records than page size → last page
    if (pageRecords.length < pageSize) {
      break;
    }

    offset += pageSize;

    // Safety: prevent infinite loops (max 100 pages = 100K records)
    if (pageNum >= 100) {
      runLog.warn(`[Ragic] ⚠ Stopped after ${pageNum} pages (${allRecords.size} records) — safety limit`);
      break;
    }
  }

  const totalMs = Date.now() - totalStart;
  runLog.info(`[Ragic] ✓ ${opts.path} → ${allRecords.size} unique records in ${pageNum} pages (${totalMs}ms)`);

  return Array.from(allRecords.values());
}

/** Options for {@link fetchRagicRecord} — single-record fetch with subtables. */
export interface RagicRecordOptions {
  timeoutMs?: number;
  retries?: number;
  /** Path like '/default/d4/10' (the form's raw path, not a custom view). */
  path: string;
  /** Ragic record id (numeric string) of the row to fetch. */
  recordId: string;
  /** Override base URL (rare). */
  baseUrl?: string;
  /** Cookie auth (production). Otherwise API key. */
  sessionId?: string;
}

/** Full single-record JSON: top-level field EIDs + subtable buckets `_subtable_<key>`. */
export type RagicFullRecord = Record<string, unknown>;

/**
 * Fetch ONE record by id, including its subtables. Use this when you need fields
 * that listing mode omits (e.g. 1028252 數量修正) or subtable rows (e.g. _subtable_*).
 *
 * Inherits the same retry / timeout / heartbeat / safe-log instrumentation as
 * {@link fetchRagicListing}.
 *
 * The Ragic envelope is `{ recordId: { ...fields } }` — this helper unwraps to
 * just the inner record.
 */
export async function fetchRagicRecord(opts: RagicRecordOptions): Promise<RagicFullRecord> {
  const base = opts.baseUrl || config.ragicBaseUrl;
  const url = new URL(`${base}${opts.path}/${opts.recordId}`);
  url.searchParams.set('api', '');
  url.searchParams.set('v', '3');
  url.searchParams.set('naming', 'EID');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.sessionId) {
    url.searchParams.set('login_type', 'sessionId');
    url.searchParams.set('sid', opts.sessionId);
  } else if (config.ragicApiKey) {
    headers['Authorization'] = `Basic ${config.ragicApiKey}`;
  }

  const label = `GET ${opts.path}/${opts.recordId}`;
  const data = (await fetchRagicJson(url.toString(), headers, label, opts)) as Record<string, unknown>;

  // Unwrap envelope `{ recordId: {...} }`. Single-record responses always have one entry.
  const inner = Object.values(data).find(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
  if (!inner) {
    throw new Error(`Ragic ${label} returned empty record envelope`);
  }
  return inner as RagicFullRecord;
}

export interface RagicActionButton {
  id: string;
  name: string;
}

export type RagicActionButtonOutcome = 'definite_failure' | 'unknown';

const DEFINITE_ACTION_BUTTON_FAILURE_CODES = new Set([
  101, 102, 103, 104, 105, 106, 107, 108, 109,
  201, 204,
  301, 302, 303, 304,
  402, 404,
]);

function classifyActionButtonFailure(
  httpStatus: number,
  result: Record<string, unknown> | null,
): RagicActionButtonOutcome {
  if (httpStatus >= 500 || httpStatus === 408) return 'unknown';

  const rawCode = result?.code;
  const code = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? Number(rawCode)
    : NaN;
  if (Number.isFinite(code)) {
    return DEFINITE_ACTION_BUTTON_FAILURE_CODES.has(code)
      ? 'definite_failure'
      : 'unknown';
  }

  return [400, 401, 403, 404, 429].includes(httpStatus)
    ? 'definite_failure'
    : 'unknown';
}

export async function fetchRagicActionButtons(path: string): Promise<RagicActionButton[]> {
  const url = new URL(`${config.ragicBaseUrl}${path}/metadata/actionButton`);
  url.searchParams.set('api', '');
  url.searchParams.set('category', 'massOperation');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.ragicApiKey) headers.Authorization = `Basic ${config.ragicApiKey}`;

  const data = await fetchRagicJson(
    url.toString(),
    headers,
    `GET ${path}/metadata/actionButton`,
  ) as Record<string, unknown>;
  const buttons = Array.isArray(data.actionButtons) ? data.actionButtons : [];
  return buttons.flatMap((button) => {
    if (!button || typeof button !== 'object') return [];
    const row = button as Record<string, unknown>;
    if (row.id === undefined || row.name === undefined) return [];
    return [{ id: String(row.id), name: String(row.name) }];
  });
}

export class RagicActionButtonError extends Error {
  constructor(
    message: string,
    readonly outcome: RagicActionButtonOutcome,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RagicActionButtonError';
  }
}

/**
 * Execute one Ragic action button exactly once. This POST is intentionally not
 * retried: a lost response can still mean the workflow already changed data.
 */
export async function executeRagicActionButton(
  path: string,
  recordId: string,
  buttonId: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`${config.ragicBaseUrl}${path}/${recordId}`);
  url.searchParams.set('api', '');
  url.searchParams.set('v', '3');
  url.searchParams.set('bId', buttonId);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.ragicApiKey) headers.Authorization = `Basic ${config.ragicApiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAGIC_FETCH_TIMEOUT_MS);
  let res: Response;
  let responseText: string;
  try {
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      responseText = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RagicActionButtonError(
        `Ragic 動作按鈕結果不明：${message}`,
        'unknown',
      );
    }
  } finally {
    clearTimeout(timeout);
  }

  runLog.info(`[Ragic] Action button ${buttonId} response ${res.status}: ${responseText.slice(0, 500)}`);

  let result: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    // Handled as an unknown outcome below.
  }

  if (!res.ok || !result || String(result.status ?? '').toUpperCase() !== 'SUCCESS') {
    const detail = result
      ? String(result.msg ?? result.message ?? responseText)
      : responseText;
    const rawCode = result?.code;
    const code = typeof rawCode === 'number' || typeof rawCode === 'string'
      ? Number(rawCode)
      : NaN;
    const outcome = classifyActionButtonFailure(res.status, result);
    throw new RagicActionButtonError(
      outcome === 'definite_failure'
        ? `Ragic 動作按鈕明確拒絕（HTTP ${res.status}）：${detail.slice(0, 300)}`
        : `Ragic 動作按鈕結果不明（HTTP ${res.status}）：${detail.slice(0, 300)}`,
      outcome,
      res.status,
      Number.isFinite(code) ? code : undefined,
    );
  }

  return result;
}

export interface RagicCreateResult {
  id: string | null;
  rawResponse: Record<string, unknown>;
}

export interface RagicUpdateResult {
  rawResponse: Record<string, unknown>;
}

export type RagicUpdateOutcome = 'definite_failure' | 'unknown';

export class RagicUpdateError extends Error {
  constructor(
    message: string,
    readonly outcome: RagicUpdateOutcome,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RagicUpdateError';
  }
}

export type RagicCreateOutcome = 'definite_failure' | 'unknown';

export class RagicCreateError extends Error {
  constructor(
    message: string,
    readonly outcome: RagicCreateOutcome,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RagicCreateError';
  }
}

const DEFINITE_CREATE_FAILURE_CODES = new Set([
  101, 102, 103, 104, 105, 106, 107, 108, 109,
  201,
  301, 303, 304,
  402, 404,
]);

function classifyCreateFailure(
  httpStatus: number,
  result: Record<string, unknown> | null,
): RagicCreateOutcome {
  if (httpStatus >= 500 || httpStatus === 408) return 'unknown';

  const rawCode = result?.code;
  const code = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? Number(rawCode)
    : NaN;
  if (Number.isFinite(code)) {
    return DEFINITE_CREATE_FAILURE_CODES.has(code) ? 'definite_failure' : 'unknown';
  }

  return [400, 401, 403, 404].includes(httpStatus) ? 'definite_failure' : 'unknown';
}

function classifyUpdateFailure(
  httpStatus: number,
  result: Record<string, unknown> | null,
): RagicUpdateOutcome {
  if (httpStatus >= 500 || httpStatus === 408) return 'unknown';

  const rawCode = result?.code;
  const code = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? Number(rawCode)
    : NaN;
  if (Number.isFinite(code)) {
    return DEFINITE_CREATE_FAILURE_CODES.has(code) ? 'definite_failure' : 'unknown';
  }

  return httpStatus >= 400 && httpStatus < 500 ? 'definite_failure' : 'unknown';
}

export interface RagicCreateOptions {
  sessionId?: string;
  /** Recalculate all formulas after create/update */
  doFormula?: boolean;
  /** Load default values */
  doDefaultValue?: boolean;
  /** Execute link & load: true = after formulas, 'first' = before formulas */
  doLinkLoad?: boolean | 'first';
  /** Execute workflows associated with this API call */
  doWorkflow?: boolean;
}

/**
 * Create a record on a Ragic form
 */
export async function createRagicRecord(
  path: string,
  data: Record<string, string | number>,
  opts?: RagicCreateOptions,
): Promise<RagicCreateResult> {
  const base = config.ragicBaseUrl;
  const url = new URL(`${base}${path}`);
  url.searchParams.set('api', '');
  url.searchParams.set('v', '3');

  if (opts?.sessionId) {
    url.searchParams.set('login_type', 'sessionId');
    url.searchParams.set('sid', opts.sessionId);
  }

  // Ragic post-creation processing parameters
  if (opts?.doFormula) url.searchParams.set('doFormula', 'true');
  if (opts?.doDefaultValue) url.searchParams.set('doDefaultValue', 'true');
  if (opts?.doLinkLoad) url.searchParams.set('doLinkLoad', opts.doLinkLoad === 'first' ? 'first' : 'true');
  if (opts?.doWorkflow) url.searchParams.set('doWorkflow', 'true');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (!opts?.sessionId && config.ragicApiKey) {
    headers['Authorization'] = `Basic ${config.ragicApiKey}`;
  }

  runLog.info(`[Ragic] POST ${path}`, JSON.stringify(data));

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    runLog.error(`[Ragic] ✗ POST ${path} TIMEOUT after ${RAGIC_FETCH_TIMEOUT_MS}ms — aborting`);
    controller.abort();
  }, RAGIC_FETCH_TIMEOUT_MS);

  let res: Response;
  let responseText: string;
  try {
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      responseText = await res.text();
    } catch (err) {
      const message = errorDetail(err);
      throw new RagicCreateError(`Ragic POST outcome unknown: ${message}`, 'unknown');
    }
  } finally {
    clearTimeout(timeout);
  }
  runLog.info(`[Ragic] Response ${res.status}: ${responseText.slice(0, 500)}`);

  let result: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON POST responses are handled below as an unknown outcome.
  }

  if (!res.ok) {
    const outcome = classifyCreateFailure(res.status, result);
    throw new RagicCreateError(
      `Ragic create error ${res.status}: ${responseText}`,
      outcome,
      res.status,
    );
  }

  if (!result) {
    throw new RagicCreateError(
      `Ragic returned non-JSON after POST: ${responseText.slice(0, 200)}`,
      'unknown',
      res.status,
    );
  }

  // Ragic POST response formats:
  // 1. { "ragicId": "123456", "status": "SUCCESS" }
  // 2. { "123456": { ...fields... } }
  // 3. { "_ragic_id": "123456", ... }
  // 4. { "status": "SUCCESS" } (accepted, but no record URL can be built)
  const rawRagicId = (
    result._ragic_id
    || result.ragicId
    || Object.keys(result).find((k) => /^\d+$/.test(k))
  );
  const ragicId = rawRagicId ? String(rawRagicId) : null;
  const responseStatus = String(result.status || '').toUpperCase();

  if (responseStatus === 'ERROR' && !ragicId) {
    const outcome = classifyCreateFailure(res.status, result);
    throw new RagicCreateError(
      `Ragic rejected create: ${String(result.msg || result.message || 'unknown error')}`,
      outcome,
      res.status,
    );
  }
  if (!ragicId && responseStatus !== 'SUCCESS') {
    throw new RagicCreateError(
      `Ragic POST succeeded but returned no record ID: ${responseText.slice(0, 200)}`,
      'unknown',
      res.status,
    );
  }

  return { id: ragicId, rawResponse: result };
}

export interface RagicUpdateOptions {
  sessionId?: string;
  checkLock?: boolean;
  timeoutMs?: number;
}

/**
 * Update one existing Ragic record exactly once. A lost response may still
 * mean the write succeeded, so this helper never retries PATCH automatically.
 */
export async function updateRagicRecord(
  path: string,
  recordId: string,
  data: Record<string, string | number>,
  opts?: RagicUpdateOptions,
): Promise<RagicUpdateResult> {
  const url = new URL(`${config.ragicBaseUrl}${path}/${recordId}`);
  url.searchParams.set('api', '');
  url.searchParams.set('v', '3');
  url.searchParams.set('naming', 'EID');
  if (opts?.checkLock !== false) url.searchParams.set('checkLock', 'true');

  if (opts?.sessionId) {
    url.searchParams.set('login_type', 'sessionId');
    url.searchParams.set('sid', opts.sessionId);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (!opts?.sessionId && config.ragicApiKey) {
    headers.Authorization = `Basic ${config.ragicApiKey}`;
  }

  runLog.info(`[Ragic] PATCH ${path}/${recordId} fields=${Object.keys(data).join(',')}`);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? RAGIC_FETCH_TIMEOUT_MS);
  let res: Response;
  let responseText: string;
  try {
    try {
      res = await fetch(url.toString(), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      runLog.info(`[Ragic] PATCH ${path}/${recordId} HTTP ${res.status} contentType=${res.headers.get('content-type') ?? 'missing'} ttfb=${Date.now() - startedAt}ms`);
      responseText = await res.text();
      runLog.info(`[Ragic] PATCH ${path}/${recordId} body complete bytes=${new TextEncoder().encode(responseText).byteLength} total=${Date.now() - startedAt}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runLog.error(`[Ragic] PATCH ${path}/${recordId} outcome unknown after ${Date.now() - startedAt}ms: ${message}`);
      throw new RagicUpdateError(`Ragic PATCH outcome unknown: ${message}`, 'unknown');
    }
  } finally {
    clearTimeout(timeout);
  }

  let result: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON write responses have an unknown outcome.
  }

  const responseStatus = String(result?.status ?? '').trim().toUpperCase();
  if (!res.ok || responseStatus === 'ERROR') {
    const outcome = classifyUpdateFailure(res.status, result);
    const rawCode = result?.code;
    const code = typeof rawCode === 'number' || typeof rawCode === 'string'
      ? Number(rawCode)
      : NaN;
    const detail = String(result?.msg ?? result?.message ?? responseText).slice(0, 300);
    throw new RagicUpdateError(
      outcome === 'definite_failure'
        ? `Ragic PATCH 明確拒絕（HTTP ${res.status}）：${detail}`
        : `Ragic PATCH 結果不明（HTTP ${res.status}）：${detail}`,
      outcome,
      res.status,
      Number.isFinite(code) ? code : undefined,
    );
  }

  if (!result) {
    throw new RagicUpdateError(
      `Ragic PATCH returned non-JSON: ${responseText.slice(0, 200)}`,
      'unknown',
      res.status,
    );
  }

  return { rawResponse: result };
}

/**
 * Authenticate user via Ragic session cookie
 * Returns user info if valid, null otherwise
 */
export async function authenticateFromRagic(cookieHeader: string): Promise<{
  sid: string;
  authorizedPaths: string[];
} | null> {
  try {
    // Step 1: Get session ID from /AUTH endpoint
    const authRes = await fetch(`${config.ragicBaseUrl}/AUTH`, {
      headers: { 'Cookie': cookieHeader },
    });
    if (!authRes.ok) return null;

    const sid = (await authRes.text()).trim();
    if (!sid || sid.length < 10) return null;

    // Step 2: Get menu tree to determine access
    const menuRes = await fetch(
      `${config.ragicBaseUrl}/default?api&login_type=sessionId&sid=${sid}`,
    );
    if (!menuRes.ok) return null;

    const menuData = await menuRes.json();

    // Walk menu tree to find authorized sheet paths
    const paths: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walkMenu = (node: any, prefix: string): void => {
      if (node.children && typeof node.children === 'object') {
        for (const [key, child] of Object.entries(node.children as Record<string, Record<string, unknown>>)) {
          const fullPath = prefix ? `${prefix}/${key}` : key;
          if (child.type === 'sheet') {
            paths.push(fullPath);
          }
          walkMenu(child, fullPath);
        }
      }
    };

    if (menuData.default) {
      walkMenu(menuData.default, '');
    }

    return { sid, authorizedPaths: paths };
  } catch {
    return null;
  }
}
