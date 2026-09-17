import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { RAGIC_STAGING_PATHS } from '@/lib/sync/field-maps';

/**
 * GET /api/diag — Diagnostic: test Ragic connection
 * ?raw=tableName — show full first record
 * ?all=true — show ALL tables with full first record (for field map verification)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawTable = url.searchParams.get('raw');
  const showAll = url.searchParams.get('all') === 'true';

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (config.ragicApiKey) {
    headers['Authorization'] = `Basic ${config.ragicApiKey}`;
  }

  // Show all tables with first record
  if (showAll) {
    const allData: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(RAGIC_STAGING_PATHS)) {
      try {
        const fetchUrl = new URL(`${config.ragicBaseUrl}${path}`);
        fetchUrl.searchParams.set('api', '');
        fetchUrl.searchParams.set('v', '3');
        fetchUrl.searchParams.set('naming', 'EID');
        fetchUrl.searchParams.set('limit', '1');

        const res = await fetch(fetchUrl.toString(), { headers });
        const data = await res.json();
        const entries = Object.entries(data);
        allData[name] = {
          path,
          recordCount: entries.length,
          firstRecord: entries.length > 0 ? entries[0][1] : null,
        };
      } catch (err) {
        allData[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return NextResponse.json(allData);
  }

  // Single table raw view
  if (rawTable && rawTable in RAGIC_STAGING_PATHS) {
    const path = RAGIC_STAGING_PATHS[rawTable as keyof typeof RAGIC_STAGING_PATHS];
    const fetchUrl = new URL(`${config.ragicBaseUrl}${path}`);
    fetchUrl.searchParams.set('api', '');
    fetchUrl.searchParams.set('v', '3');
    fetchUrl.searchParams.set('naming', 'EID');
    fetchUrl.searchParams.set('limit', '1');

    const res = await fetch(fetchUrl.toString(), { headers });
    const data = await res.json();
    return NextResponse.json({ table: rawTable, path, status: res.status, data });
  }

  // Default summary
  const results: Record<string, unknown> = {
    hint: 'Use ?all=true to see all tables, or ?raw=tableName for one table',
    paths: RAGIC_STAGING_PATHS,
  };
  return NextResponse.json(results);
}
