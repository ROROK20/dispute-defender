import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mockPaypalRequest } from '../../src/lib/paypal/mock';
import { extractOrderInfo } from '../../src/lib/paypal/orders';
import { fixtureCarrierProvider } from '../../src/lib/carrier/fixture-provider';
import { scoreEvidence, type StrengthContext } from '../../src/lib/scoring/strength';
import { computeExpectedValue, defaultCostInputs } from '../../src/lib/scoring/expected-value';
import type { PayPalOrder } from '../../src/lib/paypal/types';

/**
 * The demo's weak case (scene W): staged mock dispute PP-D-27831, an INR claim
 * whose parcel was scanned twice and never delivered. Nothing here sets the
 * answer. The facts come from the same mock PayPal responses and carrier
 * fixture the agent's tools read, and the real rubric and expected-value code
 * must decide on their own not to fight.
 */

type Json = Record<string, unknown>;
const get = async (p: string) => {
  const r = await mockPaypalRequest({ method: 'GET', path: p });
  expect(r.status, p).toBe(200);
  return r.data as Json;
};

async function weakCaseFacts() {
  const dispute = await get('/v1/customer/disputes/PP-D-27831');
  const tx = (dispute.disputed_transactions as Json[])[0];
  const captureId = String(tx.seller_transaction_id);
  const capture = await get(`/v2/payments/captures/${captureId}`);
  const orderId = String(((capture.supplementary_data as Json).related_ids as Json).order_id);
  const order = (await get(`/v2/checkout/orders/${orderId}`)) as unknown as PayPalOrder;
  const info = extractOrderInfo(order);
  const trackerRef = String(((order.purchase_units?.[0] as unknown as Json).shipping as Json & { trackers: Json[] }).trackers[0].id);
  const trackingNumber = trackerRef.slice(captureId.length + 1);
  const tracker = await get(`/v1/shipping/trackers/${trackerRef}`);
  const carrier = await fixtureCarrierProvider.lookup(trackingNumber);
  expect(carrier).not.toBeNull();

  const facts: StrengthContext = {
    dispute: { source_key: 'S1', created_at: String(dispute.create_time), sku: String((tx.items as Json[])[0].item_id) },
    order: { source_key: 'S4', sku: info.sku, captured_at: info.capturedAt, ship_to_postal_code: info.shipTo?.postal_code ?? null },
    tracker: { source_key: 'S6', tracking_number: trackingNumber, status: String(tracker.status) },
    carrier_events: carrier!.events.map((e, i) => ({
      source_key: `S${7 + i}`,
      status: e.status,
      occurred_at: e.time,
      signature_name: e.status === 'DELIVERED' ? carrier!.signature_name : null,
      delivery_zip: e.status === 'DELIVERED' ? (e.zip ?? carrier!.delivery_zip) : null,
    })),
  };
  return { dispute, facts, amountCents: Math.round(Number((dispute.dispute_amount as Json).value) * 100), sku: String((tx.items as Json[])[0].item_id) };
}

describe('weak demo case (PP-D-27831)', () => {
  it('scores low under the INR rubric: tracked and shipped, but never delivered', async () => {
    const { facts } = await weakCaseFacts();
    expect(facts.tracker?.status).toBe('SHIPPED');
    const s = scoreEvidence('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', facts);
    const present = Object.fromEntries(s.items.map((i) => [i.key, i.present]));
    expect(present).toEqual({ tracking_attached: true, carrier_delivered: false, zip_match: false, signature: false, shipped_before_claim: true });
    expect(s.score).toBe(35);
  });

  it('the expected-value code recommends refunding, not fighting, at either offer size', async () => {
    const { facts, amountCents, sku } = await weakCaseFacts();
    const s = scoreEvidence('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', facts);
    const store = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/fixtures/store.json'), 'utf8')) as { skus: { sku: string; cogs_cents: number }[] };
    const cogs = store.skus.find((x) => x.sku === sku)!.cogs_cents;
    for (const offer_fraction of [0.5, 0.3] as const) {
      const ev = computeExpectedValue({
        amount_cents: amountCents,
        ...defaultCostInputs(),
        cogs_cents: cogs,
        strength_score: s.score,
        item_returned_on_accept: false,
        offer_fraction,
      });
      expect(ev.recommended).not.toBe('FIGHT');
      const cost = Object.fromEntries(ev.options.map((o) => [o.action, o.expected_cost_cents]));
      expect(cost.FIGHT).toBeGreaterThan(cost[ev.recommended]);
    }
  });

  it('keeps its dates consistent under the fixture clock', async () => {
    const { dispute, facts } = await weakCaseFacts();
    const created = Date.parse(String(dispute.create_time));
    const due = Date.parse(String(dispute.seller_response_due_date));
    const scans = facts.carrier_events!.map((e) => Date.parse(String(e.occurred_at)));
    expect(Date.parse(String(facts.order!.captured_at))).toBeLessThan(scans[0]);
    expect(scans[scans.length - 1]).toBeLessThan(created);
    expect(created).toBeLessThan(due);
    expect(due).toBeGreaterThan(Date.now());
    // The buyer's own dates match the capture and the last scan.
    const words = (t: number) => new Date(t).toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    const message = String(((dispute.messages as Json[])[0]).content);
    expect(message).toContain(`I paid on ${words(Date.parse(String(facts.order!.captured_at)))}`);
    expect(message).toContain(`hasn't moved since ${words(scans[scans.length - 1])}`);
  });
});
