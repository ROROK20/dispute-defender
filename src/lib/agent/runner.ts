import type Anthropic from '@anthropic-ai/sdk';
import { emitDone, emitStatus, emitStep } from '../bus';
import { getEnv, isAnthropicMock } from '../env';
import { allowedEvidenceTypes } from '../paypal/evidence-rules';
import { getDispute as getLocalDispute, setDisputeAssessment } from '../repo/disputes';
import { addRunTokens, getRun, markRunDraftReady, markRunStarted } from '../repo/runs';
import { getSourcesByKey, listSources, type Source } from '../repo/sources';
import { appendStep, toStepEvent, type StepKind } from '../repo/steps';
import { assistantTurn, createMessage, textOf, toolUses, type ModelFn } from './anthropic';
import { checkSentences, normalizeText, type CitationFailure } from './citations';
import { createMockModel } from './mock-agent';
import { playbookFor } from './playbooks';
import {
  FINALIZE_NUDGE,
  NO_TOOL_NUDGE,
  REPAIR_SYSTEM,
  TRUNCATED_NUDGE,
  agentKickoff,
  agentSystemPrompt,
  repairPrompt,
} from './prompts';
import { reviewDraft } from './review';
import {
  REVISE_SENTENCES_JSON_SCHEMA,
  ReviseSentencesSchema,
  SubmitAnalysisSchema,
  formatZodIssues,
  submitAnalysisJsonSchema,
  type CitedText,
  type EvidencePlanItem,
  type Sentence,
  type SubmitAnalysis,
} from './schemas';
import { AGENT_TOOLS, createAgentContext, executeTool, runExpectedValue, runScore, type AgentContext } from './tools';

/**
 * The agent run (ARCHITECTURE C5–C7). Claude investigates with read-only
 * tools, then calls submit_analysis. The runner, not the model, decides
 * what is stored: the strength score and the expected-value recommendation
 * are computed in code, the evidence plan is filtered to what the reason code
 * allows, and every letter sentence must pass the citation checker (with up
 * to two repair rounds) or it is removed. Every step is written to
 * agent_steps before it is emitted to the live trace.
 *
 * Nothing in a run calls a mutating PayPal endpoint; the seller approves
 * every submission separately (submit.ts).
 */

export const MAX_TURNS = 12;
export const FINALIZE_TURN = 10;
export const LOOP_BUDGET_MS = 90_000;
const FINALIZE_AT_MS = 70_000;
export const MAX_REPAIR_ROUNDS = 2;

export const SUBMIT_TOOL_NAME = 'submit_analysis';
const REVISE_TOOL: Anthropic.Tool = {
  name: 'revise_sentences',
  description: 'Return repaired letter sentences (same ids). Leave out any sentence that cannot be supported.',
  input_schema: REVISE_SENTENCES_JSON_SCHEMA,
};

type StepLogger = (kind: StepKind, label: string, payload?: unknown, durationMs?: number | null) => void;

function stepLogger(runId: string): StepLogger {
  return (kind, label, payload, durationMs) => {
    const step = appendStep(runId, { kind, label, payload, duration_ms: durationMs ?? null });
    emitStep(runId, toStepEvent(step));
  };
}

