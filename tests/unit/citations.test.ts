import { describe, it, expect } from 'vitest';
import { checkSentences } from '../../src/lib/agent/citations';

type Src = { source_key: string; kind: string; title: string; content: string; ref?: string | null };

function sources(list: Src[]): Record<string, Src> {
  const out: Record<string, Src> = {};
  for (const s of list) out[s.source_key] = s;
  return out;
}

const SOURCES = sources([
  {
    source_key: 'S1',
    kind: 'dispute_field',
    title: 'Dispute amount',
    content: 'Disputed amount: $64.00 USD. Reason: MERCHANDISE_OR_SERVICE_NOT_RECEIVED. Created 2026-10-20.',
  },
  {
    source_key: 'S2',
    kind: 'tracking_event',
    title: 'Tracker 9400111899223344556677 status DELIVERED',
    content: 'Tracking number 9400111899223344556677 status DELIVERED on 2026-10-14 to ZIP 97214. Signed by "M. Alvarez".',
  },
  {
    source_key: 'S3',
    kind: 'policy_clause',
    title: 'Returns policy §2',
    content: 'Items may be returned within 30 days of delivery for a full refund. Published 2026-01-05.',
  },
]);

describe('checkSentences', () => {
  it('passes sentences whose tokens all appear in a cited source', () => {
    const res = checkSentences(
      [
        { id: 'a', text: 'The buyer disputed $64.00 for this order.', source_ids: ['S1'] },
        { id: 'b', text: 'Tracking 9400111899223344556677 shows delivery on 2026-10-14.', source_ids: ['S2'] },
        { id: 'c', text: 'Our policy allows returns within 30 days.', source_ids: ['S3'] },
      ],
      SOURCES,
    );
    expect(res.failed).toEqual([]);
    expect(res.passed.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('fails a sentence with no citation', () => {
    const res = checkSentences([{ id: 'x', text: 'The item was delivered.', source_ids: [] }], SOURCES);
    expect(res.passed).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ id: 'x', reason: 'NO_CITATION' });
  });

  it('fails a sentence citing a source that does not exist in this run', () => {
    const res = checkSentences([{ id: 'x', text: 'The item was delivered.', source_ids: ['S9'] }], SOURCES);
    expect(res.failed[0]).toMatchObject({ id: 'x', reason: 'UNKNOWN_SOURCE' });
  });

  it('fails a sentence with a number not present in any cited source', () => {
    const res = checkSentences(
      [{ id: 'x', text: 'The buyer disputed $99.00 for this order.', source_ids: ['S1'] }],
      SOURCES,
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].reason).toBe('UNGROUNDED_TOKEN');
    expect(res.failed[0].token).toContain('99');
  });

  it('fails a tracking number that is only present in an uncited source', () => {
    const res = checkSentences(
      [{ id: 'x', text: 'Tracking 9400111899223344556677 confirms shipment.', source_ids: ['S1'] }],
      SOURCES,
    );
    expect(res.failed[0].reason).toBe('UNGROUNDED_TOKEN');
    expect(res.failed[0].token).toBe('9400111899223344556677');
  });

  it('fails a fabricated tracking number', () => {
    const res = checkSentences(
      [{ id: 'x', text: 'Tracking 9400999999999999999999 was delivered.', source_ids: ['S2'] }],
      SOURCES,
    );
    expect(res.failed[0].reason).toBe('UNGROUNDED_TOKEN');
  });

  it('checks quoted strings against cited sources', () => {
    const ok = checkSentences(
      [{ id: 'q1', text: 'The package was signed by "M. Alvarez".', source_ids: ['S2'] }],
      SOURCES,
    );
    expect(ok.failed).toEqual([]);

    const bad = checkSentences(
      [{ id: 'q2', text: 'The buyer wrote "I never ordered this".', source_ids: ['S2'] }],
      SOURCES,
    );
    expect(bad.failed[0].reason).toBe('UNGROUNDED_TOKEN');
  });

  it('normalizes case and whitespace when matching', () => {
    const res = checkSentences(
      [{ id: 'n', text: 'Signed by "m.   alvarez" at ZIP 97214.', source_ids: ['S2'] }],
      SOURCES,
    );
    expect(res.failed).toEqual([]);
  });

  it('accepts a token found in any one of several cited sources', () => {
    const res = checkSentences(
      [{ id: 'm', text: 'The $64.00 order was delivered to ZIP 97214.', source_ids: ['S1', 'S2'] }],
      SOURCES,
    );
    expect(res.failed).toEqual([]);
  });

  it('keeps passed and failed sentences separate and in order', () => {
    const res = checkSentences(
      [
        { id: '1', text: 'Returns are accepted within 30 days.', source_ids: ['S3'] },
        { id: '2', text: 'Returns are accepted within 60 days.', source_ids: ['S3'] },
        { id: '3', text: 'The order was delivered.', source_ids: ['S2'] },
      ],
      SOURCES,
    );
    expect(res.passed.map((s) => s.id)).toEqual(['1', '3']);
    expect(res.failed.map((s) => s.id)).toEqual(['2']);
  });
});