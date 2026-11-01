import { getDb } from '../db';

export type WebhookEventSource = 'paypal' | 'demo_trigger' | 'poll';
export type VerificationStatus = 'SUCCESS' | 'FAILURE' | 'N/A';

export interface WebhookEventRow {
  id: string;
  source: WebhookEventSource;
  event_type: string;
  resource_id: string | null;
  verified: number;
  verification_status: VerificationStatus | null;
  received_at: string;
  processed_at: string | null;
  raw_json: string;
}

export interface WebhookEventInput {
  id: string;
  source: WebhookEventSource;
  event_type: string;
  resource_id?: string | null;
  verified: boolean;
  verification_status?: VerificationStatus | null;
  received_at?: string;
  /** Raw body string (stored verbatim) or an object to serialize. */
  raw: string | unknown;
}

/** Idempotent by event id: a duplicate PayPal retry returns `inserted:false` and the stored row. */
export function insertWebhookEvent(input: WebhookEventInput): { inserted: boolean; event: WebhookEventRow } {
  if (!input.id) throw new Error('Webhook event id is required');
  const raw = typeof input.raw === 'string' ? input.raw : JSON.stringify(input.raw ?? {});
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
         (id, source, event_type, resource_id, verified, verification_status, received_at, raw_json)
       VALUES (@id, @source, @event_type, @resource_id, @verified, @verification_status, @received_at, @raw_json)`,
    )
    .run({
      id: input.id,
      source: input.source,
      event_type: input.event_type,
      resource_id: input.resource_id ?? null,
      verified: input.verified ? 1 : 0,
      verification_status: input.verification_status ?? null,
      received_at: input.received_at ?? new Date().toISOString(),
      raw_json: raw,
    });
  const event = getWebhookEvent(input.id);
  if (!event) throw new Error(`Webhook event ${input.id} was not stored`);
  return { inserted: res.changes > 0, event };
}

export function getWebhookEvent(id: string): WebhookEventRow | null {
  return (getDb().prepare(`SELECT * FROM webhook_events WHERE id = ?`).get(id) as WebhookEventRow | undefined) ?? null;
}

export function markEventProcessed(id: string, at: string = new Date().toISOString()): void {
  getDb().prepare(`UPDATE webhook_events SET processed_at = ? WHERE id = ?`).run(at, id);
}

export function listEventsForDispute(disputeId: string): WebhookEventRow[] {
  return getDb()
    .prepare(`SELECT * FROM webhook_events WHERE resource_id = ? ORDER BY received_at ASC`)
    .all(disputeId) as WebhookEventRow[];
}

export function listRecentEvents(limit = 100): WebhookEventRow[] {
  const n = Math.min(Math.max(limit, 1), 1000);
  return getDb()
    .prepare(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?`)
    .all(n) as WebhookEventRow[];
}