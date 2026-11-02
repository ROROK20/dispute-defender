import type Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import type { ModelFn, ModelRequest } from './anthropic';
import type { AgentContext } from './tools';
import type { EvidencePlanItem, Sentence, SubmitAnalysis } from './schemas';
import { allowedEvidenceTypes } from '../paypal/evidence-rules';
import { keywordTag } from '../patterns/themes';
import { getSku } from '../repo/skus';
import { getSourcesByKey, type Source } from '../repo/sources';
import { normalizeZip, reasonGroup, type ReasonGroup } from '../scoring/strength';

/**
 * ANTHROPIC_MOCK=1 only (tests and CI; the UI shows a red MOCK MODE banner).
 * A scripted stand-in for Claude with the same interface as the real model.
 * It drives the real runner loop: it asks for the same tools in a fixed
 * order, the tools really run (against the PayPal mock adapter), and it then
 * drafts the letter from the stored sources with templates, citing them
 * exactly. Nothing here is presented as model output in a real run.
 */

type Call = { name: string; input: Record<string, unknown> };

function message(content: unknown[], stop: 'tool_use' | 'end_turn'): Anthropic.Message {
  return {
    id: `msg_mock_${nanoid(10)}`,
    type: 'message',
    role: 'assistant',
    model: 'mock',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function toolCalls(calls: Call[]): Anthropic.Message {
  return message(
    calls.map((c) => ({ type: 'tool_use', id: `toolu_mock_${nanoid(10)}`, name: c.name, input: c.input })),
    'tool_use',
  );
}

function captureId(ctx: AgentContext): string {
  const raw = (ctx.dispute.raw ?? {}) as { disputed_transactions?: { seller_transaction_id?: string }[] };
  return ctx.dispute.capture_id ?? raw.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id ?? '';
}

function plan(ctx: AgentContext): Call[][] {
  const id = ctx.dispute.id;
  const cap = captureId(ctx);
  const sku = ctx.dispute.sku ?? ctx.facts.dispute?.sku ?? '';
  const first: Call[] = [
    { name: 'get_dispute', input: { dispute_id: id } },
    { name: 'get_messages', input: { dispute_id: id } },
  ];
  const decide: Call[] = [
    { name: 'score_evidence', input: {} },
    { name: 'compute_expected_value', input: { offer_fraction: 0.5 } },
  ];
  switch (reasonGroup(ctx.dispute.reason)) {
    case 'SNAD':
      return [
        first,
        [{ name: 'get_transaction', input: { capture_id: cap } }, ...(sku ? [{ name: 'get_sku', input: { sku } }] : [])],
        [
          { name: 'get_policy', input: { slug: 'returns' } },
          { name: 'get_policy', input: { slug: 'size-guide' } },
          { name: 'get_tracking', input: { capture_id: cap } },
        ],
        decide,
      ];
    case 'UNAUTHORISED':
      return [first, [{ name: 'get_transaction', input: { capture_id: cap } }, { name: 'get_tracking', input: { capture_id: cap } }], decide];
    default:
      return [
        first,
        [{ name: 'get_transaction', input: { capture_id: cap } }, { name: 'get_tracking', input: { capture_id: cap } }],
        [{ name: 'get_policy', input: { slug: 'shipping' } }],
        decide,
      ];
  }
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

function firstSentence(text: string, max = 180): string | null {
  const s = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  if (!s || s.includes('"') || s.length > max) return null;
  return s.replace(/[.!?]+$/, '');
}

function bodyOf(src: Source): string {
  const i = src.content.indexOf(': ');
  return i >= 0 ? src.content.slice(i + 2) : src.content;
}

class Letter {
  private items: Sentence[] = [];
  add(text: string | null, sourceIds: (string | null | undefined)[]): void {
    const ids = sourceIds.filter((x): x is string => Boolean(x));
    if (!text || ids.length === 0) return;
    this.items.push({ id: `s${this.items.length + 1}`, text, source_ids: Array.from(new Set(ids)) });
  }
  get sentences(): Sentence[] {
    return this.items;
  }
}

function draft(ctx: AgentContext): SubmitAnalysis {
  const sources = getSourcesByKey(ctx.runId);
  const f = ctx.facts;
  const group: ReasonGroup = reasonGroup(ctx.dispute.reason);
  const letter = new Letter();
  const d = f.dispute;
  const dSrc = d ? sources[d.source_key] : undefined;
  const amount = dSrc ? /Disputed amount: (\S+)/.exec(dSrc.content)?.[1] ?? null : null;
  const delivered = (f.carrier_events ?? []).find((e) => e.status.toUpperCase() === 'DELIVERED');
  const zipMatch =
    delivered && f.order?.ship_to_postal_code && normalizeZip(delivered.delivery_zip) === normalizeZip(f.order.ship_to_postal_code);

  if (d) {
    letter.add(
      `We are responding to PayPal dispute ${ctx.dispute.id}${d.created_at ? `, opened on ${day(d.created_at)}` : ''}${amount ? `, about a payment of ${amount}` : ''}.`,
      [d.source_key],
    );
  }

  if (group === 'SNAD') {
    const sku = f.sku ? getSku(f.sku.sku) : null;
    if (f.sku && sku) {
      letter.add(`The buyer purchased the ${sku.name} (SKU ${sku.sku}).`, [f.sku.source_key]);
      const desc = firstSentence(sku.description);
      if (desc) letter.add(`Its listing describes it as "${desc}".`, [f.sku.source_key]);
    }
    const buyer = (f.messages ?? []).find((m) => /BUYER/i.test(m.posted_by));
    const buyerQuote = buyer ? firstSentence(buyer.text) : null;
    if (buyer && buyerQuote) letter.add(`The buyer wrote: "${buyerQuote}".`, [buyer.source_key]);
    const reply = (f.messages ?? []).find((m) => /SELLER/i.test(m.posted_by) && /\breturn/i.test(m.text));
    if (reply) letter.add(`We replied on ${day(reply.time_posted)} and offered a return under our policy.`, [reply.source_key]);
    const sizing = buyer ? keywordTag(buyer.text).themes.includes('sizing') : false;
    const clauses = Object.values(sources).filter((s) => s.kind === 'policy_clause' && s.ref?.startsWith('policy:returns'));
    const clause = clauses.find((s) => (sizing ? /fit|size/i : /not as described|materially/i).test(s.title)) ?? clauses[0];
    const published = clause ? /\(published ([^)]+)\)/.exec(clause.content)?.[1] : null;
    const clauseQuote = clause ? firstSentence(bodyOf(clause)) : null;
    if (clause && clauseQuote) {
      letter.add(`Our returns policy, published on ${day(published)}, states: "${clauseQuote}".`, [clause.source_key]);
    }
    letter.add('We stand by the listing and the return we offered, and ask that the case be reviewed with these records.', [d?.source_key]);
  } else {
    if (group === 'UNAUTHORISED' && f.order?.ship_to_postal_code) {
      letter.add(`The order was shipped to the PayPal ship-to address in ZIP ${f.order.ship_to_postal_code}.`, [f.order.source_key]);
    } else if (f.order?.captured_at) {
      letter.add(`The order was paid and captured on ${day(f.order.captured_at)}.`, [f.order.source_key]);
    }
    if (f.tracker?.tracking_number) {
      letter.add(`Tracking number ${f.tracker.tracking_number} is attached to this PayPal transaction.`, [f.tracker.source_key]);
    }
    const firstScan = (f.carrier_events ?? [])[0];
    if (firstScan && firstScan !== delivered) {
      letter.add(
        `${firstScan.status.toUpperCase() === 'ACCEPTED' ? 'The carrier accepted the parcel' : 'The carrier recorded its first scan'} on ${day(firstScan.occurred_at)}.`,
        [firstScan.source_key],
      );
    }
    if (delivered) {
      letter.add(
        `The carrier recorded delivery on ${day(delivered.occurred_at)}${delivered.delivery_zip ? ` in ZIP ${delivered.delivery_zip}` : ''}.`,
        [delivered.source_key],
      );
      if (zipMatch) letter.add('That ZIP matches the PayPal ship-to address on the order.', [delivered.source_key, f.order?.source_key]);
      if (delivered.signature_name) letter.add(`The delivery was signed for by ${delivered.signature_name}.`, [delivered.source_key]);
      if (d?.created_at && delivered.occurred_at && Date.parse(d.created_at) > Date.parse(delivered.occurred_at)) {
        letter.add(`The buyer opened this dispute on ${day(d.created_at)}, after the delivery scan.`, [d.source_key]);
      }
    }
    const prior = f.prior_undisputed_orders;
    if (group === 'UNAUTHORISED' && prior && prior.count > 0) {
      letter.add(`This PayPal buyer account has ${prior.count} earlier order(s) with our store that were not disputed.`, prior.source_ids);
    }
    letter.add(
      delivered
        ? 'We ask that this case be decided in our favor based on the shipping and delivery records above.'
        : 'We have shared the order records we hold for this purchase and ask that the case be reviewed with them.',
      [d?.source_key],
    );
  }

  if (letter.sentences.length === 0) {
    const any = Object.values(sources)[0];
    letter.add('We ask that this case be reviewed with the records attached.', [any?.source_key]);
  }

  const allowed = new Set<string>(allowedEvidenceTypes(ctx.dispute.reason));
  const evidence: EvidencePlanItem[] = [];
  const push = (item: EvidencePlanItem) => {
    if (allowed.has(item.evidence_type)) evidence.push(item);
  };
  if (group === 'SNAD') {
    push({ evidence_type: 'ITEM_DESCRIPTION', notes: 'Listing description of the ordered SKU.' });
    push({ evidence_type: 'RETURN_POLICY', notes: 'Returns policy published before the purchase.' });
  } else {
    if (f.tracker?.tracking_number) {
      const carrierName = /carrier (\w+)/.exec(sources[f.tracker.source_key]?.content ?? '')?.[1];
      push({
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: 'Carrier tracking attached to the PayPal transaction.',
        tracking_number: f.tracker.tracking_number,
        carrier: carrierName,
      });
    }
    if (delivered?.signature_name) push({ evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', notes: 'Delivery signature from the carrier scan.' });
  }
  if (evidence.length === 0) push({ evidence_type: 'OTHER', notes: 'Cited records in the attached PDF.' });

  const buyer = (f.messages ?? []).find((m) => /BUYER/i.test(m.posted_by));
  const subTheme =
    group === 'SNAD'
      ? (buyer && keywordTag(buyer.text).themes[0]) || 'item differs from listing'
      : group === 'UNAUTHORISED'
        ? 'buyer does not recognize the purchase'
        : group === 'INR'
          ? 'parcel reported not received'
          : 'other';

  return {
    classification: {
      reason: ctx.dispute.reason,
      sub_theme: subTheme,
      evidence_needed: (ctx.strength?.items ?? []).filter((i) => !i.present).map((i) => i.label),
      confidence_note: 'Scripted mock analysis (ANTHROPIC_MOCK=1).',
    },
    recommendation: ctx.ev?.recommended ?? 'FIGHT',
    recommendation_rationale: d
      ? [{ text: 'The expected-value calculation favors this option at the computed evidence strength.', source_ids: [d.source_key] }]
      : [],
    evidence_plan: evidence,
    sentences: letter.sentences,
    buyer_message: d
      ? {
          text:
            group === 'SNAD'
              ? 'Thank you for your message. Our offer of a return under our returns policy still stands.'
              : 'Thank you for reaching out. We have shared the order and delivery records for this purchase with PayPal.',
          source_ids: [d.source_key],
        }
      : undefined,
  };
}

export function createMockModel(ctx: AgentContext): ModelFn {
  return async (req: ModelRequest) => {
    const names = new Set(req.tools.map((t) => t.name));
    if (names.has('revise_sentences')) return toolCalls([{ name: 'revise_sentences', input: { sentences: [] } }]);
    if (names.has('submit_review')) return message([{ type: 'text', text: 'Mock reviewer: no changes.' }], 'end_turn');

    const turn = req.messages.filter((m) => m.role === 'assistant').length;
    const steps = plan(ctx);
    if (turn < steps.length) return toolCalls(steps[turn]);
    return toolCalls([{ name: 'submit_analysis', input: draft(ctx) as unknown as Record<string, unknown> }]);
  };
}
