import { describe, expect, it } from 'vitest';
import {
  aggregateToolCalls,
  extractAnthropicJson,
  extractAnthropicStream,
  extractOpenRouterJson,
  extractOpenRouterStream,
  extractToolsOffered,
  parseToolName,
} from '../src/usage/extract.js';

describe('parseToolName', () => {
  it('splits mcp__server__tool convention', () => {
    expect(parseToolName('mcp__github__create_issue')).toEqual({ isMcp: true, mcpServer: 'github' });
    expect(parseToolName('mcp__browser-use__take_snapshot')).toEqual({ isMcp: true, mcpServer: 'browser-use' });
  });

  it('handles tool names containing double underscores after the server part', () => {
    // Greedy tail: first segment is the server, remainder is the tool.
    expect(parseToolName('mcp__srv__do__thing')).toEqual({ isMcp: true, mcpServer: 'srv' });
  });

  it('treats non-mcp names as native tools', () => {
    expect(parseToolName('Bash')).toEqual({ isMcp: false, mcpServer: null });
    expect(parseToolName('str_replace_editor')).toEqual({ isMcp: false, mcpServer: null });
    expect(parseToolName('mcp__incomplete')).toEqual({ isMcp: false, mcpServer: null });
  });
});

describe('aggregateToolCalls', () => {
  it('counts repeated calls per tool', () => {
    const calls = aggregateToolCalls(['Bash', 'mcp__gh__pr_list', 'Bash']);
    expect(calls).toEqual([
      { toolName: 'Bash', isMcp: false, mcpServer: null, callCount: 2 },
      { toolName: 'mcp__gh__pr_list', isMcp: true, mcpServer: 'gh', callCount: 1 },
    ]);
  });
});

describe('extractToolsOffered', () => {
  it('reads Anthropic-style tools', () => {
    expect(extractToolsOffered({ tools: [{ name: 'Bash' }, { name: 'Read' }] })).toEqual(['Bash', 'Read']);
  });

  it('reads OpenAI-style function tools', () => {
    expect(
      extractToolsOffered({ tools: [{ type: 'function', function: { name: 'get_weather' } }] })
    ).toEqual(['get_weather']);
  });

  it('returns empty for missing tools', () => {
    expect(extractToolsOffered({})).toEqual([]);
    expect(extractToolsOffered(null)).toEqual([]);
  });
});

describe('extractAnthropicJson', () => {
  it('extracts usage and tool_use blocks from a non-streaming response', () => {
    const body = {
      id: 'msg_1',
      model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'tu_1', name: 'mcp__github__list_prs', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 2048,
        cache_read_input_tokens: 8192,
      },
    };
    const usage = extractAnthropicJson(body);
    expect(usage.model).toBe('claude-sonnet-4-20250514');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheCreationTokens).toBe(2048);
    expect(usage.cacheReadTokens).toBe(8192);
    expect(usage.toolCalls).toHaveLength(2);
    expect(usage.toolCalls[0]).toMatchObject({ isMcp: true, mcpServer: 'github' });
    expect(usage.parseError).toBe(false);
  });

  it('flags parse errors for junk bodies', () => {
    expect(extractAnthropicJson(null).parseError).toBe(true);
    expect(extractAnthropicJson('nope').parseError).toBe(true);
  });
});

describe('extractAnthropicStream', () => {
  it('combines message_start usage with message_delta final output tokens', () => {
    const events = [
      {
        type: 'message_start',
        message: {
          model: 'claude-opus-4-20250514',
          usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 500, cache_read_input_tokens: 30000 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'mcp__jira__create_ticket' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 321 } },
    ];
    const usage = extractAnthropicStream(events);
    expect(usage.model).toBe('claude-opus-4-20250514');
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(321); // message_delta wins
    expect(usage.cacheCreationTokens).toBe(500);
    expect(usage.cacheReadTokens).toBe(30000);
    expect(usage.toolCalls).toEqual([
      { toolName: 'mcp__jira__create_ticket', isMcp: true, mcpServer: 'jira', callCount: 1 },
    ]);
  });
});

describe('extractOpenRouterJson', () => {
  it('extracts usage, cost, cached tokens, and tool calls', () => {
    const body = {
      model: 'anthropic/claude-sonnet-4',
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_web', arguments: '{}' } }],
          },
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        cost: 0.00123,
        prompt_tokens_details: { cached_tokens: 150 },
      },
    };
    const usage = extractOpenRouterJson(body);
    expect(usage.model).toBe('anthropic/claude-sonnet-4');
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(80);
    expect(usage.cacheReadTokens).toBe(150);
    expect(usage.providerCost).toBe(0.00123);
    expect(usage.toolCalls).toEqual([
      { toolName: 'search_web', isMcp: false, mcpServer: null, callCount: 1 },
    ]);
  });
});

describe('extractOpenRouterStream', () => {
  it('reads usage from the final chunk and names from tool_call deltas', () => {
    const chunks = [
      { model: 'openai/gpt-4o', choices: [{ delta: { role: 'assistant', content: '' } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '' } }] } },
        ],
      },
      // subsequent deltas for the same call carry no name and must not double count
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: {} }] },
      {
        choices: [],
        usage: { prompt_tokens: 55, completion_tokens: 12, cost: 0.0004, prompt_tokens_details: { cached_tokens: 20 } },
      },
    ];
    const usage = extractOpenRouterStream(chunks);
    expect(usage.model).toBe('openai/gpt-4o');
    expect(usage.inputTokens).toBe(55);
    expect(usage.outputTokens).toBe(12);
    expect(usage.cacheReadTokens).toBe(20);
    expect(usage.providerCost).toBe(0.0004);
    expect(usage.toolCalls).toEqual([{ toolName: 'lookup', isMcp: false, mcpServer: null, callCount: 1 }]);
  });
});
