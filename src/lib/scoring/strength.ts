/**
 * Deterministic evidence-strength rubric (see docs/evidence-strength-rubric.md).
 * Weights sum to 100 per reason group. Claude cannot override the score; it only explains it.
 */

export type ReasonGroup = 'INR' | 'SNAD' | 'UNAUTHORISED' | 'OTHER';

export interface RubricItemDef {
  key: string;
  label: string;
  weight: number;
}

export const RUBRICS: Record<ReasonGroup, RubricItemDef[]> = {
  INR: [
    { key: 'tracking_attached', label: 'Tracking attached in PayPal', weight: 25 },
    { key: 'carrier_delivered', label: 'Carrier shows delivered', weight: 30 },
    { key: 'zip_match', label: 'Delivery ZIP matches order ship-to', weight: 20 },
    { key: 'signature', label: 'Signature captured', weight: 15 },
    { key: 'shipped_before_claim', label: "Shipped before buyer's claim date", weight: 10 },
  ],
  SNAD: [
    { key: 'description_match', label: 'Listing description matches the delivered SKU', weight: 25 },
    { key: 'policy_before_purchase', label: 'Policy published before purchase', weight: 20 },
    { key: 'seller_responded_48h', label: 'Seller responded to buyer in under 48 h', weight: 15 },
    { key: 'return_offered', label: 'Offered return per policy', weight: 20 },
    { key: 'no_prior_snad', label: 'No prior SNAD on this SKU in 90 days', weight: 20 },
  ],
  UNAUTHORISED: [
    { key: 'delivered_to_verified_address', label: 'Delivered to the PayPal-verified ship-to', weight: 35 },
    { key: 'signature', label: 'Signature captured', weight: 25 },
    { key: 'prior_orders', label: 'Prior non-disputed orders from the same buyer', weight: 20 },
    { key: 'delivery_confirmed', label: 'Delivery confirmed', weight: 20 },
  ],
  OTHER: [
    { key: 'tracking_attached', label: 'Tracking attached in PayPal', weight: 40 },
    { key: 'carrier_delivered', label: 'Carrier shows delivered', weight: 40 },
    { key: 'policy_before_purchase', label: 'Policy published before purchase', weight: 20 },
  ],
};

export interface StrengthItem {
  key: string;
  label: string;
  weight: number;
  present: boolean;
  source_ids: string[];
  detail: string;
}

export interface StrengthResult {
  reason: string;
  reason_group: ReasonGroup;
  score: number;
  max: number;
  items: StrengthItem[];
}

/** Facts gathered by the agent tools; every fact carries the source key it came from. */
export interface StrengthContext {
  dispute?: { source_key: string; created_at?: string | null; sku?: string | null };
  order?: {
    source_key: string;
    sku?: string | null;
    captured_at?: string | null;
    ship_to_postal_code?: string | null;
  };
  tracker?: { source_key: string; tracking_number?: string | null; status?: string | null };
  carrier_events?: {
    source_key: string;
    status: string;
    occurred_at?: string | null;
    signature_name?: string | null;
    delivery_zip?: string | null;
  }[];
  messages?: { source_key: string; posted_by: string; time_posted?: string | null; text: string }[];
  policies?: { source_key: string; slug: string; published_at?: string | null }[];
  sku?: { source_key: string; sku: string; description?: string | null };
  prior_snad_on_sku_90d?: { count: number; source_ids: string[] };
  prior_undisputed_orders?: { count: number; source_ids: string[] };
}

export function reasonGroup(reason: string): ReasonGroup {
  const r = (reason || '').toUpperCase();
  if (r === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') return 'INR';
  if (r === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return 'SNAD';
  if (r === 'UNAUTHORISED' || r === 'UNAUTHORIZED') return 'UNAUTHORISED';
  return 'OTHER';
}

interface Fact {
  present: boolean;
  source_ids: string[];
  detail: string;
}

const uniq = (ids: (string | null | undefined)[]): string[] =>
  Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0)));

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function normalizeZip(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const z = zip.toUpperCase().replace(/\s+/g, '');
  const us = /^(\d{5})(-?\d{4})?$/.exec(z);
  return us ? us[1] : z || null;
}

function isDelivered(status: string | null | undefined): boolean {
  return (status || '').toUpperCase() === 'DELIVERED';
}

function deliveredEvents(ctx: StrengthContext) {
  return (ctx.carrier_events ?? []).filter((e) => isDelivered(e.status));
}

