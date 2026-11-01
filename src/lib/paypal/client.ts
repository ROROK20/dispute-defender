import * as dbModule from '@/lib/db';
import { mockPaypalRequest } from './mock';

/**
 * PayPal REST client: OAuth2 client-credentials token cache plus a typed fetch
 * wrapper that logs every call (method, path, status, paypal-debug-id, duration)
 * to the paypal_calls table.
 */

export type PaypalEnv = 'sandbox' | 'live';

export function paypalEnv(): PaypalEnv {
  return process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
}

export function isPaypalMock(): boolean {
  const v = (process.env.PAYPAL_MOCK ?? '').toLowerCase();
  return v === '1' || v === 'true';
}

export function paypalBaseUrl(): string {
  return paypalEnv() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export class PaypalError extends Error {
  readonly status: number;
  readonly debugId: string | null;
  readonly paypalName: string | null;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;
  readonly callId: number | null;

  constructor(args: {
    message: string;
    status: number;
    debugId: string | null;
    paypalName: string | null;
    details?: unknown;
    method: string;
    path: string;
    callId: number | null;
  }) {
    super(args.message);
    this.name = 'PaypalError';
    this.status = args.status;
    this.debugId = args.debugId;
    this.paypalName = args.paypalName;
    this.details = args.details;
    this.method = args.method;
    this.path = args.path;
    this.callId = args.callId;
  }

  /** Shape used by route handlers: { error: { code, message, debug_id } }. */
  toJSON() {
    return {
      error: {
        code: this.paypalName ?? `PAYPAL_${this.status}`,
        message: this.message,
        ...(this.debugId ? { debug_id: this.debugId } : {}),
      },
    };
  }
}

export function isPaypalError(err: unknown): err is PaypalError {
  return err instanceof PaypalError;
}

export interface PaypalRequestOptions {
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  disputeId?: string | null;
  runId?: string | null;
  timeoutMs?: number;
  /** PayPal-Request-Id for idempotent POSTs. */
  requestId?: string;
}

export interface PaypalResponse<T> {
  status: number;
  debugId: string | null;
  data: T;
  callId: number | null;
  durationMs: number;
}

// ---------------------------------------------------------------- logging

interface SqliteLike {
  prepare(sql: string): { run(...params: unknown[]): { lastInsertRowid: number | bigint } };
}

function resolveDb(): SqliteLike | null {
  const mod = dbModule as unknown as Record<string, unknown>;
  try {
    if (typeof mod.getDb === 'function') return (mod.getDb as () => SqliteLike)();
    if (typeof mod.db === 'function') return (mod.db as () => SqliteLike)();
    if (mod.db && typeof (mod.db as SqliteLike).prepare === 'function') return mod.db as SqliteLike;
    if (mod.default && typeof (mod.default as SqliteLike).prepare === 'function') return mod.default as SqliteLike;
    if (typeof mod.default === 'function') return (mod.default as () => SqliteLike)();
  } catch {
    return null;
  }
  return null;
}

interface CallLog {
  disputeId: string | null;
  runId: string | null;
  method: string;
  path: string;
  statusCode: number | null;
  debugId: string | null;
  durationMs: number;
  errorName: string | null;
  errorMessage: string | null;
}

function logCall(entry: CallLog): number | null {
  try {
    const db = resolveDb();
    if (!db) return null;
    const res = db
      .prepare(
        `INSERT INTO paypal_calls (dispute_id, run_id, method, path, status_code, debug_id, duration_ms, error_name, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.disputeId,
        entry.runId,
        entry.method,
        entry.path,
        entry.statusCode,
        entry.debugId,
        Math.round(entry.durationMs),
        entry.errorName,
        entry.errorMessage ? entry.errorMessage.slice(0, 2000) : null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  } catch (err) {
    // Logging must never break the PayPal call itself.
    console.error('[paypal] failed to log call', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- token cache

interface TokenState {
  token: string;
  expiresAt: number;
  pending: Promise<string> | null;
}

const g = globalThis as unknown as { __ddPaypalToken?: TokenState };

function tokenState(): TokenState {
  if (!g.__ddPaypalToken) g.__ddPaypalToken = { token: '', expiresAt: 0, pending: null };
  return g.__ddPaypalToken;
}

export function clearTokenCache(): void {
  const s = tokenState();
  s.token = '';
  s.expiresAt = 0;
  s.pending = null;
}

async function fetchToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const method = 'POST';
  const path = '/v1/oauth2/token';
  const started = Date.now();

  if (isPaypalMock()) {
    const res = await mockPaypalRequest({ method, path });
    logCall({ disputeId: null, runId: null, method, path, statusCode: res.status, debugId: res.debugId, durationMs: Date.now() - started, errorName: null, errorMessage: null });
    const data = res.data as { access_token: string; expires_in: number };
    const s = tokenState();
    s.token = data.access_token;
    s.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return s.token;
  }

  if (!clientId || !secret) {
    throw new PaypalError({
      message: 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set',
      status: 0,
      debugId: null,
      paypalName: 'MISSING_CREDENTIALS',
      method,
      path,
      callId: null,
    });
  }

  let res: Response;
  try {
    res = await fetch(`${paypalBaseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const callId = logCall({ disputeId: null, runId: null, method, path, statusCode: null, debugId: null, durationMs: Date.now() - started, errorName: 'NETWORK_ERROR', errorMessage: (err as Error).message });
    throw new PaypalError({ message: `PayPal token request failed: ${(err as Error).message}`, status: 0, debugId: null, paypalName: 'NETWORK_ERROR', method, path, callId });
  }

  const debugId = res.headers.get('paypal-debug-id');
  const text = await res.text().catch(() => '');
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }

  const ok = res.ok && typeof data.access_token === 'string';
  const callId = logCall({
    disputeId: null,
    runId: null,
    method,
    path,
    statusCode: res.status,
    debugId,
    durationMs: Date.now() - started,
    errorName: ok ? null : String(data.error ?? 'TOKEN_ERROR'),
    errorMessage: ok ? null : String(data.error_description ?? text.slice(0, 500)),
  });

  if (!ok) {
    throw new PaypalError({
      message: `PayPal token request failed (${res.status}): ${String(data.error_description ?? data.error ?? 'unknown error')}`,
      status: res.status,
      debugId,
      paypalName: String(data.error ?? 'TOKEN_ERROR'),
      details: data,
      method,
      path,
      callId,
    });
  }

  const s = tokenState();
  s.token = data.access_token as string;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 300;
  s.expiresAt = Date.now() + Math.max(expiresIn - 60, 30) * 1000;
  return s.token;
}

export async function getAccessToken(): Promise<string> {
  const s = tokenState();
  if (s.token && Date.now() < s.expiresAt) return s.token;
  if (!s.pending) {
    s.pending = fetchToken().finally(() => {
      tokenState().pending = null;
    });
  }
  return s.pending;
}

// ---------------------------------------------------------------- request

function buildPath(path: string, query?: PaypalRequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return path;
  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`;
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function errorFromBody(data: unknown, status: number): { name: string; message: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const name = typeof d.name === 'string' ? d.name : typeof d.error === 'string' ? d.error : `HTTP_${status}`;
  let message = typeof d.message === 'string' ? d.message : typeof d.error_description === 'string' ? d.error_description : `PayPal returned ${status}`;
  const details = Array.isArray(d.details) ? (d.details as Record<string, unknown>[]) : [];
  if (details.length > 0) {
    const first = details[0];
    const extra = [first.issue, first.description, first.field].filter(Boolean).join(' — ');
    if (extra) message = `${message} (${extra})`;
  }
  return { name, message };
}

export async function paypalRequest<T = unknown>(
  method: string,
  path: string,
  opts: PaypalRequestOptions = {},
): Promise<PaypalResponse<T>> {
  const upper = method.toUpperCase();
  const fullPath = buildPath(path, opts.query);
  const disputeId = opts.disputeId ?? null;
  const runId = opts.runId ?? null;

  if (isPaypalMock()) {
    const started = Date.now();
    const res = await mockPaypalRequest({ method: upper, path: fullPath, body: opts.body, form: opts.form });
    const durationMs = Date.now() - started;
    const failed = res.status < 200 || res.status >= 300;
    const err = failed ? errorFromBody(res.data, res.status) : null;
    const callId = logCall({ disputeId, runId, method: upper, path: fullPath, statusCode: res.status, debugId: res.debugId, durationMs, errorName: err?.name ?? null, errorMessage: err?.message ?? null });
    if (err) {
      throw new PaypalError({ message: err.message, status: res.status, debugId: res.debugId, paypalName: err.name, details: res.data, method: upper, path: fullPath, callId });
    }
    return { status: res.status, debugId: res.debugId, data: res.data as T, callId, durationMs };
  }

  const attempt = async (retryOn401: boolean): Promise<PaypalResponse<T>> => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.requestId ? { 'PayPal-Request-Id': opts.requestId } : {}),
      ...(opts.headers ?? {}),
    };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form; // fetch sets multipart boundary
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${paypalBaseUrl()}${fullPath}`, {
        method: upper,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      const durationMs = Date.now() - started;
      const msg = (e as Error).name === 'TimeoutError' ? 'PayPal request timed out' : (e as Error).message;
      const callId = logCall({ disputeId, runId, method: upper, path: fullPath, statusCode: null, debugId: null, durationMs, errorName: 'NETWORK_ERROR', errorMessage: msg });
      throw new PaypalError({ message: `PayPal ${upper} ${path} failed: ${msg}`, status: 0, debugId: null, paypalName: 'NETWORK_ERROR', method: upper, path: fullPath, callId });
    }

    const durationMs = Date.now() - started;
    const debugId = res.headers.get('paypal-debug-id');
    const text = await res.text().catch(() => '');
    const data = parseBody(text);

    if (res.status === 401 && retryOn401) {
      logCall({ disputeId, runId, method: upper, path: fullPath, statusCode: 401, debugId, durationMs, errorName: 'AUTHENTICATION_FAILURE', errorMessage: 'token rejected; refreshing' });
      clearTokenCache();
      return attempt(false);
    }

    if (!res.ok) {
      const err = errorFromBody(data, res.status);
      const callId = logCall({ disputeId, runId, method: upper, path: fullPath, statusCode: res.status, debugId, durationMs, errorName: err.name, errorMessage: err.message });
      throw new PaypalError({ message: err.message, status: res.status, debugId, paypalName: err.name, details: data, method: upper, path: fullPath, callId });
    }

    const callId = logCall({ disputeId, runId, method: upper, path: fullPath, statusCode: res.status, debugId, durationMs, errorName: null, errorMessage: null });
    return { status: res.status, debugId, data: data as T, callId, durationMs };
  };

  return attempt(!opts.form);
}

/** Alias kept for callers that prefer the "fetch wrapper" name. */
export const paypalFetch = paypalRequest;

export const paypal = {
  get: <T = unknown>(path: string, opts?: PaypalRequestOptions) => paypalRequest<T>('GET', path, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: PaypalRequestOptions) =>
    paypalRequest<T>('POST', path, { ...(opts ?? {}), body }),
  postForm: <T = unknown>(path: string, form: FormData, opts?: PaypalRequestOptions) =>
    paypalRequest<T>('POST', path, { ...(opts ?? {}), form }),
};

/** Convert integer cents to the "12.34" string PayPal expects. */
export function centsToValue(cents: number): string {
  if (!Number.isFinite(cents)) throw new Error(`Invalid amount: ${cents}`);
  return (Math.round(cents) / 100).toFixed(2);
}

/** Convert PayPal "12.34" to integer cents. */
export function valueToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}