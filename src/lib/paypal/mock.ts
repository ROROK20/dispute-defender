import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { readInputPart } from './multipart';

/**
 * PAYPAL_MOCK=1 adapter (tests and CI only). Returns fixtures from
 * data/fixtures/mock-paypal. The UI shows a red MOCK MODE banner whenever it is on.
 */

export interface MockRequest {
  method: string;
  path: string; // path + query, no host
  body?: unknown;
  form?: FormData;
}

export interface MockResponse {
  status: number;
  data: unknown;
  debugId: string;
}

const FIXTURE_DIR = path.join(process.cwd(), 'data', 'fixtures', 'mock-paypal');
const DISPUTE_FIXTURES = ['dispute-inr.json', 'dispute-snad.json', 'dispute-unauth.json'] as const;

type Json = Record<string, unknown>;

const cache = new Map<string, unknown>();

function loadFixture<T = Json>(name: string): T {
  if (!cache.has(name)) {
    const file = path.join(FIXTURE_DIR, name);
    try {
      cache.set(name, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`Mock fixture ${name} could not be read: ${(err as Error).message}`);
    }
  }
  // Deep copy so callers can mutate safely.
  return JSON.parse(JSON.stringify(cache.get(name))) as T;
}

function allDisputes(): Json[] {
  return DISPUTE_FIXTURES.map((n) => loadFixture<Json>(n));
}

function findDispute(id: string): Json {
  const disputes = allDisputes();
  const exact = disputes.find((d) => d.dispute_id === id);
  if (exact) return exact;
  const lower = id.toLowerCase();
  let base = disputes[0];
  if (lower.includes('snad')) base = disputes[1];
  else if (lower.includes('unauth')) base = disputes[2];
  return { ...base, dispute_id: id };
}

function debugId(): string {
  return `mock-${nanoid(12)}`;
}

function ok(data: unknown, status = 200): MockResponse {
  return { status, data, debugId: debugId() };
}

function notFound(p: string): MockResponse {
  return {
    status: 404,
    data: { name: 'RESOURCE_NOT_FOUND', message: `Mock has no fixture for ${p}`, debug_id: debugId() },
    debugId: debugId(),
  };
}

function hateoas(href: string): Json {
  return { links: [{ href, rel: 'self', method: 'GET' }] };
}

export async function mockPaypalRequest(req: MockRequest): Promise<MockResponse> {
  const method = req.method.toUpperCase();
  const [rawPath] = req.path.split('?');
  const p = rawPath.replace(/\/+$/, '');
  let m: RegExpMatchArray | null;

  if (method === 'POST' && p === '/v1/oauth2/token') {
    return ok({ access_token: 'MOCK_ACCESS_TOKEN', token_type: 'Bearer', expires_in: 32400, app_id: 'MOCK' });
  }

  if (method === 'POST' && p === '/v1/notifications/verify-webhook-signature') {
    return ok({ verification_status: 'SUCCESS' });
  }

  if (method === 'POST' && p === '/v1/notifications/webhooks') {
    return ok({ id: `MOCK-WH-${nanoid(8)}`, url: (req.body as Json | undefined)?.url ?? null }, 201);
  }

  if (method === 'GET' && p === '/v1/customer/disputes') {
    const items = allDisputes().map((d) => ({
      dispute_id: d.dispute_id,
      create_time: d.create_time,
      update_time: d.update_time,
      reason: d.reason,
      status: d.status,
      dispute_state: d.dispute_state,
      dispute_amount: d.dispute_amount,
      links: [{ href: `/v1/customer/disputes/${d.dispute_id}`, rel: 'self', method: 'GET' }],
    }));
    return ok({ items, links: [] });
  }

  if ((m = p.match(/^\/v1\/customer\/disputes\/([^/]+)$/)) && method === 'GET') {
    return ok(findDispute(decodeURIComponent(m[1])));
  }

  if ((m = p.match(/^\/v1\/customer\/disputes\/([^/]+)\/(provide-evidence|accept-claim|make-offer|send-message|require-evidence|adjudicate)$/)) && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (action === 'provide-evidence') {
      if (!req.form) return { status: 400, data: { name: 'INVALID_REQUEST', message: 'multipart body required' }, debugId: debugId() };
      const input = await readInputPart<{ evidences?: unknown[] }>(req.form);
      if (!input || !Array.isArray(input.evidences) || input.evidences.length === 0) {
        return { status: 422, data: { name: 'UNPROCESSABLE_ENTITY', message: 'evidences missing' }, debugId: debugId() };
      }
      return ok(loadFixture('provide-evidence-200.json'));
    }
    if (action === 'send-message') {
      if (!req.form) return { status: 400, data: { name: 'INVALID_REQUEST', message: 'multipart body required' }, debugId: debugId() };
      return ok(hateoas(`/v1/customer/disputes/${id}`));
    }
    return ok(hateoas(`/v1/customer/disputes/${id}`));
  }

  if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)$/)) && method === 'GET') {
    return ok({ ...loadFixture<Json>('capture.json'), id: decodeURIComponent(m[1]) });
  }

  if (method === 'POST' && p === '/v2/checkout/orders') {
    const body = (req.body ?? {}) as Json;
    return ok({ id: `MOCK-ORDER-${nanoid(10).toUpperCase()}`, status: 'CREATED', purchase_units: body.purchase_units ?? [] }, 201);
  }

  if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/)) && method === 'POST') {
    const order = loadFixture<Json>('order.json');
    return ok({ ...order, id: decodeURIComponent(m[1]), status: 'COMPLETED' }, 201);
  }

  if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === 'GET') {
    return ok({ ...loadFixture<Json>('order.json'), id: decodeURIComponent(m[1]) });
  }

  if (method === 'POST' && p === '/v1/shipping/trackers-batch') {
    const trackers = ((req.body as Json | undefined)?.trackers as Json[] | undefined) ?? [];
    return ok({
      tracker_identifiers: trackers.map((t) => ({
        transaction_id: t.transaction_id,
        tracking_number: t.tracking_number,
      })),
      errors: [],
    });
  }

  if ((m = p.match(/^\/v1\/shipping\/trackers\/([^/]+)$/)) && method === 'GET') {
    // Tracker id is `{transaction_id}-{tracking_number}`; capture ids never contain '-', so split at the first one.
    const trackerId = decodeURIComponent(m[1]);
    const dash = trackerId.indexOf('-');
    const tracker = loadFixture<Json>('tracker.json');
    if (dash <= 0 || dash === trackerId.length - 1) return ok(tracker);
    return ok({ ...tracker, transaction_id: trackerId.slice(0, dash), tracking_number: trackerId.slice(dash + 1) });
  }

  return notFound(`${method} ${p}`);
}