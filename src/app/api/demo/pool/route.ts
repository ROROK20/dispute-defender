import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const disputes = getDb()
      .prepare(
        `SELECT d.id, d.reason, d.amount_cents
           FROM disputes d
          WHERE d.source = 'paypal_sandbox'
            AND d.status = 'WAITING_FOR_SELLER_RESPONSE'
            AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispute_id = d.id)
          ORDER BY COALESCE(d.pp_created_at, d.last_synced_at) ASC`,
      )
      .all() as { id: string; reason: string; amount_cents: number }[];
    return NextResponse.json({ available: disputes.length, disputes });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}