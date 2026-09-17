import { NextRequest, NextResponse } from 'next/server';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { attachProductionPlanRecordId } from '@/lib/mrp/work-order-generation';
import { TransferReconciliationError } from '@/lib/mrp/transfer-reconciliation';
import { WorkOrderStateConflictError } from '@/lib/work-order-state';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  try {
    const { transferId: rawTransferId } = await params;
    const transferId = Number(rawTransferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return NextResponse.json({ error: '無效的生產計畫轉單 ID。' }, { status: 400 });
    }

    const body = await req.json();
    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json({ error: '找不到 MRP 執行版本。' }, { status: 404 });
    }

    const linked = await attachProductionPlanRecordId(
      transferId,
      latest.id,
      String(body.ragicRecordId ?? ''),
    );
    return NextResponse.json({ linked });
  } catch (error) {
    if (error instanceof TransferReconciliationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof WorkOrderStateConflictError) {
      return NextResponse.json(
        { error: error.message, workOrderStatus: error.workOrderStatus },
        { status: error.statusCode },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '連結生產計畫失敗。' },
      { status: 500 },
    );
  }
}
