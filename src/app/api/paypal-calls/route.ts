import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const disputeId = new URL(req.url).searchParams.get('dispute_id');
    const db = getDb();
    const calls = disputeId
      ? db.prepare('SELECT * FROM paypal_calls WHERE dispute_id = ? ORDER BY id DESC LIMIT 500').all(disputeId)
      : db.prepare('SELECT * FROM paypal_calls ORDER BY id DESC LIMIT 500').all();
    return NextResponse.json({ calls });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}