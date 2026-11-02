import { describe, it, expect } from 'vitest';
import {
  countPatterns,
  groupDisputes,
  isVerbatimQuote,
  keywordTagger,
  mineFromDisputes,
  type MessageTag,
  type MinerDispute,
} from '../../src/lib/patterns/mine';
import { THEMES, type Theme } from '../../src/lib/patterns/themes';

const SNAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const INR = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';

function dispute(id: string, sku: string, reason: string, source: string, texts: string[]): MinerDispute {
  return {
    id,
    sku,
    sku_name: sku === 'JT-114' ? 'Linen Wrap Dress' : null,
    reason,
    source,
    messages: texts.map((text, i) => ({ dispute_id: id, message_ref: `${id}#${i}`, posted_by: 'BUYER', text })),
  };
}

const disputes: MinerDispute[] = [
  dispute('F-1', 'JT-114', SNAD, 'fixture', ['The dress runs two sizes small.', 'Also the size chart said M fits me.']),
  dispute('F-2', 'JT-114', SNAD, 'fixture', ['Way too tight across the shoulders, sizing is off.']),
  dispute('F-3', 'JT-114', SNAD, 'fixture', ['Color looks nothing like the photo.']),
  dispute('F-4', 'JT-114', SNAD, 'fixture', ['Size label says L but it fits like an S.']),
  dispute('F-5', 'JT-114', SNAD, 'fixture', ['Fabric is thinner than described.']),
  dispute('PP-D-9', 'JT-114', SNAD, 'paypal_sandbox', ['Ordered my usual size and it is far too small.']),
  dispute('F-7', 'JT-101', INR, 'fixture', ['Never arrived, and I needed the size M.']),
];

/** What the model returns: themes per message plus a quote per theme (copied verbatim). */
const tagSpec: Record<string, [Theme, string][]> = {
  'F-1#0': [['sizing', 'runs two sizes small']],
  'F-1#1': [['sizing', 'the size chart said M fits me']],
  'F-2#0': [['sizing', 'sizing is off']],
  'F-3#0': [['color_mismatch', 'Color looks nothing like the photo']],
  'F-4#0': [['sizing', 'it fits like an S']],
  'F-5#0': [['fabric_quality', 'Fabric is thinner than described']],
  'PP-D-9#0': [['sizing', 'far too small']],
  'F-7#0': [
    ['late_delivery', 'Never arrived'],
    ['sizing', 'I needed the size M'],
  ],
};

function tagsFrom(spec: Record<string, [Theme, string][]>): MessageTag[] {
  return Object.entries(spec).map(([ref, pairs]) => ({
    dispute_id: ref.split('#')[0],
    message_ref: ref,
    themes: pairs.map(([t]) => t),
    quotes: Object.fromEntries(pairs),
  }));
}

const tags = tagsFrom(tagSpec);
const NOW = () => new Date('2026-10-28T12:00:00Z');

describe('themes', () => {
  it('is the closed list from the architecture', () => {
    expect([...THEMES].sort()).toEqual(
      ['color_mismatch', 'damaged', 'fabric_quality', 'late_delivery', 'not_recognized', 'sizing', 'wrong_item'].sort(),
    );
  });
});

describe('groupDisputes', () => {
  it('groups by (sku, reason) deterministically', () => {
    const groups = groupDisputes(disputes);
    expect(groups.map((g) => [g.sku, g.reason, g.disputes.length])).toEqual([
      ['JT-101', INR, 1],
      ['JT-114', SNAD, 6],
    ]);
    expect(groupDisputes([...disputes].reverse())).toEqual(groups);
  });
});