function short(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function inputLabel(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const args = Object.entries(obj)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${name}(${args})`;
}

function captureIdFor(ctx: AgentContext): string | null {
  const raw = (ctx.dispute.raw ?? {}) as { disputed_transactions?: { seller_transaction_id?: string }[] };
  return ctx.dispute.capture_id ?? raw.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id ?? null;
}

/** The tool loop: returns a schema-valid submit_analysis input or throws. */
async function investigate(ctx: AgentContext, model: ModelFn, log: StepLogger): Promise<SubmitAnalysis> {
  const playbook = playbookFor(ctx.dispute.reason);
  const tools: Anthropic.Tool[] = [
    ...AGENT_TOOLS,
    {
      name: SUBMIT_TOOL_NAME,
      description:
        'Submit the final analysis: classification, recommendation, evidence plan and the response letter as cited sentences. Call it exactly once, as your last action.',
      input_schema: submitAnalysisJsonSchema(playbook.evidenceTypes),
    },
  ];
  const system = agentSystemPrompt(playbook);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: agentKickoff(ctx.dispute, captureIdFor(ctx)) }];
  const started = Date.now();
  let nudged = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const elapsed = Date.now() - started;
    if (elapsed >= LOOP_BUDGET_MS) {
      throw new Error(`The agent used its ${LOOP_BUDGET_MS / 1000} s budget without submitting an analysis.`);
    }
    if (!nudged && (turn >= FINALIZE_TURN || elapsed >= FINALIZE_AT_MS)) {
      nudged = true;
      const last = messages[messages.length - 1];
      const blocks: Anthropic.ContentBlockParam[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
      blocks.push({ type: 'text', text: FINALIZE_NUDGE });
      messages[messages.length - 1] = { role: 'user', content: blocks };
      log('info', `Turn ${turn}: asking the model to submit now (budget nearly used)`);
    }

    const t0 = Date.now();
    const msg = await model({
      role: 'agent',
      system,
      messages,
      tools,
      timeoutMs: Math.max(10_000, LOOP_BUDGET_MS - elapsed),
    });
    addRunTokens(ctx.runId, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
    messages.push(assistantTurn(msg));

    const note = textOf(msg);
    if (note) log('info', `Model: ${short(note)}`, { text: note }, Date.now() - t0);

    const calls = toolUses(msg);
    if (calls.length === 0) {
      messages.push({ role: 'user', content: msg.stop_reason === 'max_tokens' ? TRUNCATED_NUDGE : NO_TOOL_NUDGE });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let analysis: SubmitAnalysis | null = null;
    for (const call of calls) {
      if (call.name === SUBMIT_TOOL_NAME) {
        const parsed = SubmitAnalysisSchema.safeParse(call.input);
        if (parsed.success) {
          analysis = parsed.data;
          log('decision', `submit_analysis received: ${parsed.data.sentences.length} sentence(s), recommends ${parsed.data.recommendation}`, {
            classification: parsed.data.classification,
            recommendation: parsed.data.recommendation,
            evidence_plan: parsed.data.evidence_plan,
          });
        } else {
          const issues = formatZodIssues(parsed.error);
          log('check', 'submit_analysis rejected: it does not match the schema', { issues });
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Invalid submit_analysis input:\n${issues}\nFix these and call submit_analysis again.` });
        }
        continue;
      }
      log('tool_call', inputLabel(call.name, call.input), { tool: call.name, input: call.input });
      const t1 = Date.now();
      const outcome = await executeTool(ctx, call.name, call.input);
      log(outcome.isError ? 'error' : 'tool_result', outcome.summary, {
        tool: call.name,
        source_keys: outcome.sources.map((s) => s.source_key),
        titles: outcome.sources.map((s) => s.title),
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      }, Date.now() - t1);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    if (analysis) return analysis;
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`The agent used all ${MAX_TURNS} turns without submitting a valid analysis.`);
}

