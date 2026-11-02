import { describe, it, expect } from 'vitest';
import { RUBRICS, reasonGroup, scoreEvidence, type StrengthContext } from '../../src/lib/scoring/strength';

const INR = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
const SNAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const UNAUTH = 'UNAUTHORISED';

const weightsByKey = (group: keyof typeof RUBRICS) => Object.fromEntries(RUBRICS[group].map((i) => [i.key, i.weight]));

/** Every INR rubric fact holds: tracker attached, delivered at the ship-to ZIP with a signature, shipped before the claim. */
const inrFull: StrengthContext = {
  dispute: { source_key: 'S1', created_at: '2026-10-20T00:00:00Z' },
  order: { source_key: 'S2', ship_to_postal_code: '97214-1234', captured_at: '2026-10-01T00:00:00Z' },
  tracker: { source_key: 'S3', tracking_number: '9400111899223344556677', status: 'SHIPPED' },
  carrier_events: [
    { source_key: 'S4', status: 'ACCEPTED', occurred_at: '2026-10-02T15:00:00Z' },
    { source_key: 'S5', status: 'DELIVERED', occurred_at: '2026-10-06T18:00:00Z', signature_name: 'M FENWICK', delivery_zip: '97214' },
  ],
};

/** Every SNAD rubric fact holds. */
const snadFull: StrengthContext = {
  order: { source_key: 'S2', sku: 'JT-114', captured_at: '2026-10-01T00:00:00Z' },
  sku: { source_key: 'S6', sku: 'JT-114', description: 'Midi wrap dress in washed linen.' },
  policies: [{ source_key: 'S7', slug: 'returns', published_at: '2026-01-15T00:00:00Z' }],
  messages: [
    { source_key: 'S8', posted_by: 'BUYER', time_posted: '2026-10-10T09:00:00Z', text: 'It runs two sizes small.' },
    { source_key: 'S9', posted_by: 'SELLER', time_posted: '2026-10-10T21:00:00Z', text: 'Sorry about that. We can accept a return under our policy.' },
  ],
  prior_snad_on_sku_90d: { count: 0, source_ids: ['S10'] },
};

/** Every UNAUTHORISED rubric fact holds. */
const unauthFull: StrengthContext = {
  order: { source_key: 'S2', ship_to_postal_code: '97214', captured_at: '2026-10-01T00:00:00Z' },
  carrier_events: [{ source_key: 'S5', status: 'DELIVERED', occurred_at: '2026-10-06T18:00:00Z', signature_name: 'M FENWICK', delivery_zip: '97214' }],
  prior_undisputed_orders: { count: 2, source_ids: ['S11'] },
};

