import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  const started = performance.now();
  const raw = request.nextUrl.searchParams.get('runId');
  const id = raw === null ? null : Number(raw);
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) {
    return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
  }
  const select = { id: true, versionCode: true, runDate: true, status: true, completedAt: true } as const;
  try {
    const stored = id === null ? null : await prisma.mrpRun.findFirst({ where: { id, status: 'completed' }, select });
    const run = stored ?? await prisma.mrpRun.findFirst({ where: { status: 'completed' }, orderBy: { id: 'desc' }, select });
    return NextResponse.json({ run, requestedRunId: id, fallback: id !== null && !stored }, {
      headers: { 'Cache-Control': 'no-store', 'Server-Timing': `selection;dur=${(performance.now() - started).toFixed(1)}` },
    });
  } catch {
    return NextResponse.json({ error: '無法取得 MRP 版本' }, { status: 503 });
  }
}
