import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

function parse(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const db = getDb();
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!d) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: `Dispute ${id} not found` } }, { status: 404 });
    }

    const order = d.order_id
      ? (db.prepare('SELECT * FROM orders WHERE id = ?').get(d.order_id as string) as Row | undefined) ?? null
      : null;
    const sku = d.sku ? (db.prepare('SELECT * FROM skus WHERE sku = ?').get(d.sku as string) as Row | undefined) ?? null : null;

    const runRow = db
      .prepare('SELECT * FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC, rowid DESC LIMIT 1')
      .get(id) as Row | undefined;

    const run = runRow
      ? {
          ...runRow,
          classification: parse(runRow.classification_json),
          strength: parse(runRow.strength_json),
          ev: parse(runRow.ev_json),
          draft: parse(runRow.draft_json),
          evidence_plan: parse(runRow.evidence_plan_json),
          citation_check: parse(runRow.citation_check_json),
        }
      : null;

    const steps = runRow
      ? (db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq ASC').all(runRow.id as string) as Row[]).map(
          (s) => ({
            seq: s.seq,
            kind: s.kind,
            label: s.label,
            payload: parse(s.payload_json),
            duration_ms: s.duration_ms,
            created_at: s.created_at,
          }),
        )
      : [];

    const sources = runRow
      ? (db
          .prepare('SELECT * FROM sources WHERE run_id = ? ORDER BY CAST(SUBSTR(source_key, 2) AS INTEGER) ASC')
          .all(runRow.id as string) as Row[])
      : [];

    const decisions = (db.prepare('SELECT * FROM decisions WHERE dispute_id = ? ORDER BY created_at DESC').all(id) as Row[]).map(
      (x) => ({ ...x, payload: parse(x.payload_json) }),
    );

    const paypalCalls = db
      .prepare('SELECT * FROM paypal_calls WHERE dispute_id = ? ORDER BY id DESC LIMIT 100')
      .all(id) as Row[];

    const trigger = runRow?.trigger_event_id
      ? (db
          .prepare('SELECT id, source, event_type, verified, verification_status, received_at FROM webhook_events WHERE id = ?')
          .get(runRow.trigger_event_id as string) as Row | undefined) ?? null
      : null;

    const { raw_json, ...disputeRest } = d;
    const dispute = { ...disputeRest, raw: parse(raw_json) };
    const orderOut = order ? { ...order, ship_to: parse(order.ship_to_json), raw_json: undefined } : null;

    return NextResponse.json({
      dispute,
      order: orderOut,
      sku,
      run,
      trigger_event: trigger,
      steps,
      sources,
      decisions,
      paypal_calls: paypalCalls,
    });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}