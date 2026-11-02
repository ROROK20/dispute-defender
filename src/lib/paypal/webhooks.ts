import { isPaypalError, paypalRequest } from './client';
import type { PayPalWebhookEvent, VerificationStatus, WebhookVerificationHeaders } from './types';

/**
 * Webhook signature verification.
 *
 * PayPal requires `webhook_event` to be the ORIGINAL raw JSON. Re-serialising
 * (JSON.parse -> JSON.stringify) can reorder keys or change number formatting
 * and the verification then fails. We therefore build the request body as a
 * string and splice the raw body in verbatim.
 */

const HEADER_MAP: Record<keyof WebhookVerificationHeaders, string> = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
};

type HeaderSource = Headers | Record<string, string | string[] | undefined | null>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const rec = headers as Record<string, string | string[] | undefined | null>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  if (!key) return null;
  const v = rec[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Pulls the five PayPal transmission headers. Returns null if any is missing. */
export function extractVerificationHeaders(headers: HeaderSource): WebhookVerificationHeaders | null {
  const out: Partial<WebhookVerificationHeaders> = {};
  for (const [field, header] of Object.entries(HEADER_MAP) as [keyof WebhookVerificationHeaders, string][]) {
    const value = readHeader(headers, header);
    if (!value || !value.trim()) return null;
    out[field] = value.trim();
  }
  return out as WebhookVerificationHeaders;
}

/**
 * Builds the verify-webhook-signature request body with the raw event body
 * spliced in byte-for-byte. Throws if the raw body is not a JSON object.
 */
export function buildVerifyBody(
  rawBody: string,
  headers: WebhookVerificationHeaders | HeaderSource,
  webhookId: string,
): string {
  const trimmed = rawBody.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('Webhook body is not a JSON object');
  }
  try {
    JSON.parse(trimmed);
  } catch {
    throw new Error('Webhook body is not valid JSON');
  }
  const h = isVerificationHeaders(headers) ? headers : extractVerificationHeaders(headers);
  if (!h) throw new Error('Missing PayPal transmission headers');
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');

  return (
    '{' +
    `"auth_algo":${JSON.stringify(h.auth_algo)},` +
    `"cert_url":${JSON.stringify(h.cert_url)},` +
    `"transmission_id":${JSON.stringify(h.transmission_id)},` +
    `"transmission_sig":${JSON.stringify(h.transmission_sig)},` +
    `"transmission_time":${JSON.stringify(h.transmission_time)},` +
    `"webhook_id":${JSON.stringify(webhookId)},` +
    `"webhook_event":${rawBody}` +
    '}'
  );
}

function isVerificationHeaders(v: unknown): v is WebhookVerificationHeaders {
  if (!v || typeof v !== 'object' || typeof (v as Headers).get === 'function') return false;
  const o = v as Record<string, unknown>;
  return (Object.keys(HEADER_MAP) as (keyof WebhookVerificationHeaders)[]).every(
    (k) => typeof o[k] === 'string' && (o[k] as string).length > 0,
  );
}

/** Parses the event body; returns null when it is not a well-formed PayPal event. */
export function parseWebhookEvent(rawBody: string): PayPalWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as Partial<PayPalWebhookEvent>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.event_type !== 'string') return null;
    return {
      id: parsed.id,
      event_type: parsed.event_type,
      create_time: typeof parsed.create_time === 'string' ? parsed.create_time : new Date().toISOString(),
      resource: (parsed.resource && typeof parsed.resource === 'object' ? parsed.resource : {}) as Record<string, unknown>,
      resource_type: parsed.resource_type,
      resource_version: parsed.resource_version,
      event_version: parsed.event_version,
      summary: parsed.summary,
      links: parsed.links,
    };
  } catch {
    return null;
  }
}

/** Dispute id from a CUSTOMER.DISPUTE.* event resource. */
export function disputeIdFromEvent(event: PayPalWebhookEvent): string | null {
  const r = event.resource as Record<string, unknown>;
  const id = r?.dispute_id ?? r?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Dispute status carried in the event resource, if any. */
export function disputeStatusFromEvent(event: PayPalWebhookEvent): string | null {
  const status = (event.resource as Record<string, unknown>)?.status;
  return typeof status === 'string' ? status : null;
}

export interface VerifyResult {
  verified: boolean;
  verification_status: VerificationStatus | 'N/A';
  status_code: number | null;
  debug_id: string | null;
  duration_ms: number;
  error?: string;
}

/**
 * Verifies a webhook via POST /v1/notifications/verify-webhook-signature.
 * The call goes through the shared PayPal client, so it is logged to
 * paypal_calls with its debug_id and answered by the mock adapter when
 * PAYPAL_MOCK=1. The raw body is spliced in by buildVerifyBody and sent as-is.
 * Never throws: failures resolve to `{verified:false}` so the route can store
 * the event with verified=0 and answer 400.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  headers: HeaderSource,
  opts: { webhookId?: string } = {},
): Promise<VerifyResult> {
  const started = Date.now();
  const webhookId = opts.webhookId ?? process.env.PAYPAL_WEBHOOK_ID ?? '';
  const h = extractVerificationHeaders(headers);
  if (!h) {
    return { verified: false, verification_status: 'FAILURE', status_code: null, debug_id: null, duration_ms: 0, error: 'Missing PayPal transmission headers' };
  }

  const event = parseWebhookEvent(rawBody);
  if (!event) {
    return { verified: false, verification_status: 'FAILURE', status_code: null, debug_id: null, duration_ms: Date.now() - started, error: 'Body is not a PayPal event' };
  }

  let body: string;
  try {
    body = buildVerifyBody(rawBody, h, webhookId);
  } catch (err) {
    return { verified: false, verification_status: 'FAILURE', status_code: null, debug_id: null, duration_ms: Date.now() - started, error: (err as Error).message };
  }

  try {
    const res = await paypalRequest<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
      body,
      disputeId: disputeIdFromEvent(event),
      timeoutMs: 8_000,
    });
    const status: VerificationStatus = res.data?.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
    return { verified: status === 'SUCCESS', verification_status: status, status_code: res.status, debug_id: res.debugId, duration_ms: Date.now() - started };
  } catch (err) {
    const known = isPaypalError(err);
    return {
      verified: false,
      verification_status: 'FAILURE',
      status_code: known && err.status > 0 ? err.status : null,
      debug_id: known ? err.debugId : null,
      duration_ms: Date.now() - started,
      error: (err as Error).message,
    };
  }
}

/** Body for POST /v1/notifications/webhooks (used by scripts/register-webhook.ts). */
export function buildRegisterWebhookBody(publicBaseUrl: string): { url: string; event_types: { name: string }[] } {
  const base = publicBaseUrl.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('PUBLIC_BASE_URL must be an https URL for PayPal webhooks');
  return {
    url: `${base}/api/webhooks/paypal`,
    event_types: [
      { name: 'CUSTOMER.DISPUTE.CREATED' },
      { name: 'CUSTOMER.DISPUTE.UPDATED' },
      { name: 'CUSTOMER.DISPUTE.RESOLVED' },
    ],
  };
}