import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { captureOrder } from '@/lib/paypal/orders';
import { addTracking } from '@/lib/paypal/tracking';

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
  if (!/^[A-Z0-9]{6,40}$/i.test(orderId)) return fail(400, 'BAD_REQUEST', 'Invalid order id');

  let captured: Row;
  try {
    captured = ((await captureOrder(orderId)) ?? {}) as unknown as Row;
  } catch (e) {
    const err = e as { message?: string; debugId?: string; debug_id?: string };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? err.debug_id);
  }

  const pu = ((captured.purchase_units as Row[] | undefined) ?? [])[0] ?? {};
  const capture = ((((pu.payments as Row | undefined)?.captures as Row[] | undefined) ?? [])[0] ?? {}) as Row;
  const captureId = capture.id as string | undefined;
  const status = (captured.status as string | undefined) ?? 'COMPLETED';
  if (!captureId) return fail(502, 'PAYPAL_ERROR', 'Capture response had no capture id');

  const payer = (captured.payer ?? {}) as Row;
  const payerName = (payer.name ?? {}) as Row;
  const shipping = (pu.shipping ?? {}) as Row;
  const addr = (shipping.address ?? {}) as Row;
  const shipName = ((shipping.name ?? {}) as Row).full_name as string | undefined;
  const buyerName = shipName ?? [payerName.given_name, payerName.surname].filter(Boolean).join(' ') ?? null;
  const amount = (capture.amount ?? {}) as Row;
  const amountCents = Math.round(Number(amount.value ?? 0) * 100);
  const currency = (amount.currency_code as string | undefined) ?? 'USD';
  const sku = (pu.reference_id as string | undefined) ?? null;
  const capturedAt = (capture.create_time as string | undefined) ?? new Date().toISOString();

  const db = getDb();
  try {
    const skuExists = sku ? db.prepare('SELECT 1 FROM skus WHERE sku = ?').get(sku) : undefined;
    db.prepare(
      `INSERT INTO orders (id, capture_id, sku, buyer_name, buyer_email, ship_to_json, amount_cents, currency, status, captured_at, source, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paypal_sandbox', ?)
       ON CONFLICT(id) DO UPDATE SET capture_id = excluded.capture_id, status = excluded.status,
         captured_at = excluded.captured_at, raw_json = excluded.raw_json`,
    ).run(
      orderId,
      captureId,
      skuExists ? sku : null,
      buyerName || null,
      (payer.email_address as string | undefined) ?? null,
      JSON.stringify({
        name: shipName ?? null,
        address_line_1: addr.address_line_1 ?? null,
        admin_area_2: addr.admin_area_2 ?? null,
        admin_area_1: addr.admin_area_1 ?? null,
        postal_code: addr.postal_code ?? null,
        country_code: addr.country_code ?? null,
      }),
      amountCents,
      currency,
      status,
      capturedAt,
      JSON.stringify(captured),
    );
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
      await addTracking({ transaction_id: captureId, tracking_number: fixture.trackingNumber, status: 'SHIPPED', carrier: fixture.carrier });
      db.prepare("UPDATE orders SET tracking_number = ?, carrier = ?, tracker_status = 'SHIPPED' WHERE id = ?").run(
        fixture.trackingNumber,
        fixture.carrier,
        orderId,
      );
      tracking = { attached: true, tracking_number: fixture.trackingNumber, carrier: fixture.carrier };
    } catch (e) {
      const err = e as { message?: string; debugId?: string; debug_id?: string };
      console.error('[capture] trackers-batch failed', err.message);
      tracking = { attached: false, error: err.message ?? String(e), debug_id: err.debugId ?? err.debug_id ?? null };
    }
  }

  return NextResponse.json({ order_id: orderId, capture_id: captureId, status, tracking });
}