import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const body = await req.json();
  const updateData: Record<string, unknown> = {};

  if (body.presetName !== undefined) updateData.presetName = body.presetName;
  if (body.isDefault !== undefined) updateData.isDefault = body.isDefault;
  if (body.sorting !== undefined) updateData.sorting = body.sorting;
  if (body.filtering !== undefined) updateData.filtering = body.filtering;
  if (body.columnVisibility !== undefined) updateData.columnVisibility = body.columnVisibility;

  const preset = await prisma.tablePreset.update({
    where: { id },
    data: updateData,
  });

  return NextResponse.json({ preset });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  await prisma.tablePreset.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
