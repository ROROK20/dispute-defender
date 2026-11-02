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

/**
 * Mock-only shipping details for the SNAD and UNAUTHORISED fixture disputes, so
 * each mock capture resolves to an order built from its own dispute (SKU,
 * amount, buyer) instead of the INR order. Tracking numbers point at entries
 * in data/fixtures/carrier-events.json. The INR capture keeps order.json.
 */
const MOCK_SHIPPING: Record<string, { address: Json; tracking: string; email: string }> = {
  '3TC66912BV448105W': {
    address: { address_line_1: '3104 Bryant Ave S', admin_area_2: 'Minneapolis', admin_area_1: 'MN', postal_code: '55408', country_code: 'US' },
    tracking: '9400111899223344556752',
    email: 'buyer.snad@example.com',
  },
  '9GF13457QE820934M': {
    address: { address_line_1: '2860 Gilpin St', admin_area_2: 'Denver', admin_area_1: 'CO', postal_code: '80205', country_code: 'US' },
    tracking: '9405511899223344556707',
    email: 'buyer.unauth@example.com',
  },
};

function disputeForCapture(captureId: string): Json | null {
  return (
    allDisputes().find((d) =>
      ((d.disputed_transactions as Json[] | undefined) ?? []).some((t) => t.seller_transaction_id === captureId),
    ) ?? null
  );
}

function mockOrderIdFor(captureId: string): string {
  return `MOCKORDER${captureId.slice(0, 8)}`;
}

/** Order v2 shape for a fixture capture other than the INR one, or null to use order.json. */
function orderForCapture(captureId: string): Json | null {
  const ship = MOCK_SHIPPING[captureId];
  const dispute = disputeForCapture(captureId);
  if (!ship || !dispute) return null;
  const tx = ((dispute.disputed_transactions as Json[])[0] ?? {}) as Json;
  const item = (((tx.items as Json[] | undefined) ?? [])[0] ?? {}) as Json;
  const amount = (tx.gross_amount ?? dispute.dispute_amount) as Json;
  const buyer = String((tx.buyer as Json | undefined)?.name ?? 'Sandbox Buyer');
  const [given, ...rest] = buyer.split(' ');
  const created = String(tx.create_time ?? dispute.create_time ?? '');
  return {
    id: mockOrderIdFor(captureId),
    intent: 'CAPTURE',
    status: 'COMPLETED',
    payer: { name: { given_name: given, surname: rest.join(' ') }, email_address: ship.email },
    purchase_units: [
      {
        reference_id: item.item_id,
        amount,
        items: [{ name: item.item_name, sku: item.item_id, quantity: String(item.item_quantity ?? '1'), unit_amount: amount }],
        shipping: {
          name: { full_name: buyer },
          address: ship.address,
          trackers: [{ id: `${captureId}-${ship.tracking}`, status: 'SHIPPED', create_time: created, update_time: created }],
        },
        payments: { captures: [{ id: captureId, status: 'COMPLETED', amount, create_time: created, update_time: created }] },
      },
    ],
    create_time: created,
    update_time: created,
  };
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
    const id = decodeURIComponent(m[1]);
    const order = orderForCapture(id);
    if (!order) return ok({ ...loadFixture<Json>('capture.json'), id });
    const unit = (order.purchase_units as Json[])[0];
    return ok({
      ...loadFixture<Json>('capture.json'),
      id,
      amount: unit.amount,
      create_time: order.create_time,
      update_time: order.update_time,
      supplementary_data: { related_ids: { order_id: order.id } },
    });
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
    const orderId = decodeURIComponent(m[1]);
    const capture = Object.keys(MOCK_SHIPPING).find((c) => mockOrderIdFor(c) === orderId);
    const built = capture ? orderForCapture(capture) : null;
    return ok(built ?? { ...loadFixture<Json>('order.json'), id: orderId });
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
    const transactionId = trackerId.slice(0, dash);
    const trackingNumber = trackerId.slice(dash + 1);
    const ship = MOCK_SHIPPING[transactionId];
    const shipped = ship ? String(orderForCapture(transactionId)?.create_time ?? '').slice(0, 10) : null;
    return ok({
      ...tracker,
      transaction_id: transactionId,
      tracking_number: trackingNumber,
      ...(shipped ? { shipment_date: shipped } : {}),
    });
  }

  return notFound(`${method} ${p}`);
}