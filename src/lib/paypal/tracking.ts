import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PayPalEnv,
  PayPalTracker,
  TrackerInput,
  TrackerStatus,
  TrackersBatchResponse,
} from './types';
import { PayPalApiError } from './types';

/**
 * PayPal Add Tracking API:
 *   POST /v1/shipping/trackers-batch
 *   GET  /v1/shipping/trackers/{transaction_id}-{tracking_number}
 * With PAYPAL_MOCK=1 the calls resolve from data/fixtures/mock-paypal/tracker.json.
 */

export interface TrackingCallMeta {
  status_code: number;
  debug_id: string | null;
  duration_ms: number;
}

function apiBase(env: PayPalEnv): string {
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function currentEnv(): PayPalEnv {
  return process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
}

function isMock(): boolean {
  return process.env.PAYPAL_MOCK === '1';
}

let tokenCache: { token: string; expiresAt: number; env: PayPalEnv } | null = null;

async function accessToken(env: PayPalEnv): Promise<string> {
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
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PayPalApiError({ status: res.status, message: `OAuth token request failed: ${text.slice(0, 300)}`, debugId: res.headers.get('paypal-debug-id') });
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new PayPalApiError({ status: res.status, message: 'OAuth response missing access_token' });
  tokenCache = { token: json.access_token, expiresAt: Date.now() + Math.max(0, ((json.expires_in ?? 300) - 60) * 1000), env };
  return json.access_token;
}

async function call<T>(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<{ data: T; meta: TrackingCallMeta }> {
  const env = currentEnv();
  const started = Date.now();
  const token = await accessToken(env);
  let res: Response;
  try {
    res = await fetch(`${apiBase(env)}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PayPalApiError({ status: 0, message: `Network error calling ${method} ${apiPath}: ${(err as Error).message}` });
  }
  const debugId = res.headers.get('paypal-debug-id');
  const text = await res.text();
  const meta: TrackingCallMeta = { status_code: res.status, debug_id: debugId, duration_ms: Date.now() - started };
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const errBody = (parsed ?? {}) as { name?: string; message?: string; details?: unknown };
    throw new PayPalApiError({
      status: res.status,
      message: errBody.message ?? `PayPal ${method} ${apiPath} failed with ${res.status}`,
      name: errBody.name ?? null,
      debugId: debugId ?? (parsed as { debug_id?: string } | null)?.debug_id ?? null,
      details: errBody.details,
    });
  }
  return { data: (parsed ?? {}) as T, meta };
}

async function loadMockTracker(): Promise<PayPalTracker> {
  const file = path.join(process.cwd(), 'data', 'fixtures', 'mock-paypal', 'tracker.json');
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as PayPalTracker;
  } catch (err) {
    throw new Error(`Cannot read mock tracker fixture at ${file}: ${(err as Error).message}`);
  }
}

const mockMeta = (): TrackingCallMeta => ({ status_code: 200, debug_id: 'mock-debug-id', duration_ms: 0 });

/** POST /v1/shipping/trackers-batch */
export async function addTrackers(
  trackers: TrackerInput[],
): Promise<{ data: TrackersBatchResponse; meta: TrackingCallMeta }> {
  if (trackers.length === 0) throw new Error('addTrackers called with no trackers');
  for (const t of trackers) {
    if (!t.transaction_id || !t.tracking_number || !t.carrier) {
      throw new Error('Each tracker needs transaction_id, tracking_number and carrier');
    }
  }
  if (isMock()) {
    return {
      data: {
        tracker_identifiers: trackers.map((t) => ({ transaction_id: t.transaction_id, tracking_number: t.tracking_number })),
        errors: [],
      },
      meta: mockMeta(),
    };
  }
  const result = await call<TrackersBatchResponse>('POST', '/v1/shipping/trackers-batch', { trackers });
  const errors = result.data.errors ?? [];
  if (errors.length > 0) {
    throw new PayPalApiError({
      status: result.meta.status_code,
      message: `trackers-batch rejected: ${errors.map((e) => e.message ?? e.name ?? 'unknown').join('; ')}`,
      debugId: result.meta.debug_id,
      details: errors,
    });
  }
  return result;
}

/** Adds one SHIPPED tracker for a capture. */
export async function addTracking(input: {
  capture_id: string;
  tracking_number: string;
  carrier: string;
  status?: TrackerStatus;
  notify_buyer?: boolean;
}): Promise<{ data: TrackersBatchResponse; meta: TrackingCallMeta }> {
  return addTrackers([
    {
      transaction_id: input.capture_id,
      tracking_number: input.tracking_number,
      status: input.status ?? 'SHIPPED',
      carrier: input.carrier,
      notify_buyer: input.notify_buyer ?? false,
    },
  ]);
}

/** GET /v1/shipping/trackers/{transaction_id}-{tracking_number}. Returns null on 404. */
export async function getTracker(
  captureId: string,
  trackingNumber: string,
): Promise<{ data: PayPalTracker | null; meta: TrackingCallMeta }> {
  if (!captureId || !trackingNumber) throw new Error('getTracker needs captureId and trackingNumber');
  if (isMock()) {
    const fixture = await loadMockTracker();
    return { data: { ...fixture, transaction_id: captureId, tracking_number: trackingNumber }, meta: mockMeta() };
  }
  const id = `${encodeURIComponent(captureId)}-${encodeURIComponent(trackingNumber)}`;
  try {
    return await call<PayPalTracker>('GET', `/v1/shipping/trackers/${id}`);
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) {
      return { data: null, meta: { status_code: 404, debug_id: err.debugId, duration_ms: 0 } };
    }
    throw err;
  }
}

/** Human line for trace and sources, e.g. "Tracker 9400... status DELIVERED (USPS)". */
export function describeTracker(t: PayPalTracker): string {
  const parts = [`Tracker ${t.tracking_number ?? 'unknown'} status ${t.status}`];
  if (t.carrier) parts.push(`carrier ${t.carrier === 'OTHER' && t.carrier_name_other ? t.carrier_name_other : t.carrier}`);
  if (t.shipment_date) parts.push(`shipped ${t.shipment_date}`);
  if (t.last_updated_time) parts.push(`updated ${t.last_updated_time}`);
  parts.push(`transaction ${t.transaction_id}`);
  return parts.join(', ');
}