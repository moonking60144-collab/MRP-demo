import { NextResponse } from 'next/server';
import { getMaintenanceStatus } from '@/lib/maintenance-status';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getMaintenanceStatus());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read maintenance status',
      },
      { status: 500 },
    );
  }
}
