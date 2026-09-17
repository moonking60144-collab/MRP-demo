import { NextRequest, NextResponse } from 'next/server';
import prisma, { getClientForMode, isDbMode } from '@/lib/db';
import {
  fetchRagicRecord,
  RagicUpdateError,
  updateRagicRecord,
} from '@/lib/ragic-client';
import {
  INVENTORY_SOURCE_FIELD_IDS,
  RAGIC_ERP_PATHS,
} from '@/lib/sync/field-maps';
import { runLog } from '@/lib/run-logger';
import { resolveComponentWeeklyInventorySources } from '@/lib/mrp/component-weekly-inventory-source';
import { isComponentWeeklyMrpType } from '@/lib/mrp/component-weekly-usage';

const MAX_PURCHASE_LEAD_WEEKS = 260;

interface PurchaseLeadTimeRequest {
  ragicRecordId?: unknown;
  expectedPurchaseLeadWeeks?: unknown;
  expectedConfigured?: unknown;
  purchaseLeadWeeks?: unknown;
}

interface LeadTimeState {
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean;
}

function isValidLeadWeeks(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_PURCHASE_LEAD_WEEKS;
}

function parseRagicLeadTime(value: unknown): LeadTimeState | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { purchaseLeadWeeks: 0, purchaseLeadWeeksConfigured: false };
  }
  const parsed = Number(String(value).replaceAll(',', '').trim());
  if (!isValidLeadWeeks(parsed)) return null;
  return { purchaseLeadWeeks: parsed, purchaseLeadWeeksConfigured: true };
}

function sameLeadTime(left: LeadTimeState, right: LeadTimeState): boolean {
  return left.purchaseLeadWeeks === right.purchaseLeadWeeks
    && left.purchaseLeadWeeksConfigured === right.purchaseLeadWeeksConfigured;
}

