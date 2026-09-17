import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateSnapshot, refreshSnapshot } from '@/lib/reports/outsource-snapshot';

export const dynamic = 'force-dynamic';

/** 驗證並正規化 month → 'YYYY-MM'（補零，避免 2026-5 / 2026-05 變成兩筆 PK）。 */
function parseMonth(req: NextRequest): string | null {
  const raw = req.nextUrl.searchParams.get('month') || '';
  const m = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}`;
}

/** GET：讀月快照（DB 有秒回；沒有才同步打 Ragic 算一筆）。 */
export async function GET(req: NextRequest) {
  const month = parseMonth(req);
  if (!month) return NextResponse.json({ error: 'month 參數需為 YYYY-MM' }, { status: 400 });
  try {
    return NextResponse.json(await getOrCreateSnapshot(month));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

/** POST：強制重抓 Ragic 重算並更新 DB（手動「重新抓取」＋ 前端 stale 背景重抓）。 */
export async function POST(req: NextRequest) {
  const month = parseMonth(req);
  if (!month) return NextResponse.json({ error: 'month 參數需為 YYYY-MM' }, { status: 400 });
  try {
    return NextResponse.json(await refreshSnapshot(month));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
