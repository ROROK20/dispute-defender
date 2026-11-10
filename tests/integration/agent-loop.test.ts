import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { fixtureShiftDays, shiftIso } from '../../src/lib/fixture-clock';

/**
 * The runner's guard rails, driven by a scripted fake model (the real tools run
 * against the PayPal mock adapter). The happy path is covered by
 * agent-run.mock.test.ts; this covers what a live model can get wrong: a
 * text-only turn, a malformed submit, sentences that fail the citation check
 * (one repairable, two not), a recommendation that disagrees with the math,
 * disallowed or fabricated evidence-plan entries, an ungrounded buyer message,
 * and a review pass that changes a fact.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-loop-'));
process.env.PAYPAL_MOCK = '1';
process.env.ANTHROPIC_MOCK = '1';
process.env.PAYPAL_ENV = 'sandbox';
process.env.REVIEW_ENABLED = 'true';
process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');

const DISPUTE_ID = 'PP-D-LOOP-INR';
// Mock fixtures move to the seed day (src/lib/fixture-clock.ts); the carrier's delivery scan is 2026-10-13 in the fixture file.
const DELIVERED_ON = shiftIso('2026-10-13', fixtureShiftDays());
const DAY_AFTER = shiftIso('2026-10-14', fixtureShiftDays());
const RUN_ID = 'run_loop_test';
let db: Database.Database;

type Block = Record<string, unknown>;
const msg = (content: Block[], stop: string) =>
  ({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as never;
const tool = (name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_${name}_${Math.random().toString(36).slice(2)}`, name, input });

beforeAll(async () => {
  const { getDb } = await import('../../src/lib/db');
  db = getDb();
  const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/fixtures/mock-paypal/dispute-inr.json'), 'utf8'));
  const raw = { ...fixture, dispute_id: DISPUTE_ID };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO disputes (id,source,reason,status,amount_cents,currency,seller_response_due_at,last_synced_at,raw_json,capture_id,pp_created_at)
     VALUES (?, 'paypal_sandbox', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'WAITING_FOR_SELLER_RESPONSE', 6800, 'USD', ?, ?, ?, ?, ?)`,
  ).run(DISPUTE_ID, '2029-12-31T23:59:59.000Z', now, JSON.stringify(raw), raw.disputed_transactions[0].seller_transaction_id, raw.create_time);
  db.prepare(
    `INSERT INTO agent_runs (id,dispute_id,status,clock_started_at,model_agent,model_review) VALUES (?,?,'queued',?,'fake','fake-review')`,
  ).run(RUN_ID, DISPUTE_ID, now);
});

afterAll(() => {
  try {
    db?.close();
  } catch {
    /* closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runner guard rails with a scripted fake model', () => {
  it('nudges, rejects a bad submit, repairs then removes unsupported sentences, and keeps the computed numbers', async () => {
    const { runAgent } = await import('../../src/lib/agent/runner');
    const { listSources } = await import('../../src/lib/repo/sources');
    const calls = { repair: 0, review: 0 };

    await runAgent(RUN_ID, {
      model: (ctx) => async (req) => {
        const names = req.tools.map((t) => t.name);
        const sources = listSources(ctx.runId);
        const tracker = sources.find((s) => s.title.startsWith('PayPal tracker'))!;
        const delivered = sources.find((s) => s.title.startsWith('Carrier fixture: DELIVERED'))!;

        if (names.includes('revise_sentences')) {
          calls.repair++;
          return msg(
            [tool('revise_sentences', { sentences: [{ id: 's2', text: `The carrier recorded delivery on ${DELIVERED_ON}.`, source_ids: [delivered.source_key] }] })],
            'tool_use',
          );
        }
        if (names.includes('submit_review')) {
          calls.review++;
          return msg(
            [tool('submit_review', { sentences: [
              { id: 's1', text: 'Tracking number 9400999999999999999999 is attached to this PayPal transaction.' },
              { id: 's2', text: `The carrier recorded delivery on ${DELIVERED_ON}.` },
            ] })],
            'tool_use',
          );
        }

        const turn = req.messages.filter((m) => m.role === 'assistant').length;
        if (turn === 0) return msg([{ type: 'text', text: 'Let me think about this dispute first.' }], 'end_turn');
        if (turn === 1) {
          return msg(
            [
              tool('get_dispute', { dispute_id: DISPUTE_ID }),
              tool('get_transaction', { capture_id: '7MS50287AX193722H' }),
              tool('get_tracking', { capture_id: '7MS50287AX193722H' }),
            ],
            'tool_use',
          );
        }
        if (turn === 2) return msg([tool('submit_analysis', { recommendation: 'FIGHT', sentences: [] })], 'tool_use');
        return msg(
          [
            tool('submit_analysis', {
              classification: { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', sub_theme: 'parcel not received', evidence_needed: [] },
              recommendation: 'ACCEPT_CLAIM',
              recommendation_rationale: [],
              evidence_plan: [
                { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'tracking', tracking_number: '9400111899223344556677', carrier: 'USPS' },
                { evidence_type: 'ITEM_DESCRIPTION', notes: 'not allowed for INR' },
                { evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', notes: 'sig', tracking_number: 'FAKE1234567890' },
              ],
              sentences: [
                { id: 's1', text: 'Tracking number 9400111899223344556677 is attached to this PayPal transaction.', source_ids: [tracker.source_key] },
                { id: 's2', text: `The carrier recorded delivery on ${DAY_AFTER}.`, source_ids: [delivered.source_key] },
                { id: 's3', text: 'The buyer has disputed $999.00 with us before.', source_ids: ['S1'] },
                { id: 's4', text: 'We always ship promptly.', source_ids: [] },
              ],
              buyer_message: { text: 'We will refund $5.00 today.', source_ids: ['S1'] },
            }),
          ],
          'tool_use',
        );
      },
    });

    const run = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(RUN_ID) as Record<string, unknown>;
    expect(run.error ?? null).toBeNull();
    expect(run.status).toBe('draft_ready');

    // The computed recommendation wins over the model's.
    const ev = JSON.parse(String(run.ev_json));
    expect(run.recommendation).toBe(ev.recommended);
    expect(run.recommendation).not.toBe('ACCEPT_CLAIM');

    // s2 repaired, s3 and s4 removed after two repair rounds.
    const draft = JSON.parse(String(run.draft_json));
    expect(draft.sentences.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
    expect(draft.sentences[1].text).toContain(DELIVERED_ON);
    expect(draft.removed.map((r: { id: string; reason: string }) => [r.id, r.reason])).toEqual([
      ['s3', 'UNGROUNDED_TOKEN'],
      ['s4', 'NO_CITATION'],
    ]);
    expect(draft.buyer_message).toBeUndefined();
    const check = JSON.parse(String(run.citation_check_json));
    expect(check.rounds).toBe(2);
    expect(check.passed).toBe(false);
    expect(calls.repair).toBe(2);

    // The review changed a tracking number, so it was discarded.
    expect(calls.review).toBe(1);
    expect(run.review_applied).toBe(0);
    expect(draft.sentences[0].text).toContain('9400111899223344556677');

    // Disallowed type dropped; fabricated tracking number stripped.
    const plan = JSON.parse(String(run.evidence_plan_json));
    expect(plan).toEqual([
      { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'tracking', tracking_number: '9400111899223344556677', carrier: 'USPS' },
      { evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', notes: 'sig' },
    ]);

    const labels = (db.prepare(`SELECT label FROM agent_steps WHERE run_id = ? ORDER BY seq`).all(RUN_ID) as { label: string }[]).map(
      (s) => s.label,
    );
    expect(labels.some((l) => l.startsWith('Model: Let me think'))).toBe(true);
    expect(labels.some((l) => l.includes('submit_analysis rejected'))).toBe(true);
    expect(labels.some((l) => l.includes('the expected-value math recommends'))).toBe(true);
    expect(labels.some((l) => l.includes('dropped ITEM_DESCRIPTION'))).toBe(true);
    expect(labels.some((l) => l.includes('removed tracking number FAKE1234567890'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Review discarded'))).toBe(true);
    expect(Number(run.input_tokens)).toBeGreaterThan(0);
  });
});
