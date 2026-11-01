import { getDb } from '../db';

export type OrderSource = 'paypal_sandbox' | 'fixture';

export interface ShipTo {
  name?: string;
  address_line_1?: string;
  admin_area_2?: string;
  admin_area_1?: string;
  postal_code?: string;
  country_code?: string;
}

export interface OrderRow {
  id: string;
  capture_id: string | null;
  sku: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  ship_to_json: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  tracker_status: string | null;
  captured_at: string | null;
  source: OrderSource;
  raw_json: string | null;
}

export interface Order extends OrderRow {
  ship_to: ShipTo | null;
}

export interface OrderInput {
  id: string;
  capture_id?: string | null;
  sku?: string | null;
  buyer_name?: string | null;
  buyer_email?: string | null;
  ship_to?: ShipTo | null;
  amount_cents: number;
  currency?: string;
  status: string;
  tracking_number?: string | null;
  carrier?: string | null;
  tracker_status?: string | null;
  captured_at?: string | null;
  source: OrderSource;
  raw?: unknown;
}

function parseShipTo(text: string | null): ShipTo | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as ShipTo) : null;
  } catch {
    return null;
  }
}

function hydrate(row: OrderRow | undefined): Order | null {
  if (!row) return null;
  return { ...row, ship_to: parseShipTo(row.ship_to_json) };
}

export function upsertOrder(input: OrderInput): Order {
  if (!input.id) throw new Error('Order id is required');
  if (!Number.isInteger(input.amount_cents)) throw new Error(`Order ${input.id}: amount_cents must be an integer`);
  const db = getDb();
  db.prepare(
    `INSERT INTO orders (id, capture_id, sku, buyer_name, buyer_email, ship_to_json, amount_cents, currency,
                         status, tracking_number, carrier, tracker_status, captured_at, source, raw_json)
     VALUES (@id, @capture_id, @sku, @buyer_name, @buyer_email, @ship_to_json, @amount_cents, @currency,
             @status, @tracking_number, @carrier, @tracker_status, @captured_at, @source, @raw_json)
     ON CONFLICT(id) DO UPDATE SET
       capture_id      = COALESCE(excluded.capture_id, orders.capture_id),
       sku             = COALESCE(excluded.sku, orders.sku),
       buyer_name      = COALESCE(excluded.buyer_name, orders.buyer_name),
       buyer_email     = COALESCE(excluded.buyer_email, orders.buyer_email),
       ship_to_json    = COALESCE(excluded.ship_to_json, orders.ship_to_json),
       amount_cents    = excluded.amount_cents,
       currency        = excluded.currency,
       status          = excluded.status,
       tracking_number = COALESCE(excluded.tracking_number, orders.tracking_number),
       carrier         = COALESCE(excluded.carrier, orders.carrier),
       tracker_status  = COALESCE(excluded.tracker_status, orders.tracker_status),
       captured_at     = COALESCE(excluded.captured_at, orders.captured_at),
       raw_json        = COALESCE(excluded.raw_json, orders.raw_json)`,
  ).run({
    id: input.id,
    capture_id: input.capture_id ?? null,
    sku: input.sku ?? null,
    buyer_name: input.buyer_name ?? null,
    buyer_email: input.buyer_email ?? null,
    ship_to_json: input.ship_to ? JSON.stringify(input.ship_to) : null,
    amount_cents: input.amount_cents,
    currency: input.currency ?? 'USD',
    status: input.status,
    tracking_number: input.tracking_number ?? null,
    carrier: input.carrier ?? null,
    tracker_status: input.tracker_status ?? null,
    captured_at: input.captured_at ?? null,
    source: input.source,
    raw_json: input.raw === undefined ? null : JSON.stringify(input.raw),
  });
  const order = getOrder(input.id);
  if (!order) throw new Error(`Order ${input.id} was not stored`);
  return order;
}

export function getOrder(id: string): Order | null {
  return hydrate(getDb().prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined);
}

export function getOrderByCaptureId(captureId: string): Order | null {
  return hydrate(
    getDb().prepare(`SELECT * FROM orders WHERE capture_id = ?`).get(captureId) as OrderRow | undefined,
  );
}

export function listOrders(opts: { source?: OrderSource; limit?: number } = {}): Order[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const rows = (
    opts.source
      ? getDb()
          .prepare(`SELECT * FROM orders WHERE source = ? ORDER BY captured_at DESC LIMIT ?`)
          .all(opts.source, limit)
      : getDb().prepare(`SELECT * FROM orders ORDER BY captured_at DESC LIMIT ?`).all(limit)
  ) as OrderRow[];
  return rows.map((r) => hydrate(r)!);
}

/** Captured real sandbox orders that have no tracking attached yet (used by `seed-store --tracking`). */
export function listOrdersNeedingTracking(): Order[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM orders
       WHERE source = 'paypal_sandbox' AND status = 'COMPLETED'
         AND capture_id IS NOT NULL AND tracking_number IS NULL
       ORDER BY captured_at ASC`,
    )
    .all() as OrderRow[];
  return rows.map((r) => hydrate(r)!);
}

export function setOrderTracking(
  id: string,
  tracking: { tracking_number: string; carrier: string; tracker_status: string },
): Order {
  const res = getDb()
    .prepare(
      `UPDATE orders SET tracking_number = @tracking_number, carrier = @carrier, tracker_status = @tracker_status
       WHERE id = @id`,
    )
    .run({ id, ...tracking });
  if (res.changes === 0) throw new Error(`Order ${id} not found`);
  return getOrder(id)!;
}

export function setTrackerStatus(id: string, trackerStatus: string): void {
  getDb().prepare(`UPDATE orders SET tracker_status = ? WHERE id = ?`).run(trackerStatus, id);
}

/** Orders by the same buyer email, excluding one order, that never had a dispute. */
export function countPriorUndisputedOrders(buyerEmail: string, excludeOrderId: string, beforeIso?: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o
       WHERE o.buyer_email = @email AND o.id != @exclude
         AND (@before IS NULL OR o.captured_at < @before)
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id)`,
    )
    .get({ email: buyerEmail, exclude: excludeOrderId, before: beforeIso ?? null }) as { n: number };
  return row.n;
}