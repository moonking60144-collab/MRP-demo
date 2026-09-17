import { NextRequest, NextResponse } from 'next/server';
import { getAutoFollowLatestRun, setAutoFollowLatestRun } from '@/lib/app-settings';

/** GET /api/settings/auto-follow — 讀全域「自動切換到最新 MRP」開關 */
export async function GET() {
  return NextResponse.json({ autoFollow: await getAutoFollowLatestRun() });
}

/** POST /api/settings/auto-follow — 設定開關，body: { autoFollow: boolean } */
export async function POST(req: NextRequest) {
  const body = await req.json();
  await setAutoFollowLatestRun(body.autoFollow === true);
  return NextResponse.json({ autoFollow: await getAutoFollowLatestRun() });
}
