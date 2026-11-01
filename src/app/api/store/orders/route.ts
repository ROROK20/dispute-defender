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

  const sku = getDb().prepare('SELECT sku, name, price_cents, description FROM skus WHERE sku = ?').get(body.sku) as
    | { sku: string; name: string; price_cents: number; description: string }
    | undefined;
  if (!sku) return fail(404, 'NOT_FOUND', `Unknown SKU ${body.sku}`);

  const value = (sku.price_cents / 100).toFixed(2);
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: sku.sku,
        description: sku.name.slice(0, 127),
        amount: {
          currency_code: 'USD',
          value,
          breakdown: { item_total: { currency_code: 'USD', value } },
        },
        items: [
          {
            name: sku.name.slice(0, 127),
            sku: sku.sku,
            description: sku.description.slice(0, 127),
            quantity: '1',
            category: 'PHYSICAL_GOODS',
            unit_amount: { currency_code: 'USD', value },
          },
        ],
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Juniper Thread Co.',
          shipping_preference: 'GET_FROM_FILE',
          user_action: 'PAY_NOW',
        },
      },
    },
  };

  try {
    const order = (await createOrder(payload)) as unknown as Record<string, unknown>;
    const id = (order?.id ?? (order?.data as Record<string, unknown> | undefined)?.id) as string | undefined;
    if (!id) return fail(502, 'PAYPAL_ERROR', 'PayPal did not return an order id');
    return NextResponse.json({ id });
  } catch (e) {
    const err = e as { message?: string; debugId?: string; debug_id?: string };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? err.debug_id);
  }
}