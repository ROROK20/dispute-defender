import { describe, it, expect } from 'vitest';
import { cliArgs, renderTranscript, toMessage } from '../../src/lib/agent/claude-cli';

describe('claude-cli provider', () => {
  it('runs the CLI with tools, settings, MCP and skills off, and a turn schema', () => {
    const args = cliArgs('claude-sonnet-5-5', 'SYS');
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(at('--tools')).toBe('');
    expect(at('--setting-sources')).toBe('');
    expect(at('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
    expect(at('--model')).toBe('claude-sonnet-5-5');
    expect(at('--output-format')).toBe('json');
    expect(at('--system-prompt').startsWith('SYS')).toBe(true);
    expect(at('--system-prompt')).toContain('RESPONSE PROTOCOL');
    expect(JSON.parse(at('--json-schema')).required).toEqual(['text', 'tool_uses']);
  });

  it('renders tools, calls and results so the next turn can match them by id', () => {
    const text = renderTranscript({
      role: 'agent',
      system: 'sys',
      tools: [{ name: 'get_dispute', description: 'Read a dispute', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'Investigate PP-D-1' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_dispute', input: { id: 'PP-D-1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"status":"OPEN"}' }] },
      ],
    });
    expect(text).toContain('- get_dispute: Read a dispute');
    expect(text).toContain('"properties":{"id":{"type":"string"}}');
    expect(text).toContain('TOOL CALL id=toolu_1 name=get_dispute\n{"id":"PP-D-1"}');
    expect(text).toContain('TOOL RESULT for id=toolu_1\n{"status":"OPEN"}');
    expect(text.indexOf('=== USER ===')).toBeLessThan(text.indexOf('=== ASSISTANT ==='));
  });

  it('marks an error result as an error', () => {
    const text = renderTranscript({
      role: 'agent', system: 's', tools: [],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true }] }],
    });
    expect(text).toContain('TOOL RESULT for id=t9 (ERROR)\nboom');
  });

  it('rebuilds a tool-call turn as an Anthropic message with unique tool ids', () => {
    const msg = toMessage('claude-sonnet-5-5', {
      structured_output: { text: 'Reading both.', tool_uses: [{ name: 'a', input: { x: 1 } }, { name: 'b', input: {} }] },
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    const ids = msg.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    expect(msg.usage.output_tokens).toBe(7);
  });

  it('is an end_turn with no tool calls, and drops nameless calls', () => {
    const msg = toMessage('m', { structured_output: { text: 'Done.', tool_uses: [{ name: '', input: {} }, { input: {} }] } });
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content).toEqual([{ type: 'text', text: 'Done.', citations: null }]);
  });
});
