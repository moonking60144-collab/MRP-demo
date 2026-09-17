import { NextRequest, NextResponse } from 'next/server';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { transferPlanToRagic } from '@/lib/mrp/plan-transfer-helpers';

interface PlanToTransfer {
  partVersion: string;
  planSequence: number;
}

/**
 * POST /api/plan-management/batch-transfer — Batch transfer plans to Ragic
 * Body: { plans: [{ partVersion, planSequence }] }
 * Processes sequentially to avoid Ragic rate limits.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const plans: PlanToTransfer[] = body.plans;
    const includeInventoryAnomalies = body.includeInventoryAnomalies === true;

    if (!Array.isArray(plans) || plans.length === 0) {
      return NextResponse.json(
        { error: 'plans array is required and must not be empty' },
        { status: 400 },
      );
    }

    const latest = await getLatestRun();
    if (!latest) {
      return NextResponse.json(
        { error: 'No MRP run found' },
        { status: 404 },
      );
    }

    const results: Array<{
      partVersion: string;
      planSequence: number;
      success: boolean;
      ragicPlanNo?: string | null;
      ragicUrl?: string | null;
      error?: string;
    }> = [];

    // Process sequentially to avoid Ragic rate limits
    for (const plan of plans) {
      try {
        const result = await transferPlanToRagic(
          latest.id,
          latest.versionCode,
          plan.partVersion,
          plan.planSequence,
          { inventoryAnomalyAcknowledged: includeInventoryAnomalies },
        );
        results.push({
          partVersion: plan.partVersion,
          planSequence: plan.planSequence,
          success: true,
          ragicPlanNo: result.ragicPlanNo,
          ragicUrl: result.ragicUrl,
        });
      } catch (err) {
        results.push({
          partVersion: plan.partVersion,
          planSequence: plan.planSequence,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({ results, succeeded, failed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
