import { nanoid } from 'nanoid';
import { centsToValue, paypalRequest, type PaypalResponse } from './client';

/** Typed wrappers for Orders v2, Payments v2 captures and the Add Tracking API. */

export interface Money {
  currency_code: string;
  value: string;
}

export interface ShippingAddress {
  address_line_1?: string;
  address_line_2?: string;
  admin_area_2?: string;
  admin_area_1?: string;
  postal_code?: string;
  country_code?: string;
}

export interface PaypalCapture {
  id: string;
  status: string;
  amount?: Money;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  [key: string]: unknown;
}

export interface PaypalOrder {
  id: string;
  status: string;
  intent?: string;
  create_time?: string;
  update_time?: string;
  payer?: {
    name?: { given_name?: string; surname?: string };
    email_address?: string;
    payer_id?: string;
  };
  purchase_units?: {
    reference_id?: string;
    description?: string;
    amount?: Money;
    items?: { name: string; sku?: string; quantity: string; unit_amount?: Money; description?: string }[];
    shipping?: { name?: { full_name?: string }; address?: ShippingAddress };
    payments?: { captures?: PaypalCapture[] };
  }[];
  [key: string]: unknown;
}

export interface CreateOrderArgs {
  sku: string;
  name: string;
  priceCents: number;
  currency?: string;
  description?: string;
}

/** POST /v2/checkout/orders with intent CAPTURE, one item, shipping from the buyer's PayPal file. */
export async function createOrder(args: CreateOrderArgs): Promise<PaypalOrder> {
  if (!args.sku) throw new Error('sku is required');
  if (!Number.isInteger(args.priceCents) || args.priceCents <= 0) throw new Error('priceCents must be a positive integer');
  const currency = args.currency ?? 'USD';
  const value = centsToValue(args.priceCents);
  const res = await paypalRequest<PaypalOrder>('POST', '/v2/checkout/orders', {
    requestId: `dd-order-${nanoid(16)}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: args.sku,
          description: (args.description ?? args.name).slice(0, 127),
          custom_id: args.sku,
          amount: {
            currency_code: currency,
            value,
            breakdown: { item_total: { currency_code: currency, value } },
          },
          items: [
            {
              name: args.name.slice(0, 127),
              sku: args.sku,
              quantity: '1',
              category: 'PHYSICAL_GOODS',
              unit_amount: { currency_code: currency, value },
            },
          ],
        },
      ],
      application_context: {
        brand_name: 'Juniper Thread Co.',
        shipping_preference: 'GET_FROM_FILE',
        user_action: 'PAY_NOW',
      },
    },
  });
  return res.data;
}

/** POST /v2/checkout/orders/{id}/capture. */
export async function captureOrder(orderId: string): Promise<PaypalResponse<PaypalOrder>> {
  if (!orderId) throw new Error('orderId is required');
  return paypalRequest<PaypalOrder>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    body: {},
    requestId: `dd-capture-${orderId}`,
  });
}

/** GET /v2/checkout/orders/{id}. */
export async function getOrder(orderId: string, ctx: { disputeId?: string | null; runId?: string | null } = {}): Promise<PaypalOrder> {
  const res = await paypalRequest<PaypalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    disputeId: ctx.disputeId ?? null,
    runId: ctx.runId ?? null,
  });
  return res.data;
}

/** GET /v2/payments/captures/{id}. */
export async function getCapture(captureId: string, ctx: { disputeId?: string | null; runId?: string | null } = {}): Promise<PaypalCapture> {
  const res = await paypalRequest<PaypalCapture>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, {
    disputeId: ctx.disputeId ?? null,
    runId: ctx.runId ?? null,
  });
  return res.data;
}

/** capture → supplementary_data.related_ids.order_id */
export function orderIdFromCapture(capture: PaypalCapture): string | null {
  return capture.supplementary_data?.related_ids?.order_id ?? null;
}

export interface CapturedOrderInfo {
  orderId: string;
  captureId: string | null;
  status: string;
  sku: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  shipTo: (ShippingAddress & { name?: string }) | null;
  amountCents: number;
  currency: string;
  capturedAt: string | null;
}

/** Flattens a captured order into the fields the orders table stores. */
export function extractOrderInfo(order: PaypalOrder): CapturedOrderInfo {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const amount = capture?.amount ?? unit?.amount;
  const value = amount?.value ? Number.parseFloat(amount.value) : 0;
  const given = order.payer?.name?.given_name ?? '';
  const surname = order.payer?.name?.surname ?? '';
  const buyerName = `${given} ${surname}`.trim() || unit?.shipping?.name?.full_name || null;
  const address = unit?.shipping?.address;
  return {
    orderId: order.id,
    captureId: capture?.id ?? null,
    status: order.status,
    sku: unit?.reference_id ?? unit?.items?.[0]?.sku ?? null,
    buyerName,
    buyerEmail: order.payer?.email_address ?? null,
    shipTo: address ? { name: unit?.shipping?.name?.full_name, ...address } : null,
    amountCents: Number.isFinite(value) ? Math.round(value * 100) : 0,
    currency: amount?.currency_code ?? 'USD',
    capturedAt: capture?.create_time ?? order.update_time ?? null,
  };
}

export interface AddTrackingArgs {
  captureId: string;
  trackingNumber: string;
  carrier: string;
  status?: 'SHIPPED' | 'ON_HOLD' | 'DELIVERED' | 'CANCELLED';
  disputeId?: string | null;
}

export interface TrackersBatchResult {
  tracker_identifiers?: { transaction_id: string; tracking_number: string }[];
  errors?: { name?: string; message?: string; details?: unknown[] }[];
}

/** POST /v1/shipping/trackers-batch for one transaction. Throws if PayPal reports a per-tracker error. */
export async function addTracking(args: AddTrackingArgs): Promise<PaypalResponse<TrackersBatchResult>> {
  if (!args.captureId || !args.trackingNumber) throw new Error('captureId and trackingNumber are required');
  const res = await paypalRequest<TrackersBatchResult>('POST', '/v1/shipping/trackers-batch', {
    body: {
      trackers: [
        {
          transaction_id: args.captureId,
          tracking_number: args.trackingNumber,
          status: args.status ?? 'SHIPPED',
          carrier: args.carrier,
        },
      ],
    },
    disputeId: args.disputeId ?? null,
  });
  const errors = res.data.errors ?? [];
  if (errors.length > 0) {
    const e = errors[0];
    throw new Error(`trackers-batch rejected tracking ${args.trackingNumber}: ${e.name ?? 'ERROR'} ${e.message ?? ''}`.trim());
  }
  return res;
}

export interface PaypalTracker {
  transaction_id?: string;
  tracking_number?: string;
  status?: string;
  carrier?: string;
  carrier_name_other?: string;
  shipment_date?: string;
  last_updated_time?: string;
  [key: string]: unknown;
}

/** GET /v1/shipping/trackers/{transaction_id}-{tracking_number}. Returns null on 404. */
export async function getTracker(
  captureId: string,
  trackingNumber: string,
  ctx: { disputeId?: string | null; runId?: string | null } = {},
): Promise<PaypalTracker | null> {
  try {
    const res = await paypalRequest<PaypalTracker>(
      'GET',
      `/v1/shipping/trackers/${encodeURIComponent(`${captureId}-${trackingNumber}`)}`,
      { disputeId: ctx.disputeId ?? null, runId: ctx.runId ?? null },
    );
    return res.data;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}