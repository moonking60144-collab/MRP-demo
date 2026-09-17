import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import { config } from '@/lib/config';
import { fetchRagicRecord } from '@/lib/ragic-client';
import { evaluateInventoryLotQuantity } from '@/lib/sync/inventory-snapshot';
import { INVENTORY_LOT_FIELD_IDS } from '@/lib/sync/field-maps';

export async function GET(req: NextRequest) {
  const runId = Number(req.nextUrl.searchParams.get('runId'));
  const recordId = req.nextUrl.searchParams.get('recordId')?.trim();
  const dbSource = req.nextUrl.searchParams.get('dbSource');

  if (!Number.isInteger(runId) || runId <= 0 || !recordId) {
    return NextResponse.json({ error: '缺少或無效的 runId、recordId' }, { status: 400 });
  }
  if (dbSource !== null && !isDbMode(dbSource)) {
    return NextResponse.json({ error: '無效的 dbSource' }, { status: 400 });
  }
  const client = dbSource ? getClientForMode(dbSource) : prisma;
  if (!client) {
    return NextResponse.json({ error: `資料庫來源目前無法使用：${dbSource}` }, { status: 503 });
  }

  const snapshot = await client.stagingInventoryLot.findUnique({
    where: {
      mrpRunId_ragicRecordId: {
        mrpRunId: runId,
        ragicRecordId: recordId,
      },
    },
  });
  if (!snapshot) {
    return NextResponse.json({ error: '找不到此 MRP Run 的庫存批號快照' }, { status: 404 });
  }

  const liveRecord = await fetchRagicRecord({
    path: '/default/forms4/16',
    recordId,
  });
  const liveStockPc = liveRecord[INVENTORY_LOT_FIELD_IDS.stockPc];
  const liveStockKg = liveRecord[INVENTORY_LOT_FIELD_IDS.stockKg];
  const liveValidation = evaluateInventoryLotQuantity({
    stockPc: liveStockPc,
    stockKg: liveStockKg,
    unitWeightG: liveRecord[INVENTORY_LOT_FIELD_IDS.unitWeightG],
  });

  const live = {
    stockPc: Number(String(liveStockPc ?? '').replace(/,/g, '')) || 0,
    stockKg: Number(String(liveStockKg ?? '').replace(/,/g, '')) || 0,
    ...liveValidation,
  };
  return NextResponse.json({
    recordId,
    ragicUrl: `${config.ragicBaseUrl}/default/forms4/16/${recordId}`,
    snapshot: {
      stockPc: Number(snapshot.stockPc),
      stockKg: Number(snapshot.stockKg),
      unitWeightG: snapshot.unitWeightG == null ? null : Number(snapshot.unitWeightG),
      expectedStockPc: snapshot.expectedStockPc == null ? null : Number(snapshot.expectedStockPc),
      stockPcDiff: snapshot.stockPcDiff == null ? null : Number(snapshot.stockPcDiff),
      quantityAnomaly: snapshot.quantityAnomaly,
    },
    live,
    ragicCorrected: snapshot.quantityAnomaly && !live.quantityAnomaly,
    mrpRunNeedsRefresh:
      Number(snapshot.stockPc) !== live.stockPc
      || Number(snapshot.stockKg) !== live.stockKg
      || snapshot.quantityAnomaly !== live.quantityAnomaly,
    dbSource,
  });
}
