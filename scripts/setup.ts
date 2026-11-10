/**
 * One-command setup (also runs on every Render boot):
 *  1. applies db/schema.sql
 *  2. loads SKUs from data/fixtures/store.json
 *  3. loads fixture dispute history (source='fixture'), idempotently
 *  4. runs one dispute sync pass if PayPal credentials exist
 *
 * Usage: npm run setup
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pinFixtureShift, shiftFixture } from '../src/lib/fixture-clock';

type Sku = {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  cogs_cents: number;
  description: string;
  size_chart_version: string | null;
};

type FixtureMessage = { id: string; posted_by: 'BUYER' | 'SELLER'; time_posted: string; content: string };

type FixtureDispute = {
  id: string;
  reason: string;
  stage: string;
  status: string;
  outcome: string | null;
  amount_cents: number;
  currency: string;
  sku: string;
  created_at: string;
  updated_at: string;
  order: {
    id: string;
    capture_id: string;
    buyer_name: string;
    buyer_email: string;
    ship_to: Record<string, string>;
    captured_at: string;
    tracking_number: string | null;
    carrier: string | null;
    tracker_status: string | null;
  };
  messages: FixtureMessage[];
};

function loadEnv(): void {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file: rely on the process environment.
  }
}

function readJson<T>(rel: string): T {
  const p = path.resolve(process.cwd(), rel);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Could not read ${rel}: ${(err as Error).message}`);
  }
}

function centsToValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

function openDb(): Database.Database {
  const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH ?? './data/app.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schemaPath = path.resolve(process.cwd(), 'db/schema.sql');
  if (!existsSync(schemaPath)) throw new Error('db/schema.sql not found; run from the repo root');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

function loadSkus(db: Database.Database, skus: Sku[]): number {
  const stmt = db.prepare(`
    INSERT INTO skus (sku, name, category, price_cents, cogs_cents, description, size_chart_version)
    VALUES (@sku, @name, @category, @price_cents, @cogs_cents, @description, @size_chart_version)
    ON CONFLICT(sku) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      price_cents = excluded.price_cents,
      cogs_cents = excluded.cogs_cents,
      description = excluded.description,
      size_chart_version = excluded.size_chart_version
  `);
  db.transaction((rows: Sku[]) => {
    for (const r of rows) stmt.run({ ...r, size_chart_version: r.size_chart_version ?? null });
  })(skus);
  return skus.length;
}

/** Shapes a fixture row like GET /v1/customer/disputes/{id} so every reader treats it uniformly. */
function toPaypalShape(d: FixtureDispute, skuName: string): Record<string, unknown> {
  return {
    dispute_id: d.id,
    create_time: d.created_at,
    update_time: d.updated_at,
    disputed_transactions: [
      {
        seller_transaction_id: d.order.capture_id,
        create_time: d.order.captured_at,
        transaction_status: 'COMPLETED',
        gross_amount: { currency_code: d.currency, value: centsToValue(d.amount_cents) },
        buyer: { name: d.order.buyer_name },
        seller: { name: 'Juniper Thread Co.' },
        items: [{ item_id: d.sku, item_name: skuName, item_quantity: '1' }],
      },
    ],
    reason: d.reason,
    status: d.status,
    dispute_amount: { currency_code: d.currency, value: centsToValue(d.amount_cents) },
    dispute_life_cycle_stage: d.stage,
    dispute_channel: 'INTERNAL',
    dispute_outcome: d.outcome ? { outcome_code: d.outcome } : undefined,
    messages: d.messages.map((m) => ({ id: m.id, posted_by: m.posted_by, time_posted: m.time_posted, content: m.content })),
    source: 'fixture',
  };
}

