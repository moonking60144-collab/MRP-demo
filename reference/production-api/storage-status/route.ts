import { NextResponse } from 'next/server';
import { getStorageStatus } from '@/lib/storage-status';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getStorageStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '容量資訊暫時無法取得' }, { status: 503 });
  }
}
