import { centsToValue, paypalRequest, type PaypalResponse } from './client';
import { buildProvideEvidenceForm, buildSendMessageForm, type EvidenceInput } from './multipart';

/** Typed wrappers for PayPal Disputes v1. */

export interface Money {
  currency_code: string;
  value: string;
}

export interface DisputeMessage {
  posted_by: 'BUYER' | 'SELLER' | 'ARBITER' | string;
  time_posted: string;
  content: string;
  documents?: { name: string; url?: string }[];
}

export interface DisputedTransaction {
  buyer_transaction_id?: string;
  seller_transaction_id?: string;
  create_time?: string;
  transaction_status?: string;
  gross_amount?: Money;
  invoice_number?: string;
  buyer?: { name?: string; email?: string; payer_id?: string };
  seller?: { email?: string; merchant_id?: string; name?: string };
  items?: { item_id?: string; item_name?: string; item_description?: string; item_quantity?: string; reason?: string; notes?: string }[];
}

export interface PaypalDispute {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  disputed_transactions?: DisputedTransaction[];
  reason: string;
  status: string;
  dispute_amount?: Money;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: Money };
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  dispute_state?: string;
  messages?: DisputeMessage[];
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  offer?: unknown;
  links?: { href: string; rel: string; method?: string }[];
  [key: string]: unknown;
}

export interface DisputeSummary {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_amount?: Money;
  links?: { href: string; rel: string; method?: string }[];
}

export interface CallContext {
  runId?: string | null;
}

export interface MutationResult {
  status_code: number;
  debug_id: string | null;
  call_id: number | null;
  data: unknown;
}

function toResult(res: PaypalResponse<unknown>): MutationResult {
  return { status_code: res.status, debug_id: res.debugId, call_id: res.callId, data: res.data };
}

function enc(id: string): string {
  if (!id || typeof id !== 'string') throw new Error('Dispute id is required');
  return encodeURIComponent(id);
}

function relativeHref(href: string): string {
  try {
    const u = new URL(href);
    return `${u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

export interface ListDisputesOptions {
  updateTimeAfter?: string | null;
  disputeState?: string;
  pageSize?: number;
  maxPages?: number;
}

/** GET /v1/customer/disputes, following `next` links up to maxPages. */
export async function listDisputes(opts: ListDisputesOptions = {}): Promise<DisputeSummary[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 50);
  const maxPages = opts.maxPages ?? 10;
  const items: DisputeSummary[] = [];
  let res = await paypalRequest<{ items?: DisputeSummary[]; links?: { href: string; rel: string }[] }>(
    'GET',
    '/v1/customer/disputes',
    {
      query: {
        page_size: pageSize,
        update_time_after: opts.updateTimeAfter ?? undefined,
        dispute_state: opts.disputeState,
      },
    },
  );
  items.push(...(res.data.items ?? []));
  for (let page = 1; page < maxPages; page++) {
    const next = res.data.links?.find((l) => l.rel === 'next');
    if (!next) break;
    res = await paypalRequest('GET', relativeHref(next.href));
    items.push(...(res.data.items ?? []));
  }
  return items;
}

/** GET /v1/customer/disputes/{id}. */
export async function getDispute(disputeId: string, ctx: CallContext = {}): Promise<PaypalDispute> {
  const res = await paypalRequest<PaypalDispute>('GET', `/v1/customer/disputes/${enc(disputeId)}`, {
    disputeId,
    runId: ctx.runId ?? null,
  });
  return res.data;
}

/** Same as getDispute but also returns debug metadata. */
export async function getDisputeWithMeta(disputeId: string, ctx: CallContext = {}): Promise<PaypalResponse<PaypalDispute>> {
  return paypalRequest<PaypalDispute>('GET', `/v1/customer/disputes/${enc(disputeId)}`, {
    disputeId,
    runId: ctx.runId ?? null,
  });
}

export interface ProvideEvidenceArgs {
  evidences: readonly EvidenceInput[];
  pdf: Uint8Array | ArrayBuffer;
  filename: string;
}

/** POST /v1/customer/disputes/{id}/provide-evidence as multipart/form-data. */
export async function provideEvidence(disputeId: string, args: ProvideEvidenceArgs, ctx: CallContext = {}): Promise<MutationResult> {
  const form = buildProvideEvidenceForm(args);
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/provide-evidence`, {
    form,
    disputeId,
    runId: ctx.runId ?? null,
    timeoutMs: 60_000,
  });
  return toResult(res);
}