describe('countPatterns', () => {
  const patterns = countPatterns(groupDisputes(disputes), tags, { now: NOW });

  it('counts disputes (not messages) per (sku, reason, theme)', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.reason === SNAD && p.theme === 'sizing')!;
    expect(sizing).toBeDefined();
    expect(sizing.dispute_count).toBe(6);
    // F-1 has two sizing messages and still counts once.
    expect(sizing.matching_count).toBe(4);
    expect(sizing.headline).toBe('4 of 6 SNAD claims on JT-114 mention sizing');
    expect(sizing.action).toContain('JT-114');
  });

  it('does not report a theme below the matching threshold', () => {
    expect(patterns.some((p) => p.theme === 'color_mismatch' || p.theme === 'fabric_quality')).toBe(false);
  });

  it('does not leak tags across (sku, reason) groups', () => {
    // F-7 is the only JT-101 INR dispute, so its sizing tag stays in its own group (too small to report).
    expect(patterns.some((p) => p.sku === 'JT-101')).toBe(false);
    const snadSizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    expect(snadSizing.quotes.every((q) => q.dispute_id !== 'F-7')).toBe(true);
  });

  it('stores verbatim quotes tied to their message ids', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    const byRef = new Map(disputes.flatMap((d) => d.messages.map((m) => [m.message_ref, m.text] as const)));
    expect(sizing.quotes.map((q) => q.dispute_id)).toEqual(['F-1', 'F-2', 'F-4', 'PP-D-9']);
    for (const q of sizing.quotes) {
      const text = byRef.get(q.message_ref);
      expect(text).toBeDefined();
      expect(text!.includes(q.quote)).toBe(true);
    }
  });

  it('counts a tagged dispute but drops a quote that is not verbatim', () => {
    const paraphrased = tagsFrom({ ...tagSpec, 'F-2#0': [['sizing', 'the sizing was wrong']] });
    const sizing = countPatterns(groupDisputes(disputes), paraphrased, { now: NOW }).find((p) => p.theme === 'sizing')!;
    expect(sizing.matching_count).toBe(4);
    expect(sizing.quotes.some((q) => q.dispute_id === 'F-2')).toBe(false);
  });

  it('flags groups that include fixture data', () => {
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    expect(sizing.includes_fixture).toBe(true);
    const liveOnly = disputes.filter((d) => d.sku === 'JT-114').map((d) => ({ ...d, source: 'paypal_sandbox' }));
    const live = countPatterns(groupDisputes(liveOnly), tags, { now: NOW }).find((p) => p.theme === 'sizing')!;
    expect(live.includes_fixture).toBe(false);
  });

  it('ignores tags outside the closed theme list', () => {
    const bogus = tags.map((t) =>
      t.message_ref === 'F-3#0' ? { ...t, themes: ['made_up_theme' as unknown as Theme], quotes: {} } : t,
    );
    const extra = countPatterns(groupDisputes(disputes), bogus, { now: NOW });
    expect(extra.some((p) => (p.theme as string) === 'made_up_theme')).toBe(false);
  });

  it('ignores tags on messages that do not belong to the dispute', () => {
    const stray: MessageTag = { dispute_id: 'F-5', message_ref: 'F-5#99', themes: ['sizing'], quotes: {} };
    const sizing = countPatterns(groupDisputes(disputes), [...tags, stray], { now: NOW }).find((p) => p.theme === 'sizing')!;
    expect(sizing.matching_count).toBe(4);
  });

  it('is deterministic', () => {
    expect(countPatterns(groupDisputes(disputes), tags, { now: NOW })).toEqual(
      countPatterns(groupDisputes(disputes), tags, { now: NOW }),
    );
  });
});

describe('mineFromDisputes with the deterministic tagger (mock mode)', () => {
  it('finds the same 4 of 6 sizing pattern with verbatim quotes', async () => {
    const patterns = await mineFromDisputes(disputes, keywordTagger, { now: NOW });
    const sizing = patterns.find((p) => p.sku === 'JT-114' && p.theme === 'sizing')!;
    expect(sizing.headline).toBe('4 of 6 SNAD claims on JT-114 mention sizing');
    const byRef = new Map(disputes.flatMap((d) => d.messages.map((m) => [m.message_ref, m.text] as const)));
    for (const q of sizing.quotes) expect(byRef.get(q.message_ref)!.includes(q.quote)).toBe(true);
  });
});

describe('isVerbatimQuote', () => {
  it('accepts exact substrings and rejects paraphrases', () => {
    expect(isVerbatimQuote('runs two sizes small', 'The dress runs two sizes small.')).toBe(true);
    expect(isVerbatimQuote('runs 2 sizes small', 'The dress runs two sizes small.')).toBe(false);
    expect(isVerbatimQuote('', 'The dress runs two sizes small.')).toBe(false);
  });

  it('tolerates only case and whitespace differences', () => {
    expect(isVerbatimQuote('RUNS  two\nsizes small', 'The dress runs two sizes small.')).toBe(true);
    expect(isVerbatimQuote('runs two sizes smaller', 'The dress runs two sizes small.')).toBe(false);
  });
});
