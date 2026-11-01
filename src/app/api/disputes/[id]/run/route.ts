import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { enqueueRun } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ force: z.boolean().optional() }).partial();

type Row = Record<string, unknown>;

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: z.infer<typeof Body> = {};
  try {
    const text = await req.text();
    body = Body.parse(text ? JSON.parse(text) : {});
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be JSON: {force?: boolean}');
  }

  try {
    const db = getDb();
    const dispute = db.prepare('SELECT id, source, status FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!dispute) return fail(404, 'NOT_FOUND', `Dispute ${id} not found`);
    if (dispute.source === 'fixture') {
      return fail(422, 'FIXTURE_READ_ONLY', 'Fixture history disputes are read-only and cannot be run against PayPal.');
    }

    const active = db
      .prepare("SELECT id FROM agent_runs WHERE dispute_id = ? AND status IN ('queued','running') LIMIT 1")
      .get(id) as Row | undefined;
    if (active) return fail(409, 'RUN_ACTIVE', `Run ${active.id as string} is already in progress.`);

    if (!body.force) {
      const finished = db
        .prepare("SELECT id, status FROM agent_runs WHERE dispute_id = ? AND status IN ('submitted','conceded') LIMIT 1")
        .get(id) as Row | undefined;
      if (finished) {
        return fail(409, 'INVALID_STATE', `This dispute was already ${finished.status as string}. Pass force:true to re-run analysis.`);
      }
    }

    // Re-runs are clocked from a fresh event so the stopwatch measures this run, not the original webhook.
    const eventId = `poll_${nanoid(12)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO webhook_events (id, source, event_type, resource_id, verified, verification_status, received_at, raw_json)
       VALUES (?, 'poll', 'SELLER.MANUAL_RUN', ?, 0, 'N/A', ?, ?)`,
    ).run(eventId, id, now, JSON.stringify({ note: 'Run started manually by the seller from the dispute view', force: !!body.force }));

    const runId = await enqueueRun(id, eventId);
    db.prepare('UPDATE webhook_events SET processed_at = ? WHERE id = ?').run(new Date().toISOString(), eventId);

    return NextResponse.json({ run_id: runId }, { status: 202 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint|already/i.test(msg)) return fail(409, 'RUN_ACTIVE', 'A run for this dispute is already in progress.');
    return fail(500, 'INTERNAL', msg);
  }
}