function factTrackingAttached(ctx: StrengthContext): Fact {
  const t = ctx.tracker;
  if (t && t.tracking_number) {
    return { present: true, source_ids: [t.source_key], detail: `Tracker ${t.tracking_number} is on the PayPal transaction` };
  }
  return { present: false, source_ids: [], detail: 'No tracker found on the PayPal transaction' };
}

function factCarrierDelivered(ctx: StrengthContext): Fact {
  const evs = deliveredEvents(ctx);
  const trackerDelivered = ctx.tracker && isDelivered(ctx.tracker.status);
  if (evs.length > 0 || trackerDelivered) {
    return {
      present: true,
      source_ids: uniq([...evs.map((e) => e.source_key), trackerDelivered ? ctx.tracker!.source_key : null]),
      detail: 'Carrier or tracker reports DELIVERED',
    };
  }
  return { present: false, source_ids: [], detail: 'No delivered scan found' };
}

function factZipMatch(ctx: StrengthContext): Fact {
  const orderZip = normalizeZip(ctx.order?.ship_to_postal_code);
  if (!orderZip) return { present: false, source_ids: [], detail: 'Order ship-to ZIP unknown' };
  const match = deliveredEvents(ctx).find((e) => normalizeZip(e.delivery_zip) === orderZip);
  if (match) {
    return {
      present: true,
      source_ids: uniq([match.source_key, ctx.order!.source_key]),
      detail: `Delivered to ZIP ${orderZip}, matching the order ship-to`,
    };
  }
  return { present: false, source_ids: [], detail: 'No delivery scan at the order ship-to ZIP' };
}

function factSignature(ctx: StrengthContext): Fact {
  const ev = deliveredEvents(ctx).find((e) => e.signature_name && e.signature_name.trim());
  if (ev) return { present: true, source_ids: [ev.source_key], detail: `Signed for by ${ev.signature_name}` };
  return { present: false, source_ids: [], detail: 'No signature on the delivery scan' };
}

function factShippedBeforeClaim(ctx: StrengthContext): Fact {
  const claimAt = ts(ctx.dispute?.created_at);
  if (claimAt == null) return { present: false, source_ids: [], detail: 'Claim date unknown' };
  const shipped = (ctx.carrier_events ?? [])
    .map((e) => ({ e, t: ts(e.occurred_at) }))
    .filter((x): x is { e: NonNullable<StrengthContext['carrier_events']>[number]; t: number } => x.t != null)
    .sort((a, b) => a.t - b.t)[0];
  if (shipped && shipped.t < claimAt) {
    return {
      present: true,
      source_ids: uniq([shipped.e.source_key, ctx.dispute!.source_key]),
      detail: 'First carrier scan is earlier than the claim',
    };
  }
  return { present: false, source_ids: [], detail: 'No carrier scan before the claim date' };
}

function factPolicyBeforePurchase(ctx: StrengthContext, slugs?: string[]): Fact {
  const purchaseAt = ts(ctx.order?.captured_at);
  if (purchaseAt == null) return { present: false, source_ids: [], detail: 'Purchase time unknown' };
  const policies = (ctx.policies ?? []).filter((p) => !slugs || slugs.includes(p.slug));
  const before = policies.filter((p) => {
    const t = ts(p.published_at);
    return t != null && t < purchaseAt;
  });
  if (before.length > 0) {
    return {
      present: true,
      source_ids: uniq([...before.map((p) => p.source_key), ctx.order!.source_key]),
      detail: `Policy published before purchase: ${before.map((p) => p.slug).join(', ')}`,
    };
  }
  return { present: false, source_ids: [], detail: 'No policy shown as published before the purchase' };
}

function factDescriptionMatch(ctx: StrengthContext): Fact {
  const sku = ctx.sku;
  const orderSku = ctx.order?.sku ?? ctx.dispute?.sku ?? null;
  if (sku && sku.description && sku.description.trim() && orderSku && orderSku === sku.sku) {
    return {
      present: true,
      source_ids: uniq([sku.source_key, ctx.order?.source_key ?? ctx.dispute?.source_key]),
      detail: `Order line item is ${sku.sku}, which has a published description`,
    };
  }
  return { present: false, source_ids: [], detail: 'Could not match the ordered SKU to its listing description' };
}

const isBuyer = (who: string) => /BUYER/i.test(who);
const isSeller = (who: string) => /SELLER/i.test(who);

