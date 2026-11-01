import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { sendMessage } from '@/lib/submit';

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

    const latest = db
      .prepare('SELECT id FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC, rowid DESC LIMIT 1')
      .get(id) as Row | undefined;

    const o = ((await sendMessage({ disputeId: id, runId: (latest?.id as string | undefined) ?? undefined, message: body.message })) ??
      {}) as Row;
    const pp = (o.paypal ?? {}) as Row;
    return NextResponse.json({
      decision_id: o.decision_id ?? o.decisionId ?? o.id ?? null,
      paypal: {
        status_code: Number(pp.status_code ?? o.status_code ?? o.statusCode ?? 200),
        debug_id: pp.debug_id ?? o.debug_id ?? o.debugId ?? null,
      },
    });
  } catch (e) {
    const err = e as { message?: string; code?: string; debugId?: string; debug_id?: string };
    const code = err.code ?? 'PAYPAL_ERROR';
    const status = code === 'FIXTURE_READ_ONLY' ? 422 : code === 'INVALID_STATE' ? 409 : 502;
    return fail(status, code, err.message ?? String(e), err.debugId ?? err.debug_id);
  }
}