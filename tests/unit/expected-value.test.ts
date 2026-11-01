import { describe, it, expect } from 'vitest';
import { computeExpectedValue } from '../../src/lib/scoring/expected-value';

const base = {
  amount_cents: 6000,
  fee_cents: 0,
  time_cost_cents: 1500,
  cogs_cents: 2200,
  strength: 80,
  offer_fraction: 0.5,
  return_to_seller: false,
};

function cost(res: ReturnType<typeof computeExpectedValue>, action: string): number {
  const opt = res.options.find((o) => o.action === action);
  if (!opt) throw new Error(`option ${action} missing`);
  return opt.expected_cost_cents;
}

describe('computeExpectedValue', () => {
  it('computes fight cost as (1 - s)(A + F) + T', () => {
    const res = computeExpectedValue(base);
    expect(cost(res, 'FIGHT')).toBe(Math.round(0.2 * 6000 + 1500));
  });

  it('computes accept-claim cost as A + F', () => {
    const res = computeExpectedValue({ ...base, fee_cents: 2000 });
    expect(cost(res, 'ACCEPT_CLAIM')).toBe(8000);
  });

  it('subtracts half COGS on accept when the item returns to the seller', () => {
    const res = computeExpectedValue({ ...base, return_to_seller: true });
    expect(cost(res, 'ACCEPT_CLAIM')).toBe(6000 - 1100);
  });

  it('computes make-offer cost as o·A + F·0.5', () => {
    const res = computeExpectedValue({ ...base, fee_cents: 2000, offer_fraction: 0.3 });
    expect(cost(res, 'MAKE_OFFER')).toBe(Math.round(0.3 * 6000 + 1000));
  });

  it('recommends the cheapest option', () => {
    const strong = computeExpectedValue({ ...base, strength: 95 });
    // fight = 0.05*6000+1500 = 1800; offer = 3000; accept = 6000
    expect(strong.recommended).toBe('FIGHT');

    const weak = computeExpectedValue({ ...base, strength: 10 });
    // fight = 0.9*6000+1500 = 6900; offer = 3000; accept = 6000
    expect(weak.recommended).toBe('MAKE_OFFER');
  });

  it('returns a formula string with values filled in for each option', () => {
    const res = computeExpectedValue(base);
    expect(res.options).toHaveLength(3);
    for (const o of res.options) {
      expect(typeof o.formula).toBe('string');
      expect(o.formula.length).toBeGreaterThan(0);
      expect(o.formula).toMatch(/\d/);
    }
    const fight = res.options.find((o) => o.action === 'FIGHT')!;
    expect(fight.formula).toContain('0.8');
  });

  it('is deterministic', () => {
    expect(computeExpectedValue(base)).toEqual(computeExpectedValue(base));
  });

  it('echoes its inputs', () => {
    const res = computeExpectedValue(base);
    expect(res.inputs).toMatchObject({ amount_cents: 6000, time_cost_cents: 1500 });
  });
});