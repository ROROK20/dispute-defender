import type Anthropic from '@anthropic-ai/sdk';
import { toolUses, type ModelFn } from './anthropic';
import { checkSentences, type CitationFailure } from './citations';
import { REVIEW_SYSTEM, reviewPrompt } from './prompts';
import { REVIEW_JSON_SCHEMA, ReviewSchema, formatZodIssues, type Sentence } from './schemas';
import type { Source } from '../repo/sources';

/**
 * Optional review pass (ARCHITECTURE C7). The review model may only reword:
 * same sentence ids, same order, and the citations are carried over from the
 * draft, never taken from the reviewer. The reworded letter goes back through
 * the citation checker; if any sentence fails, the whole review is discarded
 * and the checked draft is kept.
 */

export const REVIEW_TOOL: Anthropic.Tool = {
  name: 'submit_review',
  description: 'Submit the reworded letter: one entry per input sentence, same ids, same order.',
  input_schema: REVIEW_JSON_SCHEMA,
};

export type ReviewOutcome =
  | { status: 'applied'; sentences: Sentence[]; changed: number }
  | { status: 'discarded'; reason: string; failures?: CitationFailure[] };

export async function reviewDraft(opts: {
  model: ModelFn;
  sentences: Sentence[];
  sourcesByKey: Record<string, Source>;
  timeoutMs?: number;
}): Promise<ReviewOutcome> {
  const { model, sentences, sourcesByKey } = opts;
  const citedKeys = Array.from(new Set(sentences.flatMap((s) => s.source_ids)));
  const cited = citedKeys.map((k) => sourcesByKey[k]).filter((s): s is Source => Boolean(s));

  const message = await model({
    role: 'review',
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: reviewPrompt(sentences, cited) }],
    tools: [REVIEW_TOOL],
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  const call = toolUses(message).find((b) => b.name === 'submit_review');
  if (!call) return { status: 'discarded', reason: 'The reviewer did not call submit_review.' };
  const parsed = ReviewSchema.safeParse(call.input);
  if (!parsed.success) return { status: 'discarded', reason: `Reviewer output was malformed:\n${formatZodIssues(parsed.error)}` };

  const reworded = parsed.data.sentences;
  const sameIds =
    reworded.length === sentences.length && reworded.every((r, i) => r.id === sentences[i].id);
  if (!sameIds) return { status: 'discarded', reason: 'The reviewer changed the sentence ids, order or count.' };

  const candidate: Sentence[] = sentences.map((s, i) => ({ ...s, text: reworded[i].text }));
  const check = checkSentences(candidate, sourcesByKey);
  if (check.failed.length > 0) {
    return { status: 'discarded', reason: `${check.failed.length} reworded sentence(s) failed the citation check.`, failures: check.failed };
  }
  const changed = candidate.filter((s, i) => s.text !== sentences[i].text).length;
  return { status: 'applied', sentences: candidate, changed };
}
