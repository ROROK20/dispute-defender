/**
 * Loads SKUs from data/fixtures/store.json into SQLite (idempotent upsert).
 * With --tracking, adds a fixture tracking number via trackers-batch for every
 * captured sandbox order in the DB that has none. It never fakes orders.
 *
 * Usage: npm run seed [-- --tracking]
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Sku = {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  cogs_cents: number;
  description: string;
  size_chart_version: string | null;
};

type CarrierFixtures = { trackers: Record<string, { carrier: string; delivered: boolean }> };

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

function upsertSkus(db: Database.Database, skus: Sku[]): number {
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
  const tx = db.transaction((rows: Sku[]) => {
    for (const r of rows) stmt.run({ ...r, size_chart_version: r.size_chart_version ?? null });
  });
  tx(skus);
  return skus.length;
}

function paypalBase(): string {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken(base: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`OAuth failed: ${res.status} debug_id=${res.headers.get('paypal-debug-id') ?? '-'} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('OAuth response had no access_token');
  return json.access_token;
}

function logCall(
  db: Database.Database,
  row: { method: string; path: string; status_code: number | null; debug_id: string | null; duration_ms: number; error_name?: string | null; error_message?: string | null },
): void {
  try {
    db.prepare(
      `INSERT INTO paypal_calls (dispute_id, run_id, method, path, status_code, debug_id, duration_ms, error_name, error_message, created_at)
       VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.method, row.path, row.status_code, row.debug_id, row.duration_ms, row.error_name ?? null, row.error_message ?? null, new Date().toISOString());
  } catch (err) {
    console.warn(`Could not log PayPal call: ${(err as Error).message}`);
  }
}

async function addTracking(db: Database.Database): Promise<void> {
  if (process.env.PAYPAL_MOCK === '1') {
    console.log('PAYPAL_MOCK=1: skipping --tracking (no sandbox orders to update).');
    return;
  }
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('--tracking needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');

  const orders = db
    .prepare(
      `SELECT id, capture_id FROM orders
       WHERE source = 'paypal_sandbox' AND capture_id IS NOT NULL AND tracking_number IS NULL
       ORDER BY captured_at`,
    )
    .all() as { id: string; capture_id: string }[];
  if (orders.length === 0) {
    console.log('No captured sandbox orders without tracking.');
    return;
  }

  const fixtures = readJson<CarrierFixtures>('data/fixtures/carrier-events.json');
  const used = new Set(
    (db.prepare('SELECT tracking_number FROM orders WHERE tracking_number IS NOT NULL').all() as { tracking_number: string }[]).map(
      (r) => r.tracking_number,
    ),
  );
  // Prefer delivered fixtures so tracking evidence is meaningful; reuse only when the pool runs out.
  const all = Object.entries(fixtures.trackers).sort((a, b) => Number(b[1].delivered) - Number(a[1].delivered));
  const free = all.filter(([n]) => !used.has(n));
  const pool = free.length > 0 ? free : all;
  if (free.length < orders.length) {
    console.warn(`Only ${free.length} unused fixture tracking numbers for ${orders.length} orders; some numbers will be reused.`);
  }

  const base = paypalBase();
  const token = await getAccessToken(base, clientId, secret);
  const update = db.prepare(`UPDATE orders SET tracking_number = ?, carrier = ?, tracker_status = 'SHIPPED' WHERE id = ?`);

  let ok = 0;
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const [trackingNumber, info] = pool[i % pool.length];
    const apiPath = '/v1/shipping/trackers-batch';
    const started = Date.now();
    try {
      const res = await fetch(`${base}${apiPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackers: [{ transaction_id: order.capture_id, tracking_number: trackingNumber, status: 'SHIPPED', carrier: info.carrier }],
        }),
      });
      const debugId = res.headers.get('paypal-debug-id');
      const body = (await res.json().catch(() => ({}))) as { errors?: { name?: string; message?: string }[] };
      const batchError = body.errors?.[0];
      logCall(db, {
        method: 'POST',
        path: apiPath,
        status_code: res.status,
        debug_id: debugId,
        duration_ms: Date.now() - started,
        error_name: batchError?.name ?? null,
        error_message: batchError?.message ?? null,
      });
      if (!res.ok || batchError) {
        console.error(`  ${order.id}: tracking failed (${res.status}, debug_id=${debugId ?? '-'}) ${batchError?.message ?? ''}`);
        continue;
      }
      update.run(trackingNumber, info.carrier, order.id);
      ok++;
      console.log(`  ${order.id}: ${info.carrier} ${trackingNumber} (debug_id=${debugId ?? '-'})`);
    } catch (err) {
      logCall(db, {
        method: 'POST',
        path: apiPath,
        status_code: null,
        debug_id: null,
        duration_ms: Date.now() - started,
        error_name: 'NETWORK_ERROR',
        error_message: (err as Error).message,
      });
      console.error(`  ${order.id}: ${(err as Error).message}`);
    }
  }
  console.log(`Tracking added to ${ok}/${orders.length} orders.`);
}

async function main(): Promise<void> {
  loadEnv();
  const store = readJson<{ skus: Sku[] }>('data/fixtures/store.json');
  const db = openDb();
  try {
    const n = upsertSkus(db, store.skus);
    console.log(`Loaded ${n} SKUs.`);
    if (process.argv.includes('--tracking')) await addTracking(db);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});