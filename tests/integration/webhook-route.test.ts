import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webhook-'));

process.env.PAYPAL_MOCK = '1';
process.env.ANTHROPIC_MOCK = '1';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID ??= 'test-client';
process.env.PAYPAL_CLIENT_SECRET ??= 'test-secret';
process.env.PAYPAL_WEBHOOK_ID ??= 'WH-TEST';
process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ??= 'test-client';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');

const enqueueRun = vi.fn(async () => 'run_mocked');
vi.mock('../../src/lib/jobs', () => ({ enqueueRun }));

type RouteModule = { POST: (req: Request) => Promise<Response> };
let route: RouteModule;

const HEADERS = {
  'content-type': 'application/json',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-time': '2026-10-28T12:00:00Z',
  'paypal-transmission-sig': 'c2lnbmF0dXJl',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test',
  'paypal-auth-algo': 'SHA256withRSA',
};

function event(id: string, type = 'CUSTOMER.DISPUTE.CREATED') {
  return JSON.stringify({
    id,
    event_type: type,
    resource_type: 'dispute',
    create_time: '2026-10-28T11:59:58Z',
    resource: {
      dispute_id: 'PP-D-MOCK-INR',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_amount: { currency_code: 'USD', value: '64.00' },
    },
  });
}

function post(body: string, headers: Record<string, string> = HEADERS) {
  return new Request('http://localhost/api/webhooks/paypal', { method: 'POST', headers, body });
}

beforeAll(async () => {
  route = (await import('../../src/app/api/webhooks/paypal/route')) as unknown as RouteModule;
});

afterAll(async () => {
  try {
    const { getDb } = await import('../../src/lib/db');
    getDb().close();
  } catch {
    /* db not opened */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/webhooks/paypal', () => {
  it('accepts a verified event, stores it and returns quickly', async () => {
    const started = Date.now();
    const res = await route.POST(post(event('WH-EVT-1')));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, event_id: 'WH-EVT-1' });

    const { getDb } = await import('../../src/lib/db');
    const row = getDb().prepare(`SELECT * FROM webhook_events WHERE id = ?`).get('WH-EVT-1') as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row!.source).toBe('paypal');
    expect(row!.verified).toBe(1);
    expect(row!.resource_id).toBe('PP-D-MOCK-INR');
    expect(row!.raw_json).toBe(event('WH-EVT-1'));
  });

  it('returns duplicate:true for an event id it has already stored', async () => {
    const res = await route.POST(post(event('WH-EVT-1')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });

    const { getDb } = await import('../../src/lib/db');
    const { n } = getDb().prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?`).get('WH-EVT-1') as {
      n: number;
    };
    expect(n).toBe(1);
  });

  it('rejects events missing PayPal signature headers', async () => {
    const res = await route.POST(post(event('WH-EVT-2'), { 'content-type': 'application/json' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await route.POST(post('not json'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('does not start a run for RESOLVED events', async () => {
    enqueueRun.mockClear();
    const res = await route.POST(post(event('WH-EVT-3', 'CUSTOMER.DISPUTE.RESOLVED')));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});