export interface AcceptClaimArgs {
  note: string;
  acceptClaimType?: 'REFUND' | 'REFUND_WITH_RETURN' | 'PARTIAL_REFUND' | 'REFUND_WITH_RETURN_SHIPMENT_LABEL';
}

/** POST /v1/customer/disputes/{id}/accept-claim. */
export async function acceptClaim(disputeId: string, args: AcceptClaimArgs, ctx: CallContext = {}): Promise<MutationResult> {
  const note = args.note.trim();
  if (!note) throw new Error('accept-claim requires a note');
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/accept-claim`, {
    body: { note: note.slice(0, 2000), accept_claim_type: args.acceptClaimType ?? 'REFUND' },
    disputeId,
    runId: ctx.runId ?? null,
  });
  return toResult(res);
}

export type OfferType = 'REFUND' | 'REFUND_WITH_RETURN' | 'REFUND_WITH_REPLACEMENT';

export interface MakeOfferArgs {
  note: string;
  amountCents: number;
  currency: string;
  offerType: OfferType;
}

/** POST /v1/customer/disputes/{id}/make-offer. */
export async function makeOffer(disputeId: string, args: MakeOfferArgs, ctx: CallContext = {}): Promise<MutationResult> {
  const note = args.note.trim();
  if (!note) throw new Error('make-offer requires a note');
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) throw new Error('Offer amount must be a positive integer of cents');
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/make-offer`, {
    body: {
      note: note.slice(0, 2000),
      offer_amount: { currency_code: args.currency || 'USD', value: centsToValue(args.amountCents) },
      offer_type: args.offerType,
    },
    disputeId,
    runId: ctx.runId ?? null,
  });
  return toResult(res);
}

/** POST /v1/customer/disputes/{id}/send-message (multipart, part `input`). */
export async function sendMessage(disputeId: string, message: string, ctx: CallContext = {}): Promise<MutationResult> {
  const form = buildSendMessageForm(message);
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/send-message`, {
    form,
    disputeId,
    runId: ctx.runId ?? null,
  });
  return toResult(res);
}

function assertSandbox(): void {
  if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') {
    throw new Error('Sandbox lifecycle endpoints are disabled outside PAYPAL_ENV=sandbox');
  }
}

/** Sandbox only: POST /v1/customer/disputes/{id}/require-evidence. */
export async function requireEvidence(
  disputeId: string,
  action: 'SELLER_EVIDENCE' | 'BUYER_EVIDENCE' = 'SELLER_EVIDENCE',
  ctx: CallContext = {},
): Promise<MutationResult> {
  assertSandbox();
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/require-evidence`, {
    body: { action },
    disputeId,
    runId: ctx.runId ?? null,
  });
  return toResult(res);
}

/** Sandbox only: POST /v1/customer/disputes/{id}/adjudicate. */
export async function adjudicate(
  disputeId: string,
  outcome: 'SELLER_FAVOR' | 'BUYER_FAVOR',
  ctx: CallContext = {},
): Promise<MutationResult> {
  assertSandbox();
  const res = await paypalRequest('POST', `/v1/customer/disputes/${enc(disputeId)}/adjudicate`, {
    body: { adjudication_outcome: outcome },
    disputeId,
    runId: ctx.runId ?? null,
  });
  return toResult(res);
}

/** Seller transaction id (= Payments v2 capture id) for a dispute. */
export function captureIdOf(dispute: PaypalDispute): string | null {
  return dispute.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id ?? null;
}

/** Disputed amount in integer cents, with currency. */
export function disputeAmountOf(dispute: PaypalDispute): { cents: number; currency: string } {
  const amt = dispute.dispute_amount ?? dispute.disputed_transactions?.[0]?.gross_amount;
  const value = amt?.value ? Number.parseFloat(amt.value) : 0;
  return { cents: Number.isFinite(value) ? Math.round(value * 100) : 0, currency: amt?.currency_code ?? 'USD' };
}