import { NextResponse } from 'next/server';
import { ArchiveQueryError } from './browser-query';

export async function archiveResponse(query: () => Promise<unknown>) {
  const headers = { 'Cache-Control': 'no-store' };
  try { return NextResponse.json(await query(), { headers }); }
  catch (error) {
    const known = error instanceof ArchiveQueryError;
    return NextResponse.json({ error: known ? error.message : '歷史資料庫暫時無法連線，請稍後重試或聯絡管理者' },
      { status: known ? error.status : 503, headers });
  }
}
