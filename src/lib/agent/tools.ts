import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { paypalAvailable } from '../env';
import { getCarrierTracking } from '../carrier/adapter';
import { getDispute as fetchPaypalDispute, type PaypalDispute } from '../paypal/disputes';
import { getCapture, getOrder, getTracker, orderIdFromCapture, type PaypalOrder } from '../paypal/orders';
import type { Dispute } from '../repo/disputes';
import { countPriorOnSku } from '../repo/disputes';
import { countPriorUndisputedOrders, getOrderByCaptureId } from '../repo/orders';
import { getSku } from '../repo/skus';
import { insertSources, type Source, type SourceInput } from '../repo/sources';
import { computeExpectedValue, defaultCostInputs, formatMoney, type EvResult } from '../scoring/expected-value';
import { reasonGroup, scoreEvidence, type StrengthContext, type StrengthResult } from '../scoring/strength';

/**
 * The agent's read-only tools (ARCHITECTURE §6.6). Each data tool stores what
 * it read as numbered sources (S1, S2, ...) and returns them to the model; the
 * letter may only cite those keys. Every fact also lands in `facts`, the input
 * to the deterministic strength rubric. No tool here can change anything at
 * PayPal: the mutating calls live in submit.ts behind seller approval.
 */

export interface ResolvedOrder {
  orderId: string | null;
  captureId: string;
  sku: string | null;
  itemName: string | null;
  buyerEmail: string | null;
  capturedAt: string | null;
  shipToZip: string | null;
  trackingNumbers: string[];
}

export interface AgentContext {
  runId: string;
  dispute: Dispute;
  facts: StrengthContext;
  paypalDispute: PaypalDispute | null;
  order: ResolvedOrder | null;
  skuCogsCents: number | null;
  strength: StrengthResult | null;
  ev: EvResult | null;
  /** Tool name → number of calls, for the trace and the mock agent. */
  calls: Record<string, number>;
  cache: Map<string, ToolOutcome>;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result. */
  content: string;
  isError: boolean;
  /** Sources this call stored (empty on a cached repeat). */
  sources: Source[];
  /** One line for the trace. */
  summary: string;
  /** Extra data for the trace payload. */
  data?: unknown;
}

export function createAgentContext(runId: string, dispute: Dispute): AgentContext {
  return {
    runId,
    dispute,
    facts: {},
    paypalDispute: null,
    order: null,
    skuCogsCents: null,
    strength: null,
    ev: null,
    calls: {},
    cache: new Map(),
  };
}

// ── Tool definitions shown to Claude ─────────────────────────────────

const NO_INPUT = { type: 'object' as const, properties: {} };

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_dispute',
    description:
      'Read the PayPal dispute: reason code, disputed amount, status, stage, dates, and the disputed transaction (buyer, items, capture id). Stores each part as a citable source.',
    input_schema: { type: 'object', properties: { dispute_id: { type: 'string' } }, required: ['dispute_id'] },
  },
  {
    name: 'get_messages',
    description: 'Read the buyer and seller messages on the dispute. Each message becomes its own citable source with who posted it and when.',
    input_schema: { type: 'object', properties: { dispute_id: { type: 'string' } }, required: ['dispute_id'] },
  },
  {
    name: 'get_transaction',
    description:
      'Read the PayPal capture and its order: line item and SKU, amount, capture time, buyer name, and the PayPal ship-to address. Also counts earlier undisputed orders from the same buyer in the store records.',
    input_schema: { type: 'object', properties: { capture_id: { type: 'string' } }, required: ['capture_id'] },
  },
  {
    name: 'get_tracking',
    description:
      'Read the PayPal tracker attached to the capture, plus each carrier scan for that tracking number (accepted, in transit, delivered, signature, delivery ZIP). Each scan is its own source.',
    input_schema: { type: 'object', properties: { capture_id: { type: 'string' } }, required: ['capture_id'] },
  },
  {
    name: 'get_policy',
    description: "Read one of the store's published policies. Each numbered clause becomes a source that includes the policy's publication date.",
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string', enum: ['returns', 'shipping', 'size-guide'] } },
      required: ['slug'],
    },
  },
  {
    name: 'get_sku',
    description:
      'Read the listing for a SKU: name, category, the exact listing description, size-chart version and price. For not-as-described disputes it also counts earlier disputes with the same reason on this SKU in the last 90 days.',
    input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  },
  {
    name: 'score_evidence',
    description:
      'Score the evidence collected so far with the deterministic rubric for this reason code. Returns 0-100 and each rubric item with the sources that satisfy it. Call it after gathering evidence.',
    input_schema: NO_INPUT,
  },
  {
    name: 'compute_expected_value',
    description:
      'Compute the expected cost of fighting, accepting the claim, or offering a partial refund, from the strength score and the seller\'s fee settings. Returns each formula with values filled in and the cheapest option. Optionally propose the offer fraction (0.3 or 0.5).',
    input_schema: {
      type: 'object',
      properties: { offer_fraction: { type: 'number', enum: [0.3, 0.5] } },
    },
  },
];

