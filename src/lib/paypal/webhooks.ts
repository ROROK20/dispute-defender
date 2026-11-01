import type {
  PayPalEnv,
  PayPalWebhookEvent,
  VerificationStatus,
  WebhookVerificationHeaders,
} from './types';
import { PayPalApiError } from './types';

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

function apiBase(env: PayPalEnv): string {
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function currentEnv(): PayPalEnv {
  return process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
}

let tokenCache: { token: string; expiresAt: number; env: PayPalEnv } | null = null;

async function getAccessToken(env: PayPalEnv): Promise<string> {
  if (tokenCache && tokenCache.env === env && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');

  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });
  const debugId = res.headers.get('paypal-debug-id');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PayPalApiError({ status: res.status, message: `OAuth token request failed: ${text.slice(0, 300)}`, debugId });
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new PayPalApiError({ status: res.status, message: 'OAuth response missing access_token', debugId });
  const ttlMs = Math.max(0, ((json.expires_in ?? 300) - 60) * 1000);
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttlMs, env };
  return json.access_token;
}

/**
 * Verifies a webhook via POST /v1/notifications/verify-webhook-signature.
 * Never throws: failures resolve to `{verified:false}` so the route can store
 * the event with verified=0 and answer 400.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  headers: HeaderSource,
  opts: { webhookId?: string; env?: PayPalEnv } = {},
): Promise<VerifyResult> {
  const started = Date.now();
  const webhookId = opts.webhookId ?? process.env.PAYPAL_WEBHOOK_ID ?? '';
  const h = extractVerificationHeaders(headers);
  if (!h) {
    return { verified: false, verification_status: 'FAILURE', status_code: null, debug_id: null, duration_ms: 0, error: 'Missing PayPal transmission headers' };
  }

  if (process.env.PAYPAL_MOCK === '1') {
    const ok = parseWebhookEvent(rawBody) !== null;
    return {
      verified: ok,
      verification_status: ok ? 'SUCCESS' : 'FAILURE',
      status_code: 200,
      debug_id: 'mock-debug-id',
      duration_ms: Date.now() - started,
      error: ok ? undefined : 'Body is not a PayPal event',
    };
  }

  let body: string;
  try {
    body = buildVerifyBody(rawBody, h, webhookId);
  } catch (err) {
    return { verified: false, verification_status: 'FAILURE', status_code: null, debug_id: null, duration_ms: Date.now() - started, error: (err as Error).message };
  }

  const env = opts.env ?? currentEnv();
  try {
    const token = await getAccessToken(env);
    const res = await fetch(`${apiBase(env)}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const debugId = res.headers.get('paypal-debug-id');
    const text = await res.text();
    if (!res.ok) {
      return { verified: false, verification_status: 'FAILURE', status_code: res.status, debug_id: debugId, duration_ms: Date.now() - started, error: text.slice(0, 300) };
    }
    let status: VerificationStatus = 'FAILURE';
    try {
      const parsed = JSON.parse(text) as { verification_status?: string };
      status = parsed.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
    } catch {
      status = 'FAILURE';
    }
    return { verified: status === 'SUCCESS', verification_status: status, status_code: res.status, debug_id: debugId, duration_ms: Date.now() - started };
  } catch (err) {
    const e = err as Error & { debugId?: string | null; status?: number };
    return {
      verified: false,
      verification_status: 'FAILURE',
      status_code: typeof e.status === 'number' ? e.status : null,
      debug_id: e.debugId ?? null,
      duration_ms: Date.now() - started,
      error: e.message,
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