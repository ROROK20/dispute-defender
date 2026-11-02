import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { createOrder } from '@/lib/paypal/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ sku: z.string().regex(/^[A-Z]{2}-\d{3}$/) });

function fail(status: number, code: string, message: string, debug_id?: string) {
  return NextResponse.json({ error: { code, message, ...(debug_id ? { debug_id } : {}) } }, { status });
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be {sku: "JT-1xx"}');
  }

  const sku = getDb().prepare('SELECT sku, name, price_cents FROM skus WHERE sku = ?').get(body.sku) as
    | { sku: string; name: string; price_cents: number }
    | undefined;
  if (!sku) return fail(404, 'NOT_FOUND', `Unknown SKU ${body.sku}`);

  try {
    // POST /v2/checkout/orders: intent CAPTURE, reference_id = sku, one item, shipping GET_FROM_FILE (paypal/orders.ts).
    const order = await createOrder({ sku: sku.sku, name: sku.name, priceCents: sku.price_cents });
    if (!order.id) return fail(502, 'PAYPAL_ERROR', 'PayPal did not return an order id');
    return NextResponse.json({ id: order.id });
  } catch (e) {
    const err = e as { message?: string; debugId?: string | null };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? undefined);
  }
}