export const DATA_TOOL_NAMES = new Set(['get_dispute', 'get_messages', 'get_transaction', 'get_tracking', 'get_policy', 'get_sku']);

// ── Helpers ──────────────────────────────────────────────────────────

class ToolInputError extends Error {}

function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`"${key}" is required.`);
  return v.trim();
}

function moneyText(cents: number, currency: string): string {
  return `${formatMoney(cents, currency)} ${currency}`;
}

function centsOf(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function oneLine(text: string, max = 1500): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function render(sources: Source[], note?: string): string {
  const parts = sources.map((s) => `[${s.source_key}] ${s.title}\n${s.content}`);
  if (note) parts.push(note);
  return parts.length ? parts.join('\n\n') : 'Nothing found.';
}

function store(ctx: AgentContext, inputs: SourceInput[]): Source[] {
  return inputs.length ? insertSources(ctx.runId, inputs) : [];
}

function keysOf(sources: Source[]): string {
  if (sources.length === 0) return 'no sources';
  if (sources.length === 1) return sources[0].source_key;
  return `${sources[0].source_key}–${sources[sources.length - 1].source_key}`;
}

function ok(sources: Source[], summary: string, note?: string, data?: unknown): ToolOutcome {
  return { content: render(sources, note), isError: false, sources, summary, data };
}

function captureIdOfDispute(d: PaypalDispute | null): string | null {
  return d?.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id ?? null;
}

function rawDispute(ctx: AgentContext): PaypalDispute {
  return (ctx.dispute.raw ?? JSON.parse(ctx.dispute.raw_json)) as PaypalDispute;
}

/** Live from PayPal for sandbox disputes when PayPal is reachable; the stored copy otherwise. */
async function loadDispute(ctx: AgentContext): Promise<{ dispute: PaypalDispute; ref: string; live: boolean }> {
  if (ctx.paypalDispute) return { dispute: ctx.paypalDispute, ref: `GET /v1/customer/disputes/${ctx.dispute.id}`, live: true };
  if (ctx.dispute.source === 'paypal_sandbox' && paypalAvailable()) {
    ctx.paypalDispute = await fetchPaypalDispute(ctx.dispute.id, { runId: ctx.runId });
    return { dispute: ctx.paypalDispute, ref: `GET /v1/customer/disputes/${ctx.dispute.id}`, live: true };
  }
  return { dispute: rawDispute(ctx), ref: `local:disputes/${ctx.dispute.id}`, live: false };
}

function expectedCaptureId(ctx: AgentContext): string | null {
  return ctx.dispute.capture_id ?? captureIdOfDispute(ctx.paypalDispute) ?? captureIdOfDispute(rawDispute(ctx));
}

function checkCapture(ctx: AgentContext, captureId: string): void {
  const expected = expectedCaptureId(ctx);
  if (expected && captureId !== expected) {
    throw new ToolInputError(`This run covers capture ${expected} (the disputed transaction); ${captureId} is not part of it.`);
  }
}

// ── Data tools ───────────────────────────────────────────────────────

async function getDisputeTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const id = str(input, 'dispute_id');
  if (id !== ctx.dispute.id) throw new ToolInputError(`This run covers dispute ${ctx.dispute.id}, not ${id}.`);
  const { dispute: d, ref } = await loadDispute(ctx);

  const amount = centsOf(d.dispute_amount?.value) ?? ctx.dispute.amount_cents;
  const currency = d.dispute_amount?.currency_code ?? ctx.dispute.currency;
  const lines = [
    `Dispute ${d.dispute_id}.`,
    `Reason: ${d.reason}.`,
    `Disputed amount: ${moneyText(amount, currency)}.`,
    `Status: ${d.status}.`,
    d.dispute_life_cycle_stage ? `Stage: ${d.dispute_life_cycle_stage}.` : null,
    d.create_time ? `Opened: ${d.create_time}.` : null,
    d.seller_response_due_date ? `Seller response due: ${d.seller_response_due_date}.` : null,
  ].filter(Boolean);
  const inputs: SourceInput[] = [
    { kind: 'dispute_field', title: `Dispute ${d.dispute_id}: ${d.reason}, ${formatMoney(amount, currency)}`, content: lines.join(' '), ref },
  ];

  const t = d.disputed_transactions?.[0];
  if (t) {
    const items = (t.items ?? [])
      .map((i) => `${i.item_name ?? 'item'}${i.item_id ? ` (item ${i.item_id})` : ''}${i.item_quantity ? ` × ${i.item_quantity}` : ''}`)
      .join('; ');
    const claims = (t.items ?? [])
      .map((i) => [i.reason ? `item reason ${i.reason}` : null, i.notes ? `buyer notes: ${i.notes}` : null].filter(Boolean).join(', '))
      .filter(Boolean)
      .join('; ');
    const gross = centsOf(t.gross_amount?.value);
    const txLines = [
      `Disputed transaction: seller transaction (capture) ${t.seller_transaction_id ?? 'unknown'}`,
      t.buyer_transaction_id ? `, buyer transaction ${t.buyer_transaction_id}` : '',
      t.create_time ? `, paid ${t.create_time}` : '',
      gross != null ? `, gross ${moneyText(gross, t.gross_amount?.currency_code ?? currency)}` : '',
      t.invoice_number ? `, invoice ${t.invoice_number}` : '',
      '.',
      t.buyer?.name ? ` Buyer: ${t.buyer.name}.` : '',
      items ? ` Items: ${items}.` : '',
      claims ? ` Buyer-claimed details: ${claims}.` : '',
    ].join('');
    inputs.push({ kind: 'dispute_field', title: `Disputed transaction ${t.seller_transaction_id ?? ''}`.trim(), content: txLines, ref });
  }

  const sources = store(ctx, inputs);
  ctx.facts.dispute = {
    source_key: sources[0].source_key,
    created_at: d.create_time ?? ctx.dispute.pp_created_at,
    sku: t?.items?.[0]?.item_id ?? ctx.dispute.sku,
  };
  return ok(sources, `Read dispute ${d.dispute_id} → ${keysOf(sources)}`);
}

