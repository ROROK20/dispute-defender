import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelFn, ModelRequest } from './anthropic';

/**
 * Local development provider: runs the same agent turns through the Claude
 * Code CLI (`claude -p`) on the developer's own machine instead of the
 * Messages API. Selected with ANTHROPIC_PROVIDER=claude-cli. It needs no API
 * key; it uses whatever account the local `claude` CLI is signed in to.
 *
 * This is real model output, not the scripted mock: every turn is one CLI
 * call with tools disabled, settings/MCP/skills skipped, and a JSON schema
 * that returns the turn as `{ text, tool_uses[] }`. The reply is rebuilt as
 * an Anthropic.Message so the runner, the citation checker and the review
 * pass treat it exactly like an API response.
 *
 * Not for hosted deployments: a judge or a server uses ANTHROPIC_API_KEY.
 */

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Prose for this turn; empty when the turn is only tool calls.' },
    tool_uses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['name', 'input'],
      },
    },
  },
  required: ['text', 'tool_uses'],
} as const;

const PROTOCOL = [
  '',
  '---',
  'RESPONSE PROTOCOL (this replaces native tool calling):',
  '- You are one turn of an agent loop. The tools you may call are listed in the user message under "TOOLS", each with its JSON input schema.',
  '- To call tools, put each call in `tool_uses` as {"name", "input"}; the input must satisfy that tool\'s schema. You may call several tools in one turn.',
  '- Tool results come back in later turns as "TOOL RESULT" blocks, matched to calls by id.',
  '- Put any prose for this turn in `text` (it may be empty).',
  '- Reply ONLY through the structured output.',
].join('\n');

function renderBlock(block: Anthropic.ContentBlockParam | Anthropic.ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return `TOOL CALL id=${block.id} name=${block.name}\n${JSON.stringify(block.input)}`;
    case 'tool_result': {
      const body = typeof block.content === 'string'
        ? block.content
        : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      return `TOOL RESULT for id=${block.tool_use_id}${block.is_error ? ' (ERROR)' : ''}\n${body}`;
    }
    default:
      // thinking / redacted_thinking / images: nothing the next turn needs as text.
      return '';
  }
}

export function renderTranscript(req: ModelRequest): string {
  const tools = req.tools
    .map((t) => `- ${t.name}: ${t.description ?? ''}\n  input_schema: ${JSON.stringify(t.input_schema)}`)
    .join('\n');
  const turns = req.messages.map((m) => {
    const body = typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => renderBlock(b as Anthropic.ContentBlockParam)).filter(Boolean).join('\n\n');
    return `=== ${m.role.toUpperCase()} ===\n${body}`;
  });
  return [`TOOLS\n${tools || '(none)'}`, '', 'CONVERSATION SO FAR', ...turns, '', 'Write the next ASSISTANT turn.'].join('\n');
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  structured_output?: { text?: unknown; tool_uses?: unknown };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function toMessage(model: string, out: CliResult): Anthropic.Message {
  const so = out.structured_output ?? {};
  const text = typeof so.text === 'string' ? so.text.trim() : '';
  const calls = Array.isArray(so.tool_uses) ? so.tool_uses : [];
  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  for (const c of calls) {
    const name = (c as { name?: unknown }).name;
    const input = (c as { input?: unknown }).input;
    if (typeof name !== 'string' || !name) continue;
    content.push({
      type: 'tool_use',
      id: `toolu_cli_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name,
      input: input && typeof input === 'object' ? input : {},
    } as Anthropic.ToolUseBlock);
  }
  const hasTool = content.some((b) => b.type === 'tool_use');
  return {
    id: `msg_cli_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: out.usage?.input_tokens ?? 0,
      output_tokens: out.usage?.output_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export function cliArgs(model: string, system: string): string[] {
  return [
    '-p',
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--model', model,
    '--system-prompt', system + PROTOCOL,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(TURN_SCHEMA),
  ];
}

function runCli(args: string[], stdin: string, timeoutMs: number): Promise<string> {
  const bin = process.env.CLAUDE_CLI_PATH || 'claude';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude CLI could not start (${e.message}); is it installed and signed in?`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error(`claude CLI exited ${code}: ${err.trim().slice(0, 400)}`));
      else resolve(out);
    });
    child.stdin.end(stdin);
  });
}

export function createClaudeCliModel(modelFor: (role: ModelRequest['role']) => string): ModelFn {
  return async (req) => {
    const model = modelFor(req.role);
    // A CLI turn carries process start-up on top of the model call.
    const timeoutMs = Math.max(req.timeoutMs ?? 60_000, 240_000);
    const raw = await runCli(cliArgs(model, req.system), renderTranscript(req), timeoutMs);
    let out: CliResult;
    try {
      out = JSON.parse(raw) as CliResult;
    } catch {
      // A usage-limit banner or other plain text, never a model answer.
      throw new Error(`claude CLI returned non-JSON output: ${raw.trim().slice(0, 300)}`);
    }
    if (out.is_error || !out.structured_output) {
      throw new Error(`claude CLI turn failed: ${String(out.result ?? 'no structured output').slice(0, 300)}`);
    }
    return toMessage(model, out);
  };
}