function successBody(input: {
  materialPartNo: string;
  ragicRecordId: string;
  runId: number;
  runVersionCode: string;
  previous: LeadTimeState;
  current: LeadTimeState;
  updated: boolean;
  reconciled: boolean;
}) {
  return {
    materialPartNo: input.materialPartNo,
    ragicRecordId: input.ragicRecordId,
    runId: input.runId,
    runVersionCode: input.runVersionCode,
    previousPurchaseLeadWeeks: input.previous.purchaseLeadWeeks,
    previousConfigured: input.previous.purchaseLeadWeeksConfigured,
    purchaseLeadWeeks: input.current.purchaseLeadWeeks,
    purchaseLeadWeeksConfigured: input.current.purchaseLeadWeeksConfigured,
    updated: input.updated,
    reconciled: input.reconciled,
    currentRunUnchanged: true,
    requiresNewRun: input.updated,
  };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ materialPartNo: string }> },
) {
  try {
    const { materialPartNo: encodedMaterialPartNo } = await params;
    const materialPartNo = decodeURIComponent(encodedMaterialPartNo).trim();
    const runId = Number(req.nextUrl.searchParams.get('runId'));
    const mrpType = req.nextUrl.searchParams.get('mrpType');
    const dbSource = req.nextUrl.searchParams.get('dbSource');

    if (!materialPartNo) {
      return NextResponse.json({ error: 'materialPartNo required' }, { status: 400 });
    }
    if (!Number.isInteger(runId) || runId <= 0) {
      return NextResponse.json({ error: 'runId query param required' }, { status: 400 });
    }
    if (!isComponentWeeklyMrpType(mrpType) || mrpType === 'D') {
      return NextResponse.json({ error: 'mrpType query param required (W or B)' }, { status: 400 });
    }
    if (dbSource !== null && !isDbMode(dbSource)) {
      return NextResponse.json({ error: 'invalid dbSource' }, { status: 400 });
    }

    let body: PurchaseLeadTimeRequest;
    try {
      body = await req.json() as PurchaseLeadTimeRequest;
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const ragicRecordId = typeof body.ragicRecordId === 'string'
      ? body.ragicRecordId.trim()
      : '';
    const expectedConfigured = body.expectedConfigured;
    const targetIsClear = body.purchaseLeadWeeks === null;
    if (!/^\d+$/.test(ragicRecordId)) {
      return NextResponse.json({ error: 'valid ragicRecordId required' }, { status: 400 });
    }
    if (!isValidLeadWeeks(body.expectedPurchaseLeadWeeks)) {
      return NextResponse.json(
        { error: `expectedPurchaseLeadWeeks 必須是 0 到 ${MAX_PURCHASE_LEAD_WEEKS} 的整數` },
        { status: 400 },
      );
    }
    if (expectedConfigured !== true && expectedConfigured !== false && expectedConfigured !== null) {
      return NextResponse.json(
        { error: 'expectedConfigured must be true, false, or null' },
        { status: 400 },
      );
    }
    if (!targetIsClear && !isValidLeadWeeks(body.purchaseLeadWeeks)) {
      return NextResponse.json(
        { error: `purchaseLeadWeeks 必須是 null 或 0 到 ${MAX_PURCHASE_LEAD_WEEKS} 的整數` },
        { status: 400 },
      );
    }

    const client = dbSource ? getClientForMode(dbSource) : prisma;
    if (!client) {
      return NextResponse.json({ error: `database source unavailable: ${dbSource}` }, { status: 503 });
    }

    const [run, snapshots] = await Promise.all([
      client.mrpRun.findUnique({
        where: { id: runId },
        select: { versionCode: true },
      }),
      client.stagingInventory.findMany({
        where: { mrpRunId: runId, erpPartNo: materialPartNo },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          ragicRecordId: true,
          erpPartNo: true,
          subtypeCode: true,
          purchaseLeadWeeks: true,
          purchaseLeadWeeksConfigured: true,
        },
      }),
    ]);

    if (!run) {
      return NextResponse.json({ error: 'MRP run not found' }, { status: 404 });
    }
    const {
      sourceByMaterialPartNo,
      sourceCountByMaterialPartNo,
    } = resolveComponentWeeklyInventorySources(snapshots, mrpType);
    const sourceCount = sourceCountByMaterialPartNo.get(materialPartNo) ?? 0;
    if (sourceCount > 1) {
      return NextResponse.json({
        error: '同一 ERP 料號在目前 MRP Run 有多筆主檔來源，未執行 Ragic 更新',
        code: 'RAGIC_SOURCE_AMBIGUOUS',
        sourceCount,
      }, { status: 409 });
    }
    const snapshot = sourceByMaterialPartNo.get(materialPartNo);
    if (!snapshot || snapshot.ragicRecordId !== ragicRecordId) {
      return NextResponse.json(
        { error: 'Ragic 料號來源與目前 MRP Run 不一致' },
        { status: 404 },
      );
    }

    const snapshotState = {
      purchaseLeadWeeks: Number(snapshot.purchaseLeadWeeks) || 0,
      purchaseLeadWeeksConfigured: snapshot.purchaseLeadWeeksConfigured,
    };
    if (
      snapshotState.purchaseLeadWeeks !== body.expectedPurchaseLeadWeeks
      || snapshotState.purchaseLeadWeeksConfigured !== expectedConfigured
    ) {
      return NextResponse.json({
        error: '畫面上的前置期快照已過期，未執行 Ragic 更新',
        code: 'RUN_SNAPSHOT_CHANGED',
      }, { status: 409 });
    }

    let liveRecord: Record<string, unknown>;
    try {
      liveRecord = await fetchRagicRecord({
        path: RAGIC_ERP_PATHS.inventory,
        recordId: ragicRecordId,
        timeoutMs: 15_000,
        retries: 0,
      });
    } catch (error) {
      return NextResponse.json({
        error: `無法讀取 Ragic 料號主檔，未執行更新：${error instanceof Error ? error.message : String(error)}`,
        code: 'RAGIC_READ_FAILED',
      }, { status: 502 });
    }

    const liveMaterialPartNo = String(
      liveRecord[INVENTORY_SOURCE_FIELD_IDS.erpPartNo] ?? '',
    ).trim();
    if (liveMaterialPartNo !== materialPartNo) {
      return NextResponse.json({
        error: 'Ragic record 與選取的 ERP 料號不一致，未執行更新',
        code: 'RAGIC_IDENTITY_MISMATCH',
      }, { status: 409 });
    }

    const liveState = parseRagicLeadTime(
      liveRecord[INVENTORY_SOURCE_FIELD_IDS.purchaseLeadWeeks],
    );
    if (!liveState) {
      return NextResponse.json({
        error: 'Ragic 採購前置期不是有效的整數週數，未執行更新',
        code: 'RAGIC_VALUE_INVALID',
      }, { status: 409 });
    }

    const expectedState: LeadTimeState = {
      purchaseLeadWeeks: body.expectedPurchaseLeadWeeks,
      purchaseLeadWeeksConfigured: expectedConfigured ?? liveState.purchaseLeadWeeksConfigured,
    };
    if (!sameLeadTime(liveState, expectedState)) {
      return NextResponse.json({
        error: 'Ragic 前置期已被其他人修改，未覆蓋新值',
        code: 'RAGIC_VALUE_CHANGED',
        currentPurchaseLeadWeeks: liveState.purchaseLeadWeeks,
        currentConfigured: liveState.purchaseLeadWeeksConfigured,
      }, { status: 409 });
    }

    const targetState: LeadTimeState = targetIsClear
      ? { purchaseLeadWeeks: 0, purchaseLeadWeeksConfigured: false }
      : {
          purchaseLeadWeeks: body.purchaseLeadWeeks as number,
          purchaseLeadWeeksConfigured: true,
        };
    if (sameLeadTime(liveState, targetState)) {
      return NextResponse.json(successBody({
        materialPartNo,
        ragicRecordId,
        runId,
        runVersionCode: run.versionCode,
        previous: liveState,
        current: targetState,
        updated: false,
        reconciled: false,
      }));
    }

    let reconciled = false;
    try {
      await updateRagicRecord(
        RAGIC_ERP_PATHS.inventory,
        ragicRecordId,
        {
          [INVENTORY_SOURCE_FIELD_IDS.purchaseLeadWeeks]: targetIsClear
            ? ''
            : targetState.purchaseLeadWeeks,
        },
        { checkLock: true, timeoutMs: 45_000 },
      );
    } catch (error) {
      if (!(error instanceof RagicUpdateError) || error.outcome === 'definite_failure') {
        return NextResponse.json({
          error: `Ragic 拒絕更新：${error instanceof Error ? error.message : String(error)}`,
          code: 'RAGIC_UPDATE_REJECTED',
        }, { status: 502 });
      }
      reconciled = true;
    }

    let verifiedRecord: Record<string, unknown>;
    try {
      verifiedRecord = await fetchRagicRecord({
        path: RAGIC_ERP_PATHS.inventory,
        recordId: ragicRecordId,
        timeoutMs: 15_000,
        retries: 0,
      });
    } catch (error) {
      return NextResponse.json({
        error: `Ragic 寫入結果無法核對，請先開啟 Ragic 原單確認，不要直接重送：${error instanceof Error ? error.message : String(error)}`,
        code: 'RAGIC_UPDATE_UNVERIFIED',
      }, { status: 502 });
    }

    const verifiedMaterialPartNo = String(
      verifiedRecord[INVENTORY_SOURCE_FIELD_IDS.erpPartNo] ?? '',
    ).trim();
    const verifiedState = parseRagicLeadTime(
      verifiedRecord[INVENTORY_SOURCE_FIELD_IDS.purchaseLeadWeeks],
    );
    if (verifiedMaterialPartNo !== materialPartNo || !verifiedState || !sameLeadTime(verifiedState, targetState)) {
      return NextResponse.json({
        error: 'Ragic 寫入結果與目標值不一致，請先開啟 Ragic 原單確認，不要直接重送',
        code: 'RAGIC_UPDATE_UNVERIFIED',
        currentPurchaseLeadWeeks: verifiedState?.purchaseLeadWeeks ?? null,
        currentConfigured: verifiedState?.purchaseLeadWeeksConfigured ?? null,
      }, { status: 502 });
    }

    runLog.info(
      `[ComponentWeekly] purchase lead time updated material=${materialPartNo} record=${ragicRecordId} old=${liveState.purchaseLeadWeeksConfigured ? liveState.purchaseLeadWeeks : 'unset'} new=${targetState.purchaseLeadWeeksConfigured ? targetState.purchaseLeadWeeks : 'unset'} sourceRun=${runId}`,
    );

    return NextResponse.json(successBody({
      materialPartNo,
      ragicRecordId,
      runId,
      runVersionCode: run.versionCode,
      previous: liveState,
      current: targetState,
      updated: true,
      reconciled,
    }));
  } catch (error) {
    console.error('Failed to update component purchase lead time:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