function factSellerResponded48h(ctx: StrengthContext): Fact {
  const msgs = (ctx.messages ?? [])
    .map((m) => ({ m, t: ts(m.time_posted) }))
    .filter((x): x is { m: NonNullable<StrengthContext['messages']>[number]; t: number } => x.t != null)
    .sort((a, b) => a.t - b.t);
  const firstBuyer = msgs.find((x) => isBuyer(x.m.posted_by));
  if (!firstBuyer) return { present: false, source_ids: [], detail: 'No buyer message in the thread' };
  const reply = msgs.find(
    (x) => isSeller(x.m.posted_by) && x.t >= firstBuyer.t && x.t - firstBuyer.t <= 48 * 3_600_000,
  );
  if (reply) {
    const hours = Math.round(((reply.t - firstBuyer.t) / 3_600_000) * 10) / 10;
    return {
      present: true,
      source_ids: [firstBuyer.m.source_key, reply.m.source_key],
      detail: `Seller replied ${hours} h after the buyer's first message`,
    };
  }
  return { present: false, source_ids: [], detail: 'No seller reply within 48 h of the first buyer message' };
}

function factReturnOffered(ctx: StrengthContext): Fact {
  const offer = (ctx.messages ?? []).find((m) => isSeller(m.posted_by) && /\breturn/i.test(m.text));
  if (offer) {
    const returnsPolicy = (ctx.policies ?? []).find((p) => p.slug === 'returns');
    return {
      present: true,
      source_ids: uniq([offer.source_key, returnsPolicy?.source_key]),
      detail: 'Seller message offers a return',
    };
  }
  return { present: false, source_ids: [], detail: 'No seller message offering a return' };
}

function factNoPriorSnad(ctx: StrengthContext): Fact {
  const p = ctx.prior_snad_on_sku_90d;
  if (!p) return { present: false, source_ids: [], detail: 'Prior SNAD history not checked' };
  if (p.count === 0) {
    return {
      present: true,
      source_ids: uniq([...p.source_ids, ctx.sku?.source_key]),
      detail: 'No other SNAD claims on this SKU in the last 90 days',
    };
  }
  return { present: false, source_ids: uniq(p.source_ids), detail: `${p.count} prior SNAD claim(s) on this SKU in 90 days` };
}

function factPriorOrders(ctx: StrengthContext): Fact {
  const p = ctx.prior_undisputed_orders;
  if (p && p.count > 0) {
    return { present: true, source_ids: uniq(p.source_ids), detail: `${p.count} earlier undisputed order(s) from this buyer` };
  }
  return { present: false, source_ids: [], detail: 'No earlier undisputed orders from this buyer' };
}

function factDeliveredToVerified(ctx: StrengthContext): Fact {
  const zip = factZipMatch(ctx);
  return zip.present
    ? { ...zip, detail: `${zip.detail} (PayPal ship-to address)` }
    : { present: false, source_ids: [], detail: 'Delivery to the PayPal ship-to not confirmed' };
}

function resolveFact(group: ReasonGroup, key: string, ctx: StrengthContext): Fact {
  switch (key) {
    case 'tracking_attached':
      return factTrackingAttached(ctx);
    case 'carrier_delivered':
    case 'delivery_confirmed':
      return factCarrierDelivered(ctx);
    case 'zip_match':
      return factZipMatch(ctx);
    case 'signature':
      return factSignature(ctx);
    case 'shipped_before_claim':
      return factShippedBeforeClaim(ctx);
    case 'policy_before_purchase':
      return group === 'SNAD'
        ? factPolicyBeforePurchase(ctx, ['returns', 'size-guide'])
        : factPolicyBeforePurchase(ctx);
    case 'description_match':
      return factDescriptionMatch(ctx);
    case 'seller_responded_48h':
      return factSellerResponded48h(ctx);
    case 'return_offered':
      return factReturnOffered(ctx);
    case 'no_prior_snad':
      return factNoPriorSnad(ctx);
    case 'prior_orders':
      return factPriorOrders(ctx);
    case 'delivered_to_verified_address':
      return factDeliveredToVerified(ctx);
    default:
      return { present: false, source_ids: [], detail: 'Unknown rubric item' };
  }
}

export function scoreEvidence(reason: string, ctx: StrengthContext): StrengthResult {
  const group = reasonGroup(reason);
  const rubric = RUBRICS[group];
  const items: StrengthItem[] = rubric.map((def) => {
    const fact = resolveFact(group, def.key, ctx);
    return {
      key: def.key,
      label: def.label,
      weight: def.weight,
      present: fact.present,
      source_ids: fact.present ? fact.source_ids : [],
      detail: fact.detail,
    };
  });
  const max = rubric.reduce((s, d) => s + d.weight, 0);
  const raw = items.reduce((s, i) => s + (i.present ? i.weight : 0), 0);
  const score = Math.max(0, Math.min(100, Math.round((raw / (max || 100)) * 100)));
  return { reason, reason_group: group, score, max: 100, items };
}