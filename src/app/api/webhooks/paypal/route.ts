import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { verifyWebhookSignature } from '@/lib/paypal/webhooks';
import { syncDispute } from '@/lib/sync';
import { enqueueRun } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

const HANDLED = new Set(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED']);

function readVerification(result: unknown): { verified: boolean; status: string } {
  if (typeof result === 'boolean') return { verified: result, status: result ? 'SUCCESS' : 'FAILURE' };
  if (typeof result === 'string') return { verified: result === 'SUCCESS', status: result };
  const o = (result ?? {}) as Row;
  const status = (o.verification_status ?? o.verificationStatus ?? (o.verified ? 'SUCCESS' : 'FAILURE')) as string;
  return { verified: o.verified === true || status === 'SUCCESS', status };
}

async function process(eventId: string, eventType: string, disputeId: string | null) {
  const db = getDb();
  try {
    if (!disputeId || !HANDLED.has(eventType)) return;
    await syncDispute(disputeId);
    if (eventType === 'CUSTOMER.DISPUTE.RESOLVED') return;

    const d = db.prepare('SELECT status, source FROM disputes WHERE id = ?').get(disputeId) as Row | undefined;
    if (!d || d.source === 'fixture') return;
    const hasRun = db.prepare('SELECT 1 FROM agent_runs WHERE dispute_id = ? LIMIT 1').get(disputeId);

    const shouldRun =
      eventType === 'CUSTOMER.DISPUTE.CREATED'
        ? !hasRun
        : d.status === 'WAITING_FOR_SELLER_RESPONSE' && !hasRun;
    if (shouldRun) await enqueueRun(disputeId, eventId);
  } catch (e) {
    console.error(`[webhook] processing ${eventId} failed`, e);
  } finally {
    try {
      db.prepare('UPDATE webhook_events SET processed_at = ? WHERE id = ?').run(new Date().toISOString(), eventId);
    } catch (e) {
      console.error('[webhook] could not mark processed', e);
    }
  }
}

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();
  const rawBody = await req.text();

  let event: Row;
  try {
    event = JSON.parse(rawBody) as Row;
  } catch {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Body is not JSON' } }, { status: 400 });
  }
  const eventId = typeof event.id === 'string' ? event.id : null;
  const eventType = typeof event.event_type === 'string' ? event.event_type : 'UNKNOWN';
  if (!eventId) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Event has no id' } }, { status: 400 });

  const resource = (event.resource ?? {}) as Row;
  const disputeId = (typeof resource.dispute_id === 'string' ? resource.dispute_id : null) ?? (typeof resource.id === 'string' ? resource.id : null);

  const db = getDb();
  const existing = db.prepare('SELECT id, verified FROM webhook_events WHERE id = ?').get(eventId) as Row | undefined;
  if (existing && existing.verified === 1) return NextResponse.json({ duplicate: true });

  const headers = {
    'paypal-transmission-id': req.headers.get('paypal-transmission-id') ?? '',
    'paypal-transmission-time': req.headers.get('paypal-transmission-time') ?? '',
    'paypal-transmission-sig': req.headers.get('paypal-transmission-sig') ?? '',
    'paypal-cert-url': req.headers.get('paypal-cert-url') ?? '',
    'paypal-auth-algo': req.headers.get('paypal-auth-algo') ?? '',
  };

  let verification = { verified: false, status: 'FAILURE' };
  const missing = Object.entries(headers).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === 0) {
    try {
      verification = readVerification(await verifyWebhookSignature(rawBody, headers));
    } catch (e) {
      console.error('[webhook] verify-webhook-signature call failed', e);
      verification = { verified: false, status: 'FAILURE' };
    }
  }

  try {
    db.prepare(
      `INSERT INTO webhook_events (id, source, event_type, resource_id, verified, verification_status, received_at, raw_json)
       VALUES (?, 'paypal', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET verified = excluded.verified, verification_status = excluded.verification_status,
         received_at = CASE WHEN webhook_events.verified = 0 THEN excluded.received_at ELSE webhook_events.received_at END`,
    ).run(eventId, eventType, disputeId, verification.verified ? 1 : 0, verification.status, receivedAt, rawBody);
  } catch (e) {
    console.error('[webhook] storing event failed', e);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Could not store event' } }, { status: 500 });
  }

  if (!verification.verified) {
    return NextResponse.json(
      {
        error: {
          code: 'SIGNATURE_INVALID',
          message: missing.length ? `Missing headers: ${missing.join(', ')}` : 'PayPal did not verify this event signature',
        },
      },
      { status: 400 },
    );
  }

  setImmediate(() => {
    void process(eventId, eventType, disputeId);
  });

  return NextResponse.json({ received: true, event_id: eventId });
}