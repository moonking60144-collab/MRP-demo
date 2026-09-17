/**
 * Debug endpoint: check actual record counts from all Ragic staging forms.
 * GET /api/debug-ragic           → counts for all 8 forms (limit=1 just to count)
 * GET /api/debug-ragic?form=23   → detailed info for one form
 */
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';

const STAGING_FORMS: Record<string, string> = {
  '23': '客戶料號版本 (part_versions)',
  '24': '料號庫存 (inventory)',
  '25': '訂單明細 (orders)',
  '26': '預示量 (forecasts)',
  '27': '工令單 (work_orders)',
  '28': '工令單BOM (work_order_bom)',
  '29': '生產計畫 (production_plans)',
  '30': '採購明細 (purchase_orders)',
};

const EXPECTED_COUNTS: Record<string, number> = {
  '23': 3036, '24': 2636, '25': 1547, '26': 5012,
  '27': 2682, '28': 2844, '29': 490, '30': 117,
};

async function fetchCount(form: string, headers: Record<string, string>): Promise<{
  form: string;
  label: string;
  expected: number;
  withListing: number;
  withoutListing: number;
}> {
  const base = config.ragicBaseUrl;
  const path = `/default/d4/${form}`;

  // With listing=true
  const url1 = new URL(`${base}${path}`);
  url1.searchParams.set('api', '');
  url1.searchParams.set('v', '3');
  url1.searchParams.set('naming', 'EID');
  url1.searchParams.set('limit', '50000');
  url1.searchParams.set('listing', 'true');

  // Without listing=true (all records)
  const url2 = new URL(`${base}${path}`);
  url2.searchParams.set('api', '');
  url2.searchParams.set('v', '3');
  url2.searchParams.set('naming', 'EID');
  url2.searchParams.set('limit', '50000');

  const [res1, res2] = await Promise.all([
    fetch(url1.toString(), { headers }),
    fetch(url2.toString(), { headers }),
  ]);

  const data1 = res1.ok ? await res1.json() : {};
  const data2 = res2.ok ? await res2.json() : {};

  return {
    form,
    label: STAGING_FORMS[form] || `Form ${form}`,
    expected: EXPECTED_COUNTS[form] || 0,
    withListing: Object.keys(data1).length,
    withoutListing: Object.keys(data2).length,
  };
}

export async function GET(req: NextRequest) {
  const form = req.nextUrl.searchParams.get('form');

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (config.ragicApiKey) {
    headers['Authorization'] = `Basic ${config.ragicApiKey}`;
  }

  try {
    if (form) {
      // Single form detail
      const result = await fetchCount(form, headers);
      return NextResponse.json(result);
    }

    // All forms — fetch sequentially to avoid overwhelming Ragic API queue
    const results: Awaited<ReturnType<typeof fetchCount>>[] = [];
    for (const f of Object.keys(STAGING_FORMS)) {
      console.log(`[Debug] Counting form ${f} (${STAGING_FORMS[f]})...`);
      const result = await fetchCount(f, headers);
      console.log(`[Debug] Form ${f}: listing=${result.withListing}, noListing=${result.withoutListing}, expected=${result.expected}`);
      results.push(result);
    }

    const totalWithListing = results.reduce((a, r) => a + r.withListing, 0);
    const totalWithout = results.reduce((a, r) => a + r.withoutListing, 0);
    const totalExpected = results.reduce((a, r) => a + r.expected, 0);

    return NextResponse.json({
      summary: {
        totalWithListing,
        totalWithoutListing: totalWithout,
        totalExpected,
      },
      forms: results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
