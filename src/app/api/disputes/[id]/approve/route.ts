import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { checkSentences } from '@/lib/agent/citations';
import { getSourcesByKey } from '@/lib/repo/sources';
import { submitEvidence, SubmitError } from '@/lib/submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  run_id: z.string().min(1),
  edited_sentences: z.array(z.object({ id: z.string().min(1), text: z.string().min(1).max(2000) })).optional(),
});

type Row = Record<string, unknown>;
type Sentence = { id: string; text: string; source_ids: string[] };
type Draft = { sentences: Sentence[]; removed?: { id: string; text: string; reason: string }[] };

function fail(status: number, code: string, message: string, debug_id?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...(debug_id ? { debug_id } : {}), ...(extra ?? {}) } }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return fail(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'Invalid body');
  }

  const db = getDb();
  try {
    const dispute = db.prepare('SELECT id, source, status FROM disputes WHERE id = ?').get(id) as Row | undefined;
    if (!dispute) return fail(404, 'NOT_FOUND', `Dispute ${id} not found`);
    if (dispute.source === 'fixture') return fail(422, 'FIXTURE_READ_ONLY', 'Fixture history disputes cannot be submitted to PayPal.');

    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND dispute_id = ?').get(body.run_id, id) as Row | undefined;
    if (!run) return fail(404, 'NOT_FOUND', `Run ${body.run_id} not found for this dispute`);
    if (run.status !== 'draft_ready') {
      return fail(409, 'INVALID_STATE', `Run is ${run.status as string}; only a draft_ready run can be approved.`);
    }
    if (!run.draft_json) return fail(409, 'INVALID_STATE', 'Run has no draft');

    if (body.edited_sentences?.length) {
      const draft = JSON.parse(run.draft_json as string) as Draft;
      const byId = new Map(draft.sentences.map((s) => [s.id, s]));
      const edited: Sentence[] = [];
      for (const e of body.edited_sentences) {
        const orig = byId.get(e.id);
        if (!orig) return fail(400, 'BAD_REQUEST', `Unknown sentence id ${e.id}`);
        edited.push({ ...orig, text: e.text.trim() });
      }

      const result = checkSentences(edited, getSourcesByKey(body.run_id));
      if (result.failed.length > 0) {
        return fail(422, 'CITATION_FAILED', 'One or more edited sentences are not supported by their cited sources.', undefined, {
          failures: result.failed,
        });
      }

      const editedMap = new Map(edited.map((s) => [s.id, s]));
      const merged: Draft = { ...draft, sentences: draft.sentences.map((s) => editedMap.get(s.id) ?? s) };
      db.prepare('UPDATE agent_runs SET draft_json = ? WHERE id = ?').run(JSON.stringify(merged), body.run_id);
    }

    const result = await submitEvidence({ disputeId: id, runId: body.run_id });
    return NextResponse.json({
      decision_id: result.decision_id,
      status: result.status,
      paypal: result.paypal,
      elapsed_ms: result.elapsed_ms,
    });
  } catch (e) {
    if (e instanceof SubmitError) return NextResponse.json(e.toBody(), { status: e.httpStatus });
    const err = e as { message?: string; debugId?: string | null };
    return fail(502, 'PAYPAL_ERROR', err.message ?? String(e), err.debugId ?? undefined);
  }
}