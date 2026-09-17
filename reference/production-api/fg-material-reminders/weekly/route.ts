import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { ArchiveQueryError, readArchiveWeeklyReport } from '@/lib/archive/browser-query';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const runId = Number(params.get('runId'));
  const material = params.get('material');
  const mrpType = params.get('mrpType');
  const archiveId = params.get('archiveId');
  const dbSource = params.get('dbSource');
  if (!Number.isSafeInteger(runId) || runId <= 0 || !material || material.length > 200 || !['W','B','D'].includes(mrpType ?? '')
    || (dbSource !== null && !isDbMode(dbSource)) || (params.has('archiveId') && !archiveId) || (archiveId && dbSource)) return NextResponse.json({ error: '關聯查詢條件無效' }, { status: 400 });
  try {
    if (archiveId) {
      const report = await readArchiveWeeklyReport(archiveId, new URLSearchParams({ kind: 'component', mrpType: mrpType!, material }));
      if (report.run.sourceRunId !== runId) return NextResponse.json({ error: '歷史版本不一致' }, { status: 400 });
      return NextResponse.json({ archive: report, runId, archiveId, dbSource, material, mrpType });
    }
    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) return NextResponse.json({ error: '資料庫來源無法使用' }, { status: 503 });
    const run = await client.mrpRun.findUnique({ where: { id: runId }, select: { versionCode: true, status: true } });
    if (!run) return NextResponse.json({ error: '找不到指定 MRP 版本，未切換至最新版' }, { status: 404 });
    if (run.status !== 'completed') return NextResponse.json({ error: '指定 MRP 版本尚未完成' }, { status: 409 });
    const where = { mrpRunId: runId, materialPartNo: material, mrpType: mrpType! };
    const [items, periods] = await Promise.all([
      client.componentWeekly.findMany({ where }),
      client.componentWeeklyPeriod.findMany({ where, orderBy: { weekIndex: 'asc' } }),
    ]);
    return NextResponse.json({ items: items.map(item => ({ ...item, ...(dbSource ? { dbSource } : {}) })), periods, versionCode: run.versionCode, runId, archiveId, dbSource, material, mrpType });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ArchiveQueryError ? error.message : '元件週推暫時無法讀取，請重試或聯絡管理者' }, { status: error instanceof ArchiveQueryError ? error.status : 503 });
  }
}
