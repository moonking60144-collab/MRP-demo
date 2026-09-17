import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { collectCustomerCodeOptions } from '@/lib/data-table-server-filters';

export async function GET(req: NextRequest) {
  try {
    const runIdParam = req.nextUrl.searchParams.get('runId');
    const runId = runIdParam ? Number(runIdParam) : (await getLatestRun())?.id;
    if (!Number.isInteger(runId) || !runId || runId <= 0) {
      return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
    }

    const rows = await prisma.stagingPartVersion.findMany({
      where: { mrpRunId: runId, customerCode: { not: null } },
      select: { customerCode: true },
      distinct: ['customerCode'],
    });
    const values = collectCustomerCodeOptions(rows);

    return NextResponse.json({ runId, values });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '讀取客戶代碼選項失敗' },
      { status: 500 },
    );
  }
}
