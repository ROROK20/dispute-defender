import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireEvidence, adjudicate } from '@/lib/paypal/disputes';
import { syncDispute } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('require_evidence'), evidence_for: z.enum(['SELLER_EVIDENCE', 'BUYER_EVIDENCE']) }),
  z.object({ action: z.literal('adjudicate'), outcome: z.enum(['SELLER_FAVOR', 'BUYER_FAVOR']) }),
]);

type Row = Record<string, unknown>;

function fail(status: number, code: string, message: string, debug_id?: string) {
  return NextResponse.json({ error: { code, message, ...(debug_id ? { debug_id } : {}) } }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') {
    return fail(403, 'SANDBOX_ONLY', 'Lifecycle simulation is only available when PAYPAL_ENV=sandbox.');
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return fail(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'Invalid body');
  }

  try {
    const db = getDb();
    const dispute = db.prepare('SELECT id, source, status FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!dispute) return fail(404, 'NOT_FOUND', `Dispute ${id} not found`);
    if (dispute.source === 'fixture') return fail(422, 'FIXTURE_READ_ONLY', 'Fixture history disputes cannot be simulated in PayPal.');

    const raw =
      body.action === 'require_evidence' ? await requireEvidence(id, body.evidence_for) : await adjudicate(id, body.outcome);
    const o = (raw ?? {}) as Row;
    const statusCode = Number(o.status_code ?? o.statusCode ?? o.status ?? 200);
    const debugId = (o.debug_id ?? o.debugId ?? null) as string | null;

    let disputeStatus = dispute.status as string;
    try {
      await syncDispute(id);
      const fresh = db.prepare('SELECT status FROM disputes WHERE id = ?').get(id) as Row | undefined;
      if (fresh?.status) disputeStatus = fresh.status as string;
    } catch (syncErr) {
      console.error('[simulate] post-action sync failed', syncErr);
    }

    return NextResponse.json({ paypal: { status_code: statusCode, debug_id: debugId }, dispute_status: disputeStatus });
  } catch (e) {
    const err = e as { message?: string; debugId?: string; debug_id?: string; status?: number };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? err.debug_id);
  }
}