async function getMessagesTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const id = str(input, 'dispute_id');
  if (id !== ctx.dispute.id) throw new ToolInputError(`This run covers dispute ${ctx.dispute.id}, not ${id}.`);
  const { dispute: d, ref } = await loadDispute(ctx);
  const messages = (d.messages ?? []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
  if (messages.length === 0) return ok([], 'No messages on this dispute', 'There are no buyer or seller messages on this dispute.');

  const inputs: SourceInput[] = messages.map((m, i) => {
    const who = String(m.posted_by || 'UNKNOWN').toUpperCase();
    const seller = who === 'SELLER';
    return {
      kind: seller ? 'seller_message' : 'buyer_message',
      title: `${seller ? 'Seller' : who === 'BUYER' ? 'Buyer' : who} message ${m.time_posted?.slice(0, 10) ?? ''}`.trim(),
      content: `Posted by ${who} at ${m.time_posted ?? 'unknown time'}: ${oneLine(m.content, 3000)}`,
      ref: `${ref}#messages[${i}]`,
    };
  });
  const sources = store(ctx, inputs);
  ctx.facts.messages = messages.map((m, i) => ({
    source_key: sources[i].source_key,
    posted_by: String(m.posted_by || ''),
    time_posted: m.time_posted ?? null,
    text: m.content,
  }));
  return ok(sources, `Read ${sources.length} message(s) → ${keysOf(sources)}`);
}