describe('strength rubric', () => {
  it('maps PayPal reason codes to rubric groups', () => {
    expect(reasonGroup(INR)).toBe('INR');
    expect(reasonGroup(SNAD)).toBe('SNAD');
    expect(reasonGroup(UNAUTH)).toBe('UNAUTHORISED');
    expect(reasonGroup('UNAUTHORIZED')).toBe('UNAUTHORISED');
    expect(reasonGroup('CREDIT_NOT_PROCESSED')).toBe('OTHER');
  });

  it('has weights summing to 100 for every reason group', () => {
    for (const group of ['INR', 'SNAD', 'UNAUTHORISED', 'OTHER'] as const) {
      expect(RUBRICS[group].reduce((s, i) => s + i.weight, 0)).toBe(100);
    }
  });

  it('matches the published INR weights', () => {
    expect(weightsByKey('INR')).toEqual({
      tracking_attached: 25,
      carrier_delivered: 30,
      zip_match: 20,
      signature: 15,
      shipped_before_claim: 10,
    });
  });

  it('matches the published SNAD weights', () => {
    expect(weightsByKey('SNAD')).toEqual({
      description_match: 25,
      policy_before_purchase: 20,
      seller_responded_48h: 15,
      return_offered: 20,
      no_prior_snad: 20,
    });
  });

  it('matches the published UNAUTHORISED weights', () => {
    expect(weightsByKey('UNAUTHORISED')).toEqual({
      delivered_to_verified_address: 35,
      signature: 25,
      prior_orders: 20,
      delivery_confirmed: 20,
    });
  });

  it('scores 100 when every item is present and 0 when none are', () => {
    const cases: [string, StrengthContext][] = [
      [INR, inrFull],
      [SNAD, snadFull],
      [UNAUTH, unauthFull],
    ];
    for (const [reason, ctx] of cases) {
      const full = scoreEvidence(reason, ctx);
      expect(full.items.every((i) => i.present), `${reason}: ${JSON.stringify(full.items)}`).toBe(true);
      expect(full.score).toBe(100);
      expect(scoreEvidence(reason, {}).score).toBe(0);
    }
  });

  it('adds only the weights of present items', () => {
    // Tracker attached (25) and a delivered scan (30); no ZIP, signature or claim date to check.
    const res = scoreEvidence(INR, {
      tracker: { source_key: 'S1', tracking_number: '9400111899223344556677', status: 'SHIPPED' },
      carrier_events: [{ source_key: 'S2', status: 'DELIVERED' }],
    });
    expect(res.items.filter((i) => i.present).map((i) => i.key).sort()).toEqual(['carrier_delivered', 'tracking_attached']);
    expect(res.score).toBe(55);
  });

  it('reports a breakdown item per rubric line with its source ids', () => {
    const res = scoreEvidence(UNAUTH, { prior_undisputed_orders: { count: 3, source_ids: ['S3', 'S4'] } });
    expect(res.items.map((i) => i.key)).toEqual(RUBRICS.UNAUTHORISED.map((i) => i.key));
    const item = res.items.find((i) => i.key === 'prior_orders')!;
    expect(item.present).toBe(true);
    expect(item.source_ids).toEqual(['S3', 'S4']);
    expect(item.weight).toBe(20);
    expect(typeof item.label).toBe('string');
    for (const other of res.items.filter((i) => i.key !== 'prior_orders')) {
      expect(other.present).toBe(false);
      expect(other.source_ids).toEqual([]);
    }
    expect(res.score).toBe(20);
  });

  it('cites the sources that prove each present item', () => {
    const items = Object.fromEntries(scoreEvidence(INR, inrFull).items.map((i) => [i.key, i.source_ids]));
    expect(items.tracking_attached).toEqual(['S3']);
    expect(items.carrier_delivered).toEqual(['S5']);
    expect(items.zip_match).toEqual(['S5', 'S2']);
    expect(items.signature).toEqual(['S5']);
    expect(items.shipped_before_claim).toEqual(['S4', 'S1']);
  });

  it('withholds INR credit when the facts do not line up', () => {
    const res = scoreEvidence(INR, {
      ...inrFull,
      order: { ...inrFull.order!, ship_to_postal_code: '10001' },
      dispute: { source_key: 'S1', created_at: '2026-10-01T00:00:00Z' },
    });
    const present = Object.fromEntries(res.items.map((i) => [i.key, i.present]));
    expect(present.zip_match).toBe(false);
    expect(present.shipped_before_claim).toBe(false);
    expect(res.score).toBe(100 - 20 - 10);
  });

  it('withholds SNAD credit for a slow reply, a late policy and prior SNAD claims', () => {
    const res = scoreEvidence(SNAD, {
      ...snadFull,
      policies: [{ source_key: 'S7', slug: 'returns', published_at: '2026-10-05T00:00:00Z' }],
      messages: [
        { source_key: 'S8', posted_by: 'BUYER', time_posted: '2026-10-10T09:00:00Z', text: 'It runs two sizes small.' },
        { source_key: 'S9', posted_by: 'SELLER', time_posted: '2026-10-13T09:00:00Z', text: 'We can accept a return.' },
      ],
      prior_snad_on_sku_90d: { count: 2, source_ids: ['S10'] },
    });
    const present = Object.fromEntries(res.items.map((i) => [i.key, i.present]));
    expect(present.policy_before_purchase).toBe(false);
    expect(present.seller_responded_48h).toBe(false);
    expect(present.no_prior_snad).toBe(false);
    expect(present.description_match).toBe(true);
    expect(present.return_offered).toBe(true);
    expect(res.score).toBe(25 + 20);
  });

  it('treats a missing signal as absent', () => {
    const res = scoreEvidence(INR, {});
    expect(res.score).toBe(0);
    expect(res.items.every((i) => !i.present && i.source_ids.length === 0)).toBe(true);
  });

  it('is deterministic', () => {
    expect(scoreEvidence(SNAD, snadFull)).toEqual(scoreEvidence(SNAD, snadFull));
  });
});
