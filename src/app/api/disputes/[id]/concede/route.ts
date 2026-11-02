import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { concede, SubmitError } from '@/lib/submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ run_id: z.string().min(1), action: z.literal('accept_claim'), note: z.string().min(1).max(2000) }),
  z.object({
    run_id: z.string().min(1),
    action: z.literal('make_offer'),
    note: z.string().min(1).max(2000),
    offer_amount_cents: z.number().int().positive(),
    offer_type: z.enum(['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT']).default('REFUND'),
  }),
]);

type Row = Record<string, unknown>;

function fail(status: number, code: string, message: string, debug_id?: string) {
  return NextResponse.json({ error: { code, message, ...(debug_id ? { debug_id } : {}) } }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return fail(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'Invalid body');
  }

  try {
    const db = getDb();
    const dispute = db.prepare('SELECT id, source, amount_cents FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!dispute) return fail(404, 'NOT_FOUND', `Dispute ${id} not found`);
    if (dispute.source === 'fixture') return fail(422, 'FIXTURE_READ_ONLY', 'Fixture history disputes cannot be changed in PayPal.');

    const run = db.prepare('SELECT id, status FROM agent_runs WHERE id = ? AND dispute_id = ?').get(body.run_id, id) as Row | undefined;
    if (!run) return fail(404, 'NOT_FOUND', `Run ${body.run_id} not found for this dispute`);
    if (['submitted', 'conceded'].includes(run.status as string)) {
      return fail(409, 'INVALID_STATE', `This run was already ${run.status as string}.`);
    }
    if (body.action === 'make_offer' && body.offer_amount_cents > Number(dispute.amount_cents)) {
      return fail(400, 'BAD_REQUEST', 'Offer cannot exceed the disputed amount.');
    }

    const result = await concede(
      body.action === 'accept_claim'
        ? { disputeId: id, runId: body.run_id, action: 'accept_claim', note: body.note }
        : {
            disputeId: id,
            runId: body.run_id,
            action: 'make_offer',
            note: body.note,
            offerAmountCents: body.offer_amount_cents,
            offerType: body.offer_type,
          },
    );
    return NextResponse.json({ decision_id: result.decision_id, paypal: result.paypal });
  } catch (e) {
    if (e instanceof SubmitError) return NextResponse.json(e.toBody(), { status: e.httpStatus });
    const err = e as { message?: string; debugId?: string | null };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? undefined);
  }
}
