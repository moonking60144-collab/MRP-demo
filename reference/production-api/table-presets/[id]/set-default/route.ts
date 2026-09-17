import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const preset = await prisma.tablePreset.findUnique({ where: { id } });
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Unset all defaults for this table, then set this one
  await prisma.$transaction([
    prisma.tablePreset.updateMany({
      where: { tableId: preset.tableId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.tablePreset.update({
      where: { id },
      data: { isDefault: true },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
