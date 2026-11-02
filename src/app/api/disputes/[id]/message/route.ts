import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { sendDisputeMessage, SubmitError } from '@/lib/submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ message: z.string().trim().min(1).max(2000) });

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
    return fail(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'message must be 1–2000 characters');
  }

  try {
    const db = getDb();
    const dispute = db.prepare('SELECT id, source FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!dispute) return fail(404, 'NOT_FOUND', `Dispute ${id} not found`);
    if (dispute.source === 'fixture') return fail(422, 'FIXTURE_READ_ONLY', 'Fixture history disputes cannot be messaged.');

    const result = await sendDisputeMessage({ disputeId: id, message: body.message });
    return NextResponse.json({ decision_id: result.decision_id, paypal: result.paypal });
  } catch (e) {
    if (e instanceof SubmitError) return NextResponse.json(e.toBody(), { status: e.httpStatus });
    const err = e as { message?: string; debugId?: string | null };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? undefined);
  }
}
