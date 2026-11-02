import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { addTracking, captureOrder, extractOrderInfo } from '@/lib/paypal/orders';
import { setOrderTracking, upsertOrder } from '@/lib/repo/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

function fail(status: number, code: string, message: string, debug_id?: string) {
  return NextResponse.json({ error: { code, message, ...(debug_id ? { debug_id } : {}) } }, { status });
}

function pickFixtureTracking(db: ReturnType<typeof getDb>): { trackingNumber: string; carrier: string } | null {
  try {
    const file = path.join(process.cwd(), 'data', 'fixtures', 'carrier-events.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Row;
    const map = (parsed.events && typeof parsed.events === 'object' ? parsed.events : parsed) as Row;
    const keys = Object.keys(map).filter((k) => /^[A-Z0-9]{10,}$/i.test(k));
    if (keys.length === 0) return null;
    const used = new Set(
      (db.prepare('SELECT tracking_number FROM orders WHERE tracking_number IS NOT NULL').all() as Row[]).map((r) => r.tracking_number as string),
    );
    const key = keys.find((k) => !used.has(k)) ?? keys[used.size % keys.length];
    const entry = (map[key] ?? {}) as Row;
    const carrier = typeof entry.carrier === 'string' ? entry.carrier : 'USPS';
    return { trackingNumber: key, carrier };
  } catch (e) {
    console.error('[capture] could not read carrier fixture', e);
    return null;
  }
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  // PayPal order ids are alphanumeric; the PAYPAL_MOCK adapter's ids also contain '-' and '_'.
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) return fail(400, 'BAD_REQUEST', 'Invalid order id');

  let info: ReturnType<typeof extractOrderInfo>;
  let rawOrder: unknown;
  try {
    const res = await captureOrder(orderId);
    rawOrder = res.data;
    info = extractOrderInfo(res.data);
  } catch (e) {
    const err = e as { message?: string; debugId?: string | null };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? undefined);
  }

  const captureId = info.captureId;
  const status = info.status || 'COMPLETED';
  if (!captureId) return fail(502, 'PAYPAL_ERROR', 'Capture response had no capture id');

  const db = getDb();
  try {
    // orders.sku is a foreign key; keep it null for a SKU the catalog does not know.
    const skuExists = info.sku ? db.prepare('SELECT 1 FROM skus WHERE sku = ?').get(info.sku) : undefined;
    upsertOrder({
      id: orderId,
      capture_id: captureId,
      sku: skuExists ? info.sku : null,
      buyer_name: info.buyerName,
      buyer_email: info.buyerEmail,
      ship_to: info.shipTo
        ? {
            name: info.shipTo.name,
            address_line_1: info.shipTo.address_line_1,
            admin_area_2: info.shipTo.admin_area_2,
            admin_area_1: info.shipTo.admin_area_1,
            postal_code: info.shipTo.postal_code,
            country_code: info.shipTo.country_code,
          }
        : null,
      amount_cents: info.amountCents,
      currency: info.currency,
      status,
      captured_at: info.capturedAt ?? new Date().toISOString(),
      source: 'paypal_sandbox',
      raw: rawOrder,
    });
  } catch (e) {
    console.error('[capture] storing order failed', e);
    return NextResponse.json(
      { order_id: orderId, capture_id: captureId, status, warning: 'Payment captured in PayPal but could not be stored locally.' },
      { status: 200 },
    );
  }

  let tracking: Row = { attached: false };
  const fixture = pickFixtureTracking(db);
  if (fixture) {
    try {
      // POST /v1/shipping/trackers-batch through the logged client, so the call and its debug_id show on the Activity page.
      await addTracking({ captureId, trackingNumber: fixture.trackingNumber, carrier: fixture.carrier, status: 'SHIPPED' });
      setOrderTracking(orderId, { tracking_number: fixture.trackingNumber, carrier: fixture.carrier, tracker_status: 'SHIPPED' });
      tracking = { attached: true, tracking_number: fixture.trackingNumber, carrier: fixture.carrier };
    } catch (e) {
      const err = e as { message?: string; debugId?: string | null };
      console.error('[capture] trackers-batch failed', err.message);
      tracking = { attached: false, error: err.message ?? String(e), debug_id: err.debugId ?? null };
    }
  }

  return NextResponse.json({ order_id: orderId, capture_id: captureId, status, tracking });
}
