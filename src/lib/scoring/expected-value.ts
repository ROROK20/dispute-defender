/**
 * Plain-arithmetic expected cost for fight vs. accept-claim vs. make-offer.
 * `s` is the evidence strength used as a rough win proxy, not a trained probability.
 */

export type EvAction = 'FIGHT' | 'ACCEPT_CLAIM' | 'MAKE_OFFER';

export interface EvInputs {
  /** Disputed amount A, cents. */
  amount_cents: number;
  /** Dispute fee F, cents (seller-configured; default from DISPUTE_FEE_USD). */
  fee_cents: number;
  /** Seller time cost T, cents (default from SELLER_TIME_COST_USD). */
  time_cost_cents: number;
  /** SKU cost of goods C, cents. */
  cogs_cents: number;
  /** Evidence strength 0..100. */
  strength_score: number;
  /** Whether accepting the claim returns the item to the seller. */
  item_returned_on_accept: boolean;
  /** Offer fraction o of A. */
  offer_fraction: 0.3 | 0.5;
  currency?: string;
}

export interface EvOption {
  action: EvAction;
  expected_cost_cents: number;
  formula: string;
  label: string;
  note?: string;
}

export interface EvResult {
  inputs: EvInputs & { s: number; s_label: string };
  options: EvOption[];
  recommended: EvAction;
}

export const STRENGTH_LABEL = 'strength used as a rough win proxy, not a trained probability';

function usdEnvToCents(name: string, fallbackUsd: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return Math.round(fallbackUsd * 100);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return Math.round(fallbackUsd * 100);
  return Math.round(n * 100);
}

/** Fee and time cost from env (DISPUTE_FEE_USD default 0, SELLER_TIME_COST_USD default 15). */
export function defaultCostInputs(): { fee_cents: number; time_cost_cents: number } {
  return {
    fee_cents: usdEnvToCents('DISPUTE_FEE_USD', 0),
    time_cost_cents: usdEnvToCents('SELLER_TIME_COST_USD', 15),
  };
}

export function formatMoney(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents) / 100;
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${sign}${symbol}${abs.toFixed(2)}`;
}

function assertInputs(i: EvInputs): void {
  for (const k of ['amount_cents', 'fee_cents', 'time_cost_cents', 'cogs_cents'] as const) {
    if (!Number.isFinite(i[k]) || i[k] < 0) throw new Error(`expected-value: ${k} must be a non-negative number`);
  }
  if (!Number.isFinite(i.strength_score) || i.strength_score < 0 || i.strength_score > 100) {
    throw new Error('expected-value: strength_score must be between 0 and 100');
  }
  if (i.offer_fraction !== 0.3 && i.offer_fraction !== 0.5) {
    throw new Error('expected-value: offer_fraction must be 0.3 or 0.5');
  }
}

export function computeExpectedValue(inputs: EvInputs): EvResult {
  assertInputs(inputs);
  const cur = inputs.currency ?? 'USD';
  const m = (c: number) => formatMoney(c, cur);
  const A = Math.round(inputs.amount_cents);
  const F = Math.round(inputs.fee_cents);
  const T = Math.round(inputs.time_cost_cents);
  const C = Math.round(inputs.cogs_cents);
  const s = Math.round(inputs.strength_score) / 100;
  const o = inputs.offer_fraction;

  const fightCost = Math.round((1 - s) * (A + F) + T);
  const fight: EvOption = {
    action: 'FIGHT',
    label: 'Fight with evidence',
    expected_cost_cents: fightCost,
    formula: `(1 − ${s.toFixed(2)}) × (${m(A)} + ${m(F)}) + ${m(T)} = ${m(fightCost)}`,
    note: `s = ${s.toFixed(2)}: ${STRENGTH_LABEL}`,
  };

  const acceptCost = inputs.item_returned_on_accept ? Math.round(A + F - C * 0.5) : A + F;
  const accept: EvOption = {
    action: 'ACCEPT_CLAIM',
    label: 'Accept claim and refund',
    expected_cost_cents: acceptCost,
    formula: inputs.item_returned_on_accept
      ? `${m(A)} + ${m(F)} − ${m(C)} × 0.5 = ${m(acceptCost)}`
      : `${m(A)} + ${m(F)} = ${m(acceptCost)}`,
    note: inputs.item_returned_on_accept ? 'half resale value of returned item' : undefined,
  };

  const offerCost = Math.round(o * A + F * 0.5);
  const offer: EvOption = {
    action: 'MAKE_OFFER',
    label: `Offer ${Math.round(o * 100)}% partial refund (${m(Math.round(o * A))})`,
    expected_cost_cents: offerCost,
    formula: `${o} × ${m(A)} + ${m(F)} × 0.5 = ${m(offerCost)}`,
    note: 'assumes buyer accepts the offer',
  };

  const options = [fight, accept, offer];
  const recommended = options.reduce((best, opt) =>
    opt.expected_cost_cents < best.expected_cost_cents ? opt : best,
  ).action;

  return {
    inputs: { ...inputs, amount_cents: A, fee_cents: F, time_cost_cents: T, cogs_cents: C, currency: cur, s, s_label: STRENGTH_LABEL },
    options,
    recommended,
  };
}