function trackersFromOrder(order: PaypalOrder, captureId: string): string[] {
  const unit = order.purchase_units?.[0] as { shipping?: { trackers?: { id?: string }[] } } | undefined;
  return (unit?.shipping?.trackers ?? [])
    .map((t) => t.id ?? '')
    .filter((id) => id.startsWith(`${captureId}-`))
    .map((id) => id.slice(captureId.length + 1))
    .filter(Boolean);
}

async function getTransactionTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const captureId = str(input, 'capture_id');
  checkCapture(ctx, captureId);
  const local = getOrderByCaptureId(captureId);
  const inputs: SourceInput[] = [];
  const resolved: ResolvedOrder = {
    orderId: local?.id ?? null,
    captureId,
    sku: local?.sku ?? null,
    itemName: null,
    buyerEmail: local?.buyer_email ?? null,
    capturedAt: local?.captured_at ?? null,
    shipToZip: local?.ship_to?.postal_code ?? null,
    trackingNumbers: local?.tracking_number ? [local.tracking_number] : [],
  };
  let orderSourceIndex = -1;
  let note: string | undefined;

  const live = ctx.dispute.source === 'paypal_sandbox' && paypalAvailable();
  if (live) {
    const capture = await getCapture(captureId, { disputeId: ctx.dispute.id, runId: ctx.runId });
    const cents = centsOf(capture.amount?.value);
    const protection = capture.seller_protection as { status?: string; dispute_categories?: string[] } | undefined;
    inputs.push({
      kind: 'capture_field',
      title: `Capture ${capture.id} ${capture.status}`,
      content: [
        `Capture ${capture.id} status ${capture.status}`,
        cents != null ? `, amount ${moneyText(cents, capture.amount?.currency_code ?? 'USD')}` : '',
        capture.create_time ? `, captured ${capture.create_time}` : '',
        '.',
        protection?.status
          ? ` Seller protection: ${protection.status}${protection.dispute_categories?.length ? ` (${protection.dispute_categories.join(', ')})` : ''}.`
          : '',
      ].join(''),
      ref: `GET /v2/payments/captures/${captureId}`,
    });
    resolved.capturedAt = capture.create_time ?? resolved.capturedAt;

    const orderId = orderIdFromCapture(capture) ?? resolved.orderId;
    if (orderId) {
      const order = await getOrder(orderId, { disputeId: ctx.dispute.id, runId: ctx.runId });
      const unit = order.purchase_units?.[0];
      const item = unit?.items?.[0];
      const addr = unit?.shipping?.address;
      const shipName = unit?.shipping?.name?.full_name;
      const buyer = [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ');
      const unitCents = centsOf(item?.unit_amount?.value ?? unit?.amount?.value);
      const currency = item?.unit_amount?.currency_code ?? unit?.amount?.currency_code ?? 'USD';
      const sku = item?.sku ?? unit?.reference_id ?? null;
      const shipTo = addr
        ? [shipName, addr.address_line_1, addr.address_line_2, addr.admin_area_2, [addr.admin_area_1, addr.postal_code].filter(Boolean).join(' '), addr.country_code]
            .filter(Boolean)
            .join(', ')
        : null;
      orderSourceIndex = inputs.length;
      inputs.push({
        kind: 'order_field',
        title: `Order ${order.id}: ${item?.name ?? 'line item'}${sku ? ` (${sku})` : ''}`,
        content: [
          `Order ${order.id} status ${order.status}: ${item?.quantity ?? '1'} × ${item?.name ?? 'item'}`,
          sku ? ` (SKU ${sku})` : '',
          unitCents != null ? ` at ${moneyText(unitCents, currency)}` : '',
          '.',
          buyer ? ` Buyer: ${buyer}.` : '',
          shipTo ? ` PayPal ship-to address: ${shipTo}.` : '',
          resolved.capturedAt ? ` Paid and captured ${resolved.capturedAt}.` : '',
        ].join(''),
        ref: `GET /v2/checkout/orders/${order.id}`,
      });
      resolved.orderId = order.id;
      resolved.sku = sku ?? resolved.sku;
      resolved.itemName = item?.name ?? null;
      resolved.buyerEmail = order.payer?.email_address ?? resolved.buyerEmail;
      resolved.shipToZip = addr?.postal_code ?? resolved.shipToZip;
      for (const tn of trackersFromOrder(order, captureId)) {
        if (!resolved.trackingNumbers.includes(tn)) resolved.trackingNumbers.push(tn);
      }
    } else {
      note = 'PayPal did not link this capture to an order.';
    }
  } else if (local) {
    const s = local.ship_to;
    const shipTo = s
      ? [s.name, s.address_line_1, s.admin_area_2, [s.admin_area_1, s.postal_code].filter(Boolean).join(' '), s.country_code].filter(Boolean).join(', ')
      : null;
    orderSourceIndex = inputs.length;
    inputs.push({
      kind: 'order_field',
      title: `Store order ${local.id}${local.sku ? ` (${local.sku})` : ''}`,
      content: [
        `Store order ${local.id} status ${local.status}`,
        local.sku ? `, SKU ${local.sku}` : '',
        `, amount ${moneyText(local.amount_cents, local.currency)}`,
        '.',
        local.buyer_name ? ` Buyer: ${local.buyer_name}.` : '',
        shipTo ? ` Ship-to address: ${shipTo}.` : '',
        local.captured_at ? ` Captured ${local.captured_at}.` : '',
      ].join(''),
      ref: `local:orders/${local.id}`,
    });
    note = 'PayPal is not reachable for this dispute, so this comes from the store\'s own order record.';
  } else {
    throw new ToolInputError(`No order is on record for capture ${captureId}, and PayPal is not reachable for this dispute.`);
  }

  let priorIndex = -1;
  if (resolved.buyerEmail && resolved.orderId) {
    const n = countPriorUndisputedOrders(resolved.buyerEmail, resolved.orderId, resolved.capturedAt ?? undefined);
    priorIndex = inputs.length;
    inputs.push({
      kind: 'order_field',
      title: 'Store order history for this buyer',
      content: `Store records: ${n} earlier order(s) from the same PayPal buyer account with no dispute.`,
      ref: 'local:orders?buyer_email=<redacted>',
    });
    ctx.facts.prior_undisputed_orders = { count: n, source_ids: [] };
  }

  const sources = store(ctx, inputs);
  const orderSource = orderSourceIndex >= 0 ? sources[orderSourceIndex] : sources[0];
  ctx.order = resolved;
  ctx.facts.order = {
    source_key: orderSource.source_key,
    sku: resolved.sku,
    captured_at: resolved.capturedAt,
    ship_to_postal_code: resolved.shipToZip,
  };
  if (priorIndex >= 0 && ctx.facts.prior_undisputed_orders) {
    ctx.facts.prior_undisputed_orders.source_ids = [sources[priorIndex].source_key];
  }
  return ok(sources, `Read capture ${captureId}${resolved.orderId ? ` and order ${resolved.orderId}` : ''} → ${keysOf(sources)}`, note);
}

