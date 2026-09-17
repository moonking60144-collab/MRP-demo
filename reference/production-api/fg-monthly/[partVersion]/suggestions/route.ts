import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import {
  getEnrichedSuggestions,
  InventoryAnomalyConfirmationRequiredError,
  transferPlanToRagic,
} from '@/lib/mrp/plan-transfer-helpers';
import { TRANSFER_STATUS, TransferStateConflictError } from '@/lib/transfer-state';
import { parseFulfillToPeriod, parsePositivePlanQty } from '@/lib/mrp/fg-plan-input';

/**
 * PATCH /api/fg-monthly/:partVersion/suggestions — Update plan suggestion
 * Body: { planSequence: number, suggestedQty?: number, completionDate?: string, isTransferred?: boolean }
 *
 * When isTransferred=true, also creates a production plan entry in Ragic Form [10]
 * and saves a transfer log record to production_plan_transfers.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ partVersion: string }> },
) {
  try {
    const { partVersion } = await params;
    const decodedPartVersion = decodeURIComponent(partVersion);

    const body = await req.json();
    const {
      planSequence,
      suggestedQty,
      completionDate,
      targetStartPeriod,
      fulfillToPeriod,
      materialWeightKg,
      bufferPct,
      isTransferred,
      returnSuggestions,
      inventoryAnomalyAcknowledged,
    } = body;

    if (planSequence === undefined || planSequence === null) {
      return NextResponse.json(
        { error: 'planSequence is required' },
        { status: 400 },
      );
    }

    // Get latest run
    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json(
        { error: 'No MRP run found' },
        { status: 404 },
      );
    }

    // Build update data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let transferResult: any = null;
    let normalizedSuggestedQty: number | undefined;
    let normalizedFulfillToPeriod: number | undefined;

    if (suggestedQty !== undefined) {
      const parsed = parsePositivePlanQty(suggestedQty);
      if (parsed === null) {
        return NextResponse.json(
          { error: 'suggestedQty must be a finite number greater than 0' },
          { status: 400 },
        );
      }
      normalizedSuggestedQty = parsed;
      updateData.suggestedQty = parsed;
      updateData.useManualQty = true; // Mark as manually edited
    }

    // Parse completionDate once, guarding against empty/unparseable values.
    // An invalid Date (e.g. new Date("")) makes Prisma reject the whole upsert.
    let parsedCompletionDate: Date | undefined;
    if (completionDate !== undefined && completionDate !== null && completionDate !== '') {
      const d = new Date(completionDate);
      if (!isNaN(d.getTime())) {
        parsedCompletionDate = d;
      }
    }

    if (parsedCompletionDate) {
      updateData.completionDate = parsedCompletionDate;
    }

    if (targetStartPeriod !== undefined) {
      updateData.targetStartPeriod = parseInt(String(targetStartPeriod), 10);
    }

    if (fulfillToPeriod !== undefined) {
      const parsed = parseFulfillToPeriod(fulfillToPeriod);
      if (parsed === null) {
        return NextResponse.json(
          { error: 'fulfillToPeriod must be between 0 and 12 in increments of 0.5' },
          { status: 400 },
        );
      }
      normalizedFulfillToPeriod = parsed;
      updateData.fulfillToPeriod = parsed;
    }

    if (materialWeightKg !== undefined) {
      updateData.materialWeightKg = materialWeightKg;
    }

    if (bufferPct !== undefined) {
      updateData.bufferPct = bufferPct;
    }

    // ── Transfer to Ragic Form [10] ──
    if (isTransferred === true) {
      const seqNum = parseInt(String(planSequence), 10);

      try {
        transferResult = await transferPlanToRagic(
          latest.id,
          latest.versionCode,
          decodedPartVersion,
          seqNum,
          { inventoryAnomalyAcknowledged: inventoryAnomalyAcknowledged === true },
        );
      } catch (err) {
        if (err instanceof InventoryAnomalyConfirmationRequiredError) {
          return NextResponse.json(
            { error: err.message, code: err.code, inventoryWarning: err.warning },
            { status: 409 },
          );
        }
        if (err instanceof TransferStateConflictError) {
          return NextResponse.json(
            { error: err.message, transferStatus: err.transferStatus },
            { status: 409 },
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('找不到規劃建議')) {
          return NextResponse.json({ error: msg }, { status: 404 });
        }
        if (msg.includes('Ragic API')) {
          return NextResponse.json(
            { error: msg, transferStatus: TRANSFER_STATUS.FAILED },
            { status: 502 },
          );
        }
        throw err;
      }

      // The helper already marks isTransferred=true in the DB,
      // so skip the upsert below for transfer case — just return.
      // 單筆轉單帶 returnSuggestions=true 時連刷新後的整份 suggestions 一起回傳，
      // 讓前端省掉第二次 GET /periods；批次逐筆轉單不需要（會丟掉 body），故不算，省 2N 次 query。
      const [updated, suggestions] = await Promise.all([
        prisma.fgPlanSuggestion.findUnique({
          where: {
            mrpRunId_partVersion_planSequence: {
              mrpRunId: latest.id,
              partVersion: decodedPartVersion,
              planSequence: seqNum,
            },
          },
        }),
        returnSuggestions ? getEnrichedSuggestions(prisma, latest.id, decodedPartVersion) : Promise.resolve(undefined),
      ]);
      return NextResponse.json({ ...updated, transfer: transferResult, suggestions });
    } else if (isTransferred !== undefined) {
      updateData.isTransferred = isTransferred;
    }

    // If no updates, return 400
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 },
      );
    }

    // Upsert — create if doesn't exist yet, update if it does
    const seqNum = parseInt(String(planSequence), 10);
    const updated = await prisma.fgPlanSuggestion.upsert({
      where: {
        mrpRunId_partVersion_planSequence: {
          mrpRunId: latest.id,
          partVersion: decodedPartVersion,
          planSequence: seqNum,
        },
      },
      update: updateData,
      create: {
        mrpRunId: latest.id,
        partVersion: decodedPartVersion,
        planSequence: seqNum,
        suggestedQty: normalizedSuggestedQty ?? 0,
        completionDate: parsedCompletionDate ?? new Date(),
        targetStartPeriod: targetStartPeriod ?? 0,
        fulfillToPeriod: normalizedFulfillToPeriod ?? 0,
        materialWeightKg: materialWeightKg ?? 0,
        bufferPct: bufferPct ?? 0.10,
        useManualQty: true,
        isTransferred: false,
      },
    });

    return NextResponse.json({ ...updated, transfer: transferResult });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[轉單] Error:', errorMsg);
    return NextResponse.json(
      { error: errorMsg },
      { status: 500 },
    );
  }
}
