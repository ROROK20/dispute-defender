import Anthropic from '@anthropic-ai/sdk';
import { getEnv, requireAnthropicKey } from '../env';

/**
 * The one place the app talks to the Anthropic Messages API.
 *
 * Request shape for the current models (claude-sonnet-5-5 agent,
 * claude-opus-5-5 review):
 * - no `temperature`: both models reject non-default sampling values with a 400;
 * - `tool_choice: auto` only: forced `tool`/`any` choice is a 400 on both, so
 *   the terminal tool is steered from the prompt and validated with zod;
 * - `output_config.effort` sets thinking depth (thinking itself is adaptive
 *   and cannot be turned off on these models);
 * - server-side refusal fallback (`fallbacks: "default"`) is on.
 * The SDK pinned here predates the last three fields, so they are sent as
 * extra body fields. If the API rejects one, the request is retried once
 * without them and the extras stay off for the rest of the process.
 */

export type ModelRole = 'agent' | 'review';
export type Effort = 'low' | 'medium' | 'high';

export interface ModelRequest {
  role: ModelRole;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens?: number;
  /** Per-request timeout. The SDK retries once on 429/5xx/connection errors. */
  timeoutMs?: number;
}

/** Same signature for the real API and the scripted mock (ANTHROPIC_MOCK=1). */
export type ModelFn = (req: ModelRequest) => Promise<Anthropic.Message>;

export class ModelRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ''}.`);
    this.name = 'ModelRefusalError';
  }
}

const EFFORT: Record<ModelRole, Effort> = { agent: 'medium', review: 'medium' };
const DEFAULT_MAX_TOKENS: Record<ModelRole, number> = { agent: 16_000, review: 8_000 };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const g = globalThis as unknown as { __ddAnthropic?: Anthropic; __ddAnthropicExtrasOff?: boolean };

function client(): Anthropic {
  if (!g.__ddAnthropic) {
    g.__ddAnthropic = new Anthropic({ apiKey: requireAnthropicKey(), maxRetries: 1 });
  }
  return g.__ddAnthropic;
}

export function modelFor(role: ModelRole): string {
  const env = getEnv();
  return role === 'review' ? env.ANTHROPIC_MODEL_REVIEW : env.ANTHROPIC_MODEL_AGENT;
}

function looksLikeRejectedExtra(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const text = `${err.message} ${JSON.stringify(err.error ?? '')}`.toLowerCase();
  return ['output_config', 'effort', 'fallbacks', 'anthropic-beta', 'beta'].some((k) => text.includes(k));
}

export const createMessage: ModelFn = async (req) => {
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelFor(req.role),
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS[req.role],
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    tool_choice: { type: 'auto' },
  };
  const options = { timeout: req.timeoutMs ?? 60_000 };

  let message: Anthropic.Message;
  if (g.__ddAnthropicExtrasOff) {
    message = await client().messages.create(base, options);
  } else {
    const withExtras = {
      ...base,
      output_config: { effort: EFFORT[req.role] },
      fallbacks: 'default',
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    try {
      message = await client().messages.create(withExtras, { ...options, headers: { 'anthropic-beta': FALLBACK_BETA } });
    } catch (err) {
      if (!looksLikeRejectedExtra(err)) throw err;
      console.warn('[anthropic] optional request fields rejected; retrying without them:', (err as Error).message);
      g.__ddAnthropicExtrasOff = true;
      message = await client().messages.create(base, options);
    }
  }

  if ((message.stop_reason as string) === 'refusal') {
    const details = (message as unknown as { stop_details?: { category?: string | null } }).stop_details;
    throw new ModelRefusalError(details?.category ?? null);
  }
  return message;
};

export function toolUses(message: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
}

export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * The assistant turn exactly as returned, for the next request. Thinking blocks
 * must go back unchanged, so the content is passed through, never rebuilt.
 */
export function assistantTurn(message: Anthropic.Message): Anthropic.MessageParam {
  return { role: 'assistant', content: message.content as unknown as Anthropic.ContentBlockParam[] };
}
