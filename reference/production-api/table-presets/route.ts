import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(req: NextRequest) {
  const tableId = req.nextUrl.searchParams.get('tableId');
  if (!tableId) {
    return NextResponse.json({ error: 'tableId is required' }, { status: 400 });
  }

  const presets = await prisma.tablePreset.findMany({
    where: { tableId },
    orderBy: [{ isDefault: 'desc' }, { presetName: 'asc' }],
  });

  return NextResponse.json({ presets });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { tableId, presetName, isDefault, sorting, filtering, columnVisibility } = body;

  if (!tableId || !presetName) {
    return NextResponse.json({ error: 'tableId and presetName are required' }, { status: 400 });
  }

  // If setting as default, unset existing defaults for this table
  if (isDefault) {
    await prisma.tablePreset.updateMany({
      where: { tableId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const preset = await prisma.tablePreset.create({
    data: {
      tableId,
      presetName,
      isDefault: isDefault || false,
      sorting: sorting || {},
      filtering: filtering || {},
      columnVisibility: columnVisibility || {},
    },
  });

  return NextResponse.json({ preset });
}
