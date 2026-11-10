import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-list-'));
process.env.PAYPAL_MOCK = '1';
process.env.ANTHROPIC_MOCK = '1';
process.env.PAYPAL_ENV = 'sandbox';
process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');

type RouteModule = { GET: (req: Request) => Promise<Response> };
let route: RouteModule;

beforeAll(async () => {
  const { getDb } = await import('../../src/lib/db');
  const db = getDb();
  const now = new Date().toISOString();
  const raw = (buyer: string | null) =>
    JSON.stringify({ disputed_transactions: [{ seller_transaction_id: 'CAP1', ...(buyer ? { buyer: { name: buyer } } : {}) }] });
  const insert = db.prepare(
    `INSERT INTO disputes (id, source, reason, status, amount_cents, currency, seller_response_due_at, last_synced_at, raw_json)
     VALUES (?, 'paypal_sandbox', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'WAITING_FOR_SELLER_RESPONSE', 5000, 'USD', ?, ?, ?)`,
  );
  insert.run('PP-D-NAMED', now, now, raw('Marisol Fenwick'));
  insert.run('PP-D-NONAME', now, now, raw(null));
  route = (await import('../../src/app/api/disputes/route')) as unknown as RouteModule;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/disputes', () => {
  it("names the buyer from PayPal's dispute payload when there is no local order, like the detail view", async () => {
    const res = await route.GET(new Request('http://localhost/api/disputes'));
    expect(res.status).toBe(200);
    const { disputes } = (await res.json()) as { disputes: { id: string; buyer_name: string | null; raw_json?: unknown }[] };
    const byId = Object.fromEntries(disputes.map((d) => [d.id, d]));
    expect(byId['PP-D-NAMED'].buyer_name).toBe('Marisol Fenwick');
    expect(byId['PP-D-NONAME'].buyer_name).toBeNull();
    // The raw PayPal payload itself is not sent to the browser.
    expect(byId['PP-D-NAMED'].raw_json).toBeUndefined();
  });
});