async function getTrackingTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const captureId = str(input, 'capture_id');
  checkCapture(ctx, captureId);
  const numbers = ctx.order?.trackingNumbers.length
    ? ctx.order.trackingNumbers
    : (() => {
        const local = getOrderByCaptureId(captureId);
        return local?.tracking_number ? [local.tracking_number] : [];
      })();
  if (numbers.length === 0) {
    return ok([], 'No tracking on this transaction', 'No tracking number is attached to this transaction in PayPal or in the store records.');
  }

  const inputs: SourceInput[] = [];
  const notes: string[] = [];
  let trackerIndex = -1;
  let trackerStatus: string | null = null;
  const tn = numbers[0];
  const live = ctx.dispute.source === 'paypal_sandbox' && paypalAvailable();

  if (live) {
    const tracker = await getTracker(captureId, tn, { disputeId: ctx.dispute.id, runId: ctx.runId });
    if (tracker) {
      trackerStatus = tracker.status ?? null;
      const carrier = tracker.carrier === 'OTHER' && tracker.carrier_name_other ? tracker.carrier_name_other : tracker.carrier;
      trackerIndex = inputs.length;
      inputs.push({
        kind: 'tracking_event',
        title: `PayPal tracker ${tn} status ${tracker.status ?? 'unknown'}`,
        content: [
          `PayPal tracker on capture ${captureId}: tracking number ${tracker.tracking_number ?? tn}`,
          carrier ? `, carrier ${carrier}` : '',
          `, status ${tracker.status ?? 'unknown'}`,
          tracker.shipment_date ? `, shipment date ${tracker.shipment_date}` : '',
          '.',
        ].join(''),
        ref: `GET /v1/shipping/trackers/${captureId}-${tn}`,
      });
    } else {
      notes.push(`Tracking number ${tn} is in the store records but no PayPal tracker exists for it on this capture.`);
    }
  } else {
    notes.push('PayPal is not reachable for this dispute, so the PayPal tracker was not read.');
  }

  const carrier = await getCarrierTracking(tn);
  const eventIndexes: number[] = [];
  if (carrier) {
    for (const e of carrier.events) {
      const delivered = String(e.status).toUpperCase() === 'DELIVERED';
      const place = [e.city, e.state].filter(Boolean).join(', ');
      eventIndexes.push(inputs.length);
      inputs.push({
        kind: 'tracking_event',
        title: `${carrier.provider_label}: ${e.status} ${e.time.slice(0, 10)}${place ? ` ${place}` : ''}`,
        content: [
          `${carrier.provider_label} event ${e.event_id} for tracking ${tn} (${carrier.carrier}${carrier.service ? ` ${carrier.service}` : ''}): `,
          `${e.status}, "${e.description}", ${e.time}`,
          place || e.zip ? `, ${[e.city, e.state, e.zip].filter(Boolean).join(' ')}` : '',
          '.',
          delivered && carrier.signature_name ? ` Signed for by ${carrier.signature_name}.` : '',
        ].join(''),
        ref: `carrier:${carrier.provider}/${tn}#${e.event_id}`,
      });
    }
    if (carrier.is_fixture) notes.push('Carrier scans come from the carrier fixture provider, not a live carrier API.');
  } else {
    notes.push(`The carrier provider has no scans for ${tn}.`);
  }

  const sources = store(ctx, inputs);
  if (trackerIndex >= 0) {
    ctx.facts.tracker = { source_key: sources[trackerIndex].source_key, tracking_number: tn, status: trackerStatus };
  }
  if (carrier) {
    ctx.facts.carrier_events = carrier.events.map((e, i) => {
      const delivered = String(e.status).toUpperCase() === 'DELIVERED';
      return {
        source_key: sources[eventIndexes[i]].source_key,
        status: String(e.status),
        occurred_at: e.time,
        signature_name: delivered ? carrier.signature_name : null,
        delivery_zip: delivered ? (e.zip ?? carrier.delivery_zip) : null,
      };
    });
  }
  return ok(sources, `Read tracking ${tn} → ${keysOf(sources)}`, notes.join(' ') || undefined, {
    tracking_number: tn,
    source_keys: sources.map((s) => s.source_key),
  });
}