function loadFixtureHistory(db: Database.Database, disputes: FixtureDispute[], skuNames: Map<string, string>): { orders: number; disputes: number } {
  const insertOrder = db.prepare(`
    INSERT INTO orders (id, capture_id, sku, buyer_name, buyer_email, ship_to_json, amount_cents, currency, status,
                        tracking_number, carrier, tracker_status, captured_at, source, raw_json)
    VALUES (@id, @capture_id, @sku, @buyer_name, @buyer_email, @ship_to_json, @amount_cents, @currency, 'COMPLETED',
            @tracking_number, @carrier, @tracker_status, @captured_at, 'fixture', @raw_json)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertDispute = db.prepare(`
    INSERT INTO disputes (id, source, order_id, capture_id, sku, reason, stage, status, outcome, amount_cents, currency,
                          seller_response_due_at, pp_created_at, pp_updated_at, last_synced_at, raw_json)
    VALUES (@id, 'fixture', @order_id, @capture_id, @sku, @reason, @stage, @status, @outcome, @amount_cents, @currency,
            NULL, @pp_created_at, @pp_updated_at, @last_synced_at, @raw_json)
    ON CONFLICT(id) DO NOTHING
  `);
  const now = new Date().toISOString();
  let orders = 0;
  let inserted = 0;
  db.transaction(() => {
    for (const d of disputes) {
      if (!skuNames.has(d.sku)) throw new Error(`Fixture ${d.id} references unknown SKU ${d.sku}`);
      orders += insertOrder.run({
        id: d.order.id,
        capture_id: d.order.capture_id,
        sku: d.sku,
        buyer_name: d.order.buyer_name,
        buyer_email: d.order.buyer_email,
        ship_to_json: JSON.stringify(d.order.ship_to),
        amount_cents: d.amount_cents,
        currency: d.currency,
        tracking_number: d.order.tracking_number,
        carrier: d.order.carrier,
        tracker_status: d.order.tracker_status,
        captured_at: d.order.captured_at,
        raw_json: JSON.stringify({ ...d.order, source: 'fixture' }),
      }).changes;
      inserted += insertDispute.run({
        id: d.id,
        order_id: d.order.id,
        capture_id: d.order.capture_id,
        sku: d.sku,
        reason: d.reason,
        stage: d.stage,
        status: d.status,
        outcome: d.outcome,
        amount_cents: d.amount_cents,
        currency: d.currency,
        pp_created_at: d.created_at,
        pp_updated_at: d.updated_at,
        last_synced_at: now,
        raw_json: JSON.stringify(toPaypalShape(d, skuNames.get(d.sku) ?? d.sku)),
      }).changes;
    }
  })();
  return { orders, disputes: inserted };
}

async function runSyncPass(): Promise<unknown> {
  const mod = (await import('../src/lib/sync')) as Record<string, unknown>;
  for (const name of ['syncDisputes', 'syncOnce', 'runSync', 'pollOnce', 'sync']) {
    const fn = mod[name];
    if (typeof fn === 'function') return await (fn as () => Promise<unknown>)();
  }
  throw new Error('src/lib/sync.ts exports no one-shot sync function');
}

async function main(): Promise<void> {
  loadEnv();
  const store = readJson<{ skus: Sku[] }>('data/fixtures/store.json');
  const history = readJson<{ source: string; disputes: FixtureDispute[] }>('data/fixtures/historical-disputes.json');
  if (history.source !== 'fixture') throw new Error('historical-disputes.json must carry "source": "fixture"');

  const db = openDb();
  try {
    const n = loadSkus(db, store.skus);
    const names = new Map(store.skus.map((s) => [s.sku, s.name]));
    // Mock mode: move fixture dates to today, pinned for this database (src/lib/fixture-clock.ts).
    const fresh = (db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE source = 'fixture'`).get() as { n: number }).n === 0;
    const shift = pinFixtureShift(process.env.DATABASE_PATH ?? './data/app.db', fresh);
    const loaded = loadFixtureHistory(db, shiftFixture(history.disputes, shift), names);
    console.log(`Schema applied. ${n} SKUs. Fixture history: ${loaded.disputes} new disputes, ${loaded.orders} new orders.`);
    if (shift) console.log(`Mock mode: fixture dates moved forward ${shift} day(s) to the seed day.`);
  } finally {
    db.close();
  }

  const hasCreds = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  if (!hasCreds && process.env.PAYPAL_MOCK !== '1') {
    console.log('No PayPal credentials: skipping sync pass.');
    return;
  }
  try {
    const result = await runSyncPass();
    console.log(`Sync pass done: ${JSON.stringify(result ?? {})}`);
  } catch (err) {
    // Setup runs before `npm start` on Render; a PayPal hiccup must not block boot. The poller retries.
    console.warn(`Sync pass failed (the poller will retry): ${(err as Error).message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Setup failed: ${(err as Error).message}`);
    process.exit(1);
  });