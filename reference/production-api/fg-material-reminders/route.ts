import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { withSharedArchiveReader } from '@/lib/archive-db';
import { ArchiveQueryError, readArchiveRun } from '@/lib/archive/browser-query';
import { readMaterialReminders, type MaterialReminderTarget } from '@/lib/mrp/material-reminder-query';
import { summarizeMaterialReminder } from '@/lib/mrp/material-reminder';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const runId = Number(params.get('runId'));
  const archiveId = params.get('archiveId');
  const dbSource = params.get('dbSource');
  let targets: MaterialReminderTarget[];
  try { targets = JSON.parse(params.get('targets') ?? 'null'); } catch { return NextResponse.json({ error: '查詢條件無效' }, { status: 400 }); }
  if (!Number.isSafeInteger(runId) || runId <= 0 || (dbSource !== null && !isDbMode(dbSource))
    || (params.has('archiveId') && !archiveId) || (archiveId && dbSource) || !Array.isArray(targets) || !targets.length || targets.length > 50
    || targets.some(t => !t || typeof t.partVersion !== 'string' || !t.partVersion.trim() || t.partVersion.length > 200 || typeof t.aggregated !== 'boolean')) {
    return NextResponse.json({ error: '查詢條件無效' }, { status: 400 });
  }
  try {
    let items;
    if (archiveId) {
      const run = await readArchiveRun(archiveId);
      if (run.sourceRunId !== runId) return NextResponse.json({ error: '歷史版本不一致' }, { status: 400 });
      // G1 did not preserve the remaining-use ledger; never manufacture a green status from missing fields.
      items = run.generation !== 'G4' || run.sourceStatus !== 'completed'
        ? targets.map(target => ({ ...target, reminder: summarizeMaterialReminder([], false) }))
        : await withSharedArchiveReader(client => readMaterialReminders(client, archiveId, targets, true));
    } else {
      const client = dbSource ? getClientForMode(dbSource) : prisma;
      if (!client) return NextResponse.json({ error: '資料庫來源無法使用' }, { status: 503 });
      const run = await client.mrpRun.findUnique({ where: { id: runId }, select: { status: true } });
      if (!run) return NextResponse.json({ error: '找不到指定 MRP 版本' }, { status: 404 });
      if (run.status !== 'completed') return NextResponse.json({ error: 'MRP 版本尚未完成' }, { status: 409 });
      items = await readMaterialReminders(client, runId, targets);
    }
    return NextResponse.json({ runId, archiveId, dbSource, items });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ArchiveQueryError ? error.message : '關聯材料暫時無法讀取，請重試或聯絡管理者' }, { status: error instanceof ArchiveQueryError ? error.status : 503 });
  }
}