interface StorePolicy {
  slug: string;
  title: string;
  file: string;
  published_at: string;
}

function loadStorePolicies(): StorePolicy[] {
  const file = path.join(process.cwd(), 'data', 'fixtures', 'store.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as { policies?: StorePolicy[] };
  return json.policies ?? [];
}

/** "## 1. Return window" sections → [{num, name, body}]. */
export function splitPolicyClauses(markdown: string): { num: string; name: string; body: string }[] {
  const clauses: { num: string; name: string; body: string }[] = [];
  let current: { num: string; name: string; lines: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(?:(\d+)[.)]\s*)?(.+?)\s*$/.exec(line);
    if (h) {
      if (current) clauses.push({ num: current.num, name: current.name, body: oneLine(current.lines.join(' ')) });
      current = { num: h[1] ?? String(clauses.length + 1), name: h[2], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) clauses.push({ num: current.num, name: current.name, body: oneLine(current.lines.join(' ')) });
  return clauses.filter((c) => c.body);
}

async function getPolicyTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const slug = str(input, 'slug');
  const policy = loadStorePolicies().find((p) => p.slug === slug);
  if (!policy) throw new ToolInputError(`Unknown policy "${slug}". Use returns, shipping or size-guide.`);
  const markdown = readFileSync(path.join(process.cwd(), policy.file), 'utf8');
  const clauses = splitPolicyClauses(markdown);
  const sources = store(
    ctx,
    clauses.map((c) => ({
      kind: 'policy_clause' as const,
      title: `${policy.title} §${c.num} ${c.name}`,
      content: `${policy.title} (published ${policy.published_at}), §${c.num} ${c.name}: ${c.body}`,
      ref: `policy:${slug}#${c.num}`,
    })),
  );
  if (sources.length) {
    ctx.facts.policies = [...(ctx.facts.policies ?? []), { source_key: sources[0].source_key, slug, published_at: policy.published_at }];
  }
  return ok(sources, `Read ${policy.title} (${sources.length} clauses) → ${keysOf(sources)}`);
}

async function getSkuTool(ctx: AgentContext, input: unknown): Promise<ToolOutcome> {
  const skuId = str(input, 'sku');
  const sku = getSku(skuId);
  if (!sku) throw new ToolInputError(`SKU ${skuId} is not in the store catalog.`);
  const inputs: SourceInput[] = [
    {
      kind: 'sku_field',
      title: `SKU ${sku.sku}: ${sku.name}`,
      content: [
        `SKU ${sku.sku} "${sku.name}" (${sku.category}). Listing description: ${sku.description}`,
        sku.size_chart_version ? ` Size chart version: ${sku.size_chart_version}.` : '',
        ` List price: ${moneyText(sku.price_cents, 'USD')}.`,
      ].join(''),
      ref: `local:skus/${sku.sku}`,
    },
  ];
  const snad = reasonGroup(ctx.dispute.reason) === 'SNAD';
  const claimAt = ctx.facts.dispute?.created_at ?? ctx.dispute.pp_created_at;
  let prior: { count: number; ids: string[] } | null = null;
  if (snad && claimAt) {
    prior = countPriorOnSku(sku.sku, ctx.dispute.reason, claimAt, ctx.dispute.id, 90);
    inputs.push({
      kind: 'sku_field',
      title: `Dispute history for ${sku.sku}`,
      content: `Store records: ${prior.count} other ${ctx.dispute.reason} dispute(s) on SKU ${sku.sku} opened in the 90 days before ${claimAt}.`,
      ref: `local:disputes?sku=${sku.sku}`,
    });
  }
  const sources = store(ctx, inputs);
  ctx.skuCogsCents = sku.cogs_cents;
  ctx.facts.sku = { source_key: sources[0].source_key, sku: sku.sku, description: sku.description };
  if (prior) ctx.facts.prior_snad_on_sku_90d = { count: prior.count, source_ids: [sources[1].source_key] };
  return ok(sources, `Read SKU ${sku.sku} → ${keysOf(sources)}`);
}

// ── Deterministic tools ──────────────────────────────────────────────

export function runScore(ctx: AgentContext): StrengthResult {
  ctx.strength = scoreEvidence(ctx.dispute.reason, ctx.facts);
  return ctx.strength;
}

export function runExpectedValue(ctx: AgentContext, offerFraction: 0.3 | 0.5 = 0.5): EvResult {
  const strength = ctx.strength ?? runScore(ctx);
  const cogs = ctx.skuCogsCents ?? (ctx.dispute.sku ? getSku(ctx.dispute.sku)?.cogs_cents : null) ?? 0;
  ctx.ev = computeExpectedValue({
    amount_cents: ctx.dispute.amount_cents,
    ...defaultCostInputs(),
    cogs_cents: cogs,
    strength_score: strength.score,
    item_returned_on_accept: reasonGroup(ctx.dispute.reason) === 'SNAD',
    offer_fraction: offerFraction,
    currency: ctx.dispute.currency,
  });
  return ctx.ev;
}

function scoreTool(ctx: AgentContext): ToolOutcome {
  const s = runScore(ctx);
  const lines = s.items.map(
    (i) => `- ${i.present ? 'PRESENT' : 'missing'} (${i.weight}) ${i.label}: ${i.detail}${i.source_ids.length ? ` [${i.source_ids.join(', ')}]` : ''}`,
  );
  return {
    content: `Evidence strength for ${s.reason_group}: ${s.score}/100.\n${lines.join('\n')}`,
    isError: false,
    sources: [],
    summary: `Strength ${s.score}/100 (${s.reason_group} rubric)`,
    data: s,
  };
}

function evTool(ctx: AgentContext, input: unknown): ToolOutcome {
  const raw = (input as { offer_fraction?: unknown } | null)?.offer_fraction;
  const fraction = raw === 0.3 ? 0.3 : 0.5;
  const ev = runExpectedValue(ctx, fraction);
  const lines = ev.options.map((o) => `- ${o.action}: ${o.formula}${o.note ? ` (${o.note})` : ''}`);
  return {
    content: `Expected cost of each option (s = strength used as a rough win proxy, not a trained probability):\n${lines.join('\n')}\nRecommended (lowest expected cost): ${ev.recommended}.`,
    isError: false,
    sources: [],
    summary: `Expected value → ${ev.recommended}`,
    data: ev,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────

const HANDLERS: Record<string, (ctx: AgentContext, input: unknown) => Promise<ToolOutcome> | ToolOutcome> = {
  get_dispute: getDisputeTool,
  get_messages: getMessagesTool,
  get_transaction: getTransactionTool,
  get_tracking: getTrackingTool,
  get_policy: getPolicyTool,
  get_sku: getSkuTool,
  score_evidence: (ctx) => scoreTool(ctx),
  compute_expected_value: evTool,
};

/** Runs one tool call. Errors come back as an is_error result the model can react to, never as a throw. */
export async function executeTool(ctx: AgentContext, name: string, input: unknown): Promise<ToolOutcome> {
  ctx.calls[name] = (ctx.calls[name] ?? 0) + 1;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: `Unknown tool "${name}".`, isError: true, sources: [], summary: `Unknown tool ${name}` };
  }
  const cacheKey = DATA_TOOL_NAMES.has(name) ? `${name}:${JSON.stringify(input ?? {})}` : null;
  const cached = cacheKey ? ctx.cache.get(cacheKey) : undefined;
  if (cached) {
    return { ...cached, sources: [], summary: `${cached.summary} (already read; same sources)` };
  }
  try {
    const outcome = await handler(ctx, input);
    if (cacheKey && !outcome.isError) ctx.cache.set(cacheKey, outcome);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const debugId = (err as { debugId?: string | null }).debugId;
    return {
      content: `Error: ${message}${debugId ? ` (paypal-debug-id ${debugId})` : ''}`,
      isError: true,
      sources: [],
      summary: `${name} failed: ${message.slice(0, 160)}`,
      data: { error: message, debug_id: debugId ?? null },
    };
  }
}
