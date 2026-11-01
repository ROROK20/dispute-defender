import { describe, it, expect } from 'vitest';
import { countPatterns, quoteIsVerbatim } from '../../src/lib/patterns/mine';
import { THEMES } from '../../src/lib/patterns/themes';

const SNAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';

const disputes = [
  { id: 'F-1', sku: 'JT-114', reason: SNAD, source: 'fixture' },
  { id: 'F-2', sku: 'JT-114', reason: SNAD, source: 'fixture' },
  { id: 'F-3', sku: 'JT-114', reason: SNAD, source: 'fixture' },
  { id: 'F-4', sku: 'JT-114', reason: SNAD, source: 'fixture' },
  { id: 'F-5', sku: 'JT-114', reason: SNAD, source: 'fixture' },
  { id: 'PP-D-9', sku: 'JT-114', reason: SNAD, source: 'paypal_sandbox' },
  { id: 'F-7', sku: 'JT-101', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', source: 'fixture' },
];

const messages = [
  { dispute_id: 'F-1', message_ref: 'F-1#0', text: 'The dress runs two sizes small.' },
  { dispute_id: 'F-1', message_ref: 'F-1#1', text: 'Also the size chart said M fits me.' },
  { dispute_id: 'F-2', message_ref: 'F-2#0', text: 'Way too tight across the shoulders, sizing is off.' },
  { dispute_id: 'F-3', message_ref: 'F-3#0', text: 'Color looks nothing like the photo.' },
  { dispute_id: 'F-4', message_ref: 'F-4#0', text: 'Size label says L but it fits like an S.' },
  { dispute_id: 'F-5', message_ref: 'F-5#0', text: 'Fabric is thinner than described.' },
  { dispute_id: 'PP-D-9', message_ref: 'PP-D-9#0', text: 'Ordered my usual size and it is far too small.' },
  { dispute_id: 'F-7', message_ref: 'F-7#0', text: 'Never arrived, and I needed the size M.' },
];

const tags: Record<string, string[]> = {
  'F-1#0': ['sizing'],
  'F-1#1': ['sizing'],
  'F-2#0': ['sizing'],
  'F-3#0': ['color_mismatch'],
  'F-4#0': ['sizing'],
  'F-5#0': ['fabric_quality'],
  'PP-D-9#0': ['sizing'],
  'F-7#0': ['late_delivery', 'sizing'],
};

describe('themes', () => {
  it('is the closed list from the architecture', () => {
    expect([...THEMES].sort()).toEqual(
      ['color_mismatch', 'damaged', 'fabric_quality', 'late_delivery', 'not_recognized', 'sizing', 'wrong_item'].sort(),
    );
  });
});

describe('countPatterns', () => {
  const patterns = countPatterns(disputes, messages, tags);

  it('counts disputes (not messages) per (sku, reason, theme)', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.reason === SNAD && p.theme === 'sizing')!;
    expect(sizing).toBeDefined();
    expect(sizing.dispute_count).toBe(6);
    expect(sizing.matching_count).toBe(4);
    expect(sizing.headline).toContain('4 of 6');
  });

  it('does not leak tags across (sku, reason) groups', () => {
    const inrSizing = patterns.find((p) => p.sku === 'JT-101' && p.theme === 'sizing');
    if (inrSizing) {
      expect(inrSizing.dispute_count).toBe(1);
      expect(inrSizing.matching_count).toBe(1);
    }
    const snadSizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    expect(snadSizing.quotes.every((q) => q.dispute_id !== 'F-7')).toBe(true);
  });

  it('stores verbatim quotes tied to their message ids', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    const byRef = new Map(messages.map((m) => [m.message_ref, m.text]));
    expect(sizing.quotes.length).toBeGreaterThan(0);
    for (const q of sizing.quotes) {
      const text = byRef.get(q.message_ref);
      expect(text).toBeDefined();
      expect(text!.includes(q.quote)).toBe(true);
    }
  });

  it('flags groups that include fixture data', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    expect(sizing.includes_fixture).toBe(true);
  });

  it('ignores tags outside the closed theme list', () => {
    const extra = countPatterns(disputes, messages, { ...tags, 'F-3#0': ['made_up_theme'] });
    expect(extra.some((p) => (p.theme as string) === 'made_up_theme')).toBe(false);
  });

  it('is deterministic', () => {
    expect(countPatterns(disputes, messages, tags)).toEqual(countPatterns(disputes, messages, tags));
  });
});

describe('quoteIsVerbatim', () => {
  it('accepts exact substrings and rejects paraphrases', () => {
    expect(quoteIsVerbatim('runs two sizes small', 'The dress runs two sizes small.')).toBe(true);
    expect(quoteIsVerbatim('runs 2 sizes small', 'The dress runs two sizes small.')).toBe(false);
    expect(quoteIsVerbatim('', 'The dress runs two sizes small.')).toBe(false);
  });
});