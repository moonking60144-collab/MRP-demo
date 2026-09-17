import { NextRequest, NextResponse } from 'next/server';
import { getIgnoredCustomerCodes, setIgnoredCustomerCodes } from '@/lib/app-settings';

/** GET /api/fg-monthly/ignored-customers — 取得成品月推移的忽略客戶代碼清單。 */
export async function GET() {
  try {
    return NextResponse.json({ codes: await getIgnoredCustomerCodes() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/** PUT /api/fg-monthly/ignored-customers — 覆寫清單。body: { codes: string[] } */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    if (!Array.isArray(body.codes) || body.codes.some((c: unknown) => typeof c !== 'string')) {
      return NextResponse.json({ error: 'codes 必須是字串陣列' }, { status: 400 });
    }
    const codes = await setIgnoredCustomerCodes(body.codes);
    return NextResponse.json({ codes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
