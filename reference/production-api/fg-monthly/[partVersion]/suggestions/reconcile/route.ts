import { NextRequest, NextResponse } from 'next/server';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import {
  inspectUnknownTransfer,
  reconcileUnknownTransfer,
  TRANSFER_RECONCILIATION_ACTION,
  TransferReconciliationError,
} from '@/lib/mrp/transfer-reconciliation';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ partVersion: string }> },
) {
  try {
    const { partVersion } = await params;
    const decodedPartVersion = decodeURIComponent(partVersion);
    const body = await req.json();
    const runId = Number(body.runId);
    const planSequence = Number(body.planSequence);
    const action = body.action;

    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'runId 必須是正整數。' }, { status: 400 });
    }
    if (!Number.isInteger(planSequence) || planSequence <= 0) {
      return NextResponse.json({ error: 'planSequence 必須是正整數。' }, { status: 400 });
    }
    if (
      action !== TRANSFER_RECONCILIATION_ACTION.INSPECT
      &&
      action !== TRANSFER_RECONCILIATION_ACTION.CONFIRM_CREATED
      && action !== TRANSFER_RECONCILIATION_ACTION.CONFIRM_NOT_CREATED
    ) {
      return NextResponse.json({ error: '不支援的對帳動作。' }, { status: 400 });
    }

    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json({ error: '找不到最新 MRP run。' }, { status: 404 });
    }
    if (latest.id !== runId) {
      return NextResponse.json(
        { error: '選取的 MRP Run 已不是最新版本，請重新整理後再對帳。' },
        { status: 409 },
      );
    }

    if (action === TRANSFER_RECONCILIATION_ACTION.INSPECT) {
      const inspection = await inspectUnknownTransfer({
        runId: latest.id,
        runCreatedAt: latest.createdAt,
        versionCode: latest.versionCode,
        partVersion: decodedPartVersion,
        planSequence,
      });
      return NextResponse.json({ inspection });
    }

    const reconciliation = await reconcileUnknownTransfer({
      runId: latest.id,
      runCreatedAt: latest.createdAt,
      versionCode: latest.versionCode,
      partVersion: decodedPartVersion,
      planSequence,
      action,
      ragicRecordId: body.ragicRecordId,
    });
    return NextResponse.json({ reconciliation });
  } catch (error) {
    if (error instanceof TransferReconciliationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[轉單對帳] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