/** Up to MAX_REPAIR_ROUNDS model repairs of failed sentences; whatever still fails is removed. */
async function checkAndRepair(
  ctx: AgentContext,
  model: ModelFn,
  log: StepLogger,
  draft: Sentence[],
): Promise<{ sentences: Sentence[]; removed: CitationFailure[]; rounds: number; checked: number }> {
  const byKey = getSourcesByKey(ctx.runId);
  let current = draft;
  let check = checkSentences(current, byKey);
  log('check', `Citation check: ${check.passed.length} of ${current.length} sentence(s) grounded in their sources`, {
    failures: check.failed,
    source_ids: Array.from(new Set(current.flatMap((s) => s.source_ids))),
  });

  let rounds = 0;
  while (check.failed.length > 0 && rounds < MAX_REPAIR_ROUNDS) {
    rounds++;
    const t0 = Date.now();
    let revised: Sentence[] = [];
    try {
      const msg = await model({
        role: 'agent',
        system: REPAIR_SYSTEM,
        messages: [{ role: 'user', content: repairPrompt(check.failed, listSources(ctx.runId)) }],
        tools: [REVISE_TOOL],
        timeoutMs: 45_000,
      });
      addRunTokens(ctx.runId, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
      const call = toolUses(msg).find((b) => b.name === REVISE_TOOL.name);
      const parsed = call ? ReviseSentencesSchema.safeParse(call.input) : null;
      if (parsed?.success) revised = parsed.data.sentences;
    } catch (err) {
      log('error', `Repair round ${rounds} failed: ${short((err as Error).message)}`);
      break;
    }
    const failedIds = new Set(check.failed.map((f) => f.id));
    const replacement = new Map(revised.filter((s) => failedIds.has(s.id)).map((s) => [s.id, s]));
    current = current.map((s) => replacement.get(s.id) ?? s);
    check = checkSentences(current, byKey);
    log('check', `Repair round ${rounds}: ${replacement.size} sentence(s) revised, ${check.failed.length} still unsupported`, {
      failures: check.failed,
    }, Date.now() - t0);
  }

  if (check.failed.length > 0) {
    log('check', `Removed ${check.failed.length} unsupported sentence(s) from the draft`, { removed: check.failed });
  }
  const passedIds = new Set(check.passed.map((s) => s.id));
  return { sentences: current.filter((s) => passedIds.has(s.id)), removed: check.failed, rounds, checked: current.length };
}

function sourceMentions(sources: Source[], token: string): boolean {
  const t = normalizeText(token);
  return sources.some((s) => normalizeText(s.content).includes(t));
}

function finalEvidencePlan(ctx: AgentContext, log: StepLogger, plan: EvidencePlanItem[]): EvidencePlanItem[] {
  const allowed = new Set<string>(allowedEvidenceTypes(ctx.dispute.reason));
  const sources = listSources(ctx.runId);
  const out: EvidencePlanItem[] = [];
  for (const item of plan) {
    if (!allowed.has(item.evidence_type)) {
      log('check', `Evidence plan: dropped ${item.evidence_type}, which PayPal does not accept for ${ctx.dispute.reason}`);
      continue;
    }
    if (item.tracking_number && !sourceMentions(sources, item.tracking_number)) {
      log('check', `Evidence plan: removed tracking number ${item.tracking_number}, which no source contains`);
      out.push({ evidence_type: item.evidence_type, notes: item.notes });
      continue;
    }
    if (!out.some((o) => o.evidence_type === item.evidence_type)) out.push(item);
  }
  return out;
}

export interface RunAgentOptions {
  /** Test seam: supply the model (a scripted fake). Production passes nothing. */
  model?: (ctx: AgentContext) => ModelFn;
}

export async function runAgent(runId: string, opts: RunAgentOptions = {}): Promise<void> {
  const env = getEnv();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const dispute = getLocalDispute(run.dispute_id);
  if (!dispute) throw new Error(`Dispute ${run.dispute_id} not found.`);

  markRunStarted(runId);
  emitStatus(runId, { status: 'running' });
  const log = stepLogger(runId);
  const mock = isAnthropicMock() && !opts.model;
  log('info', `Agent run started for ${dispute.id} (${dispute.reason})`, {
    dispute_id: dispute.id,
    reason: dispute.reason,
    model: run.model_agent,
    source: dispute.source,
  });
  if (mock) log('info', 'ANTHROPIC_MOCK=1: scripted agent, for tests and CI only. Not model output.');

  const ctx = createAgentContext(runId, dispute);
  const model: ModelFn = opts.model ? opts.model(ctx) : mock ? createMockModel(ctx) : createMessage;

  const analysis = await investigate(ctx, model, log);

  // Deterministic numbers: computed in code if the model skipped the tools.
  if (!ctx.strength) {
    runScore(ctx);
    log('check', `Strength computed by the runner (the model did not call score_evidence): ${ctx.strength!.score}/100`, ctx.strength);
  }
  if (!ctx.ev) {
    runExpectedValue(ctx);
    log('check', `Expected value computed by the runner (the model did not call compute_expected_value): ${ctx.ev!.recommended}`, ctx.ev);
  }
  const strength = ctx.strength!;
  const ev = ctx.ev!;
  const recommendation = ev.recommended;
  if (analysis.recommendation !== recommendation) {
    log('check', `The model suggested ${analysis.recommendation}; the expected-value math recommends ${recommendation}, which is what the seller sees`, {
      model_recommendation: analysis.recommendation,
      computed_recommendation: recommendation,
      rationale: analysis.recommendation_rationale,
    });
  }
  if (analysis.classification.reason.toUpperCase() !== dispute.reason.toUpperCase()) {
    log('check', `The model classified the reason as ${analysis.classification.reason}; keeping PayPal's ${dispute.reason}`);
  }

  const evidencePlan = finalEvidencePlan(ctx, log, analysis.evidence_plan);
  const checked = await checkAndRepair(ctx, model, log, analysis.sentences);
  let sentences = checked.sentences;

  let reviewApplied = false;
  if (env.REVIEW_ENABLED && !mock && sentences.length > 0) {
    const t0 = Date.now();
    try {
      const review = await reviewDraft({ model, sentences, sourcesByKey: getSourcesByKey(runId) });
      if (review.status === 'applied') {
        sentences = review.sentences;
        reviewApplied = true;
        log('review', `Review applied by ${env.ANTHROPIC_MODEL_REVIEW}: ${review.changed} sentence(s) reworded, all still grounded`, undefined, Date.now() - t0);
      } else {
        log('review', `Review discarded: ${review.reason} The checked draft is kept.`, review.failures ? { failures: review.failures } : undefined, Date.now() - t0);
      }
    } catch (err) {
      log('review', `Review discarded: ${short((err as Error).message)}. The checked draft is kept.`, undefined, Date.now() - t0);
    }
  } else if (env.REVIEW_ENABLED && mock) {
    log('review', 'Review pass skipped in mock mode');
  }

  const sourcesByKey = getSourcesByKey(runId);
  let buyerMessage: CitedText | undefined;
  if (analysis.buyer_message) {
    const bm = checkSentences([{ id: 'buyer', ...analysis.buyer_message }], sourcesByKey);
    if (bm.failed.length === 0) buyerMessage = analysis.buyer_message;
    else log('check', 'Suggested buyer message removed: it failed the citation check', { failures: bm.failed });
  }

  const removed = checked.removed.map((f) => ({ id: f.id, text: f.text, reason: f.reason, token: f.token ?? null }));
  markRunDraftReady(runId, {
    classification: {
      reason: dispute.reason,
      sub_theme: analysis.classification.sub_theme,
      evidence_needed: analysis.classification.evidence_needed,
      confidence_note: analysis.classification.confidence_note ?? null,
    },
    strength: { score: strength.score, reason_group: strength.reason_group, items: strength.items },
    ev,
    recommendation,
    draft: {
      sentences,
      removed,
      ...(buyerMessage ? { buyer_message: buyerMessage } : {}),
      recommendation_rationale: analysis.recommendation_rationale,
      model_recommendation: analysis.recommendation,
    },
    evidence_plan: evidencePlan,
    review_applied: reviewApplied,
    citation_check: { rounds: checked.rounds, passed: removed.length === 0, checked: checked.checked, failures: removed },
  });
  setDisputeAssessment(dispute.id, { strength_score: strength.score, recommendation });

  const final = getRun(runId);
  log('decision', `Draft ready: ${sentences.length} cited sentence(s), strength ${strength.score}/100, recommendation ${recommendation}`, {
    recommendation,
    strength: strength.score,
    removed: removed.length,
  });
  emitStatus(runId, { status: 'draft_ready', draft_ready_at: final?.draft_ready_at ?? null });
  emitDone(runId);
}
