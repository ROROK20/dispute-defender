import { describe, it, expect } from 'vitest';
import { STRENGTH_LABEL, computeExpectedValue, type EvInputs } from '../../src/lib/scoring/expected-value';

const base: EvInputs = {
  amount_cents: 6000,
  fee_cents: 0,
  time_cost_cents: 1500,
  cogs_cents: 2200,
  strength_score: 80,
  offer_fraction: 0.5,
  item_returned_on_accept: false,
};

function option(res: ReturnType<typeof computeExpectedValue>, action: string) {
  const opt = res.options.find((o) => o.action === action);
  if (!opt) throw new Error(`option ${action} missing`);
  return opt;
}

const cost = (res: ReturnType<typeof computeExpectedValue>, action: string) => option(res, action).expected_cost_cents;

describe('computeExpectedValue', () => {
  it('computes fight cost as (1 - s)(A + F) + T', () => {
    const res = computeExpectedValue(base);
    expect(cost(res, 'FIGHT')).toBe(Math.round(0.2 * 6000 + 1500));
    const withFee = computeExpectedValue({ ...base, fee_cents: 2000 });
    expect(cost(withFee, 'FIGHT')).toBe(Math.round(0.2 * (6000 + 2000) + 1500));
  });

  it('computes accept-claim cost as A + F', () => {
    const res = computeExpectedValue({ ...base, fee_cents: 2000 });
    expect(cost(res, 'ACCEPT_CLAIM')).toBe(8000);
  });

  it('subtracts half COGS on accept when the item returns to the seller', () => {
    const res = computeExpectedValue({ ...base, item_returned_on_accept: true });
    expect(cost(res, 'ACCEPT_CLAIM')).toBe(6000 - 1100);
    expect(option(res, 'ACCEPT_CLAIM').note).toBe('half resale value of returned item');
  });

  it('computes make-offer cost as o·A + F·0.5', () => {
    const res = computeExpectedValue({ ...base, fee_cents: 2000, offer_fraction: 0.3 });
    expect(cost(res, 'MAKE_OFFER')).toBe(Math.round(0.3 * 6000 + 1000));
    expect(option(res, 'MAKE_OFFER').note).toBe('assumes buyer accepts the offer');
  });

  it('recommends the cheapest option', () => {
    const strong = computeExpectedValue({ ...base, strength_score: 95 });
    // fight = 0.05*6000+1500 = 1800; offer = 3000; accept = 6000
    expect(strong.recommended).toBe('FIGHT');

    const weak = computeExpectedValue({ ...base, strength_score: 10 });
    // fight = 0.9*6000+1500 = 6900; offer = 3000; accept = 6000
    expect(weak.recommended).toBe('MAKE_OFFER');

    const cheapItemReturned = computeExpectedValue({
      ...base,
      amount_cents: 1000,
      cogs_cents: 1800,
      strength_score: 0,
      item_returned_on_accept: true,
    });
    // fight = 1000+1500 = 2500; accept = 1000-900 = 100; offer = 500
    expect(cheapItemReturned.recommended).toBe('ACCEPT_CLAIM');
  });

  it('returns a formula string with values filled in for each option', () => {
    const res = computeExpectedValue(base);
    expect(res.options.map((o) => o.action)).toEqual(['FIGHT', 'ACCEPT_CLAIM', 'MAKE_OFFER']);
    for (const o of res.options) {
      expect(typeof o.formula).toBe('string');
      expect(o.formula).toMatch(/\d/);
    }
    expect(option(res, 'FIGHT').formula).toBe('(1 − 0.80) × ($60.00 + $0.00) + $15.00 = $27.00');
    expect(option(res, 'ACCEPT_CLAIM').formula).toBe('$60.00 + $0.00 = $60.00');
    expect(option(res, 'MAKE_OFFER').formula).toBe('0.5 × $60.00 + $0.00 × 0.5 = $30.00');
  });

  it('labels s as a rough win proxy, not a probability', () => {
    const res = computeExpectedValue(base);
    expect(res.inputs.s).toBe(0.8);
    expect(res.inputs.s_label).toBe(STRENGTH_LABEL);
    expect(STRENGTH_LABEL).toBe('strength used as a rough win proxy, not a trained probability');
  });

  it('rejects inputs outside the model', () => {
    expect(() => computeExpectedValue({ ...base, strength_score: 101 })).toThrow(/strength_score/);
    expect(() => computeExpectedValue({ ...base, amount_cents: -1 })).toThrow(/amount_cents/);
  });

  it('is deterministic', () => {
    expect(computeExpectedValue(base)).toEqual(computeExpectedValue(base));
  });

  it('echoes its inputs', () => {
    const res = computeExpectedValue(base);
    expect(res.inputs).toMatchObject({ amount_cents: 6000, time_cost_cents: 1500, strength_score: 80, currency: 'USD' });
